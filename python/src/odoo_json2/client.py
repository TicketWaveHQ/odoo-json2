"""A small client for Odoo's External JSON-2 API, on the standard library only.

The API, as documented for Odoo 19.0 and 20.0 ("External JSON-2 API")::

    POST <base>/json/2/<model>/<method>
    Authorization: bearer <API key>
    X-Odoo-Database: <database>          (only where the host does not pick one)
    Content-Type: application/json; charset=utf-8

    {"ids": [...], "context": {...}, "<argument>": <value>, ...}

Every argument is named; there are no positional arguments. A success is a 200
whose body is the method's return value as JSON (a recordset comes back as its
list of ids). A failure is a 4xx or 5xx whose body is
``{name, message, arguments, context, debug}``, where ``name`` is the Python
exception's qualified name and ``debug`` is a server traceback.

Every call is its own database transaction on the server.
"""

from __future__ import annotations

import http.client
import json
import os
import re
import ssl
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Iterable, Mapping, Sequence

__version__ = "0.1.0"

#: Methods treated as read-only, so that ``retries`` applies to them. Chosen by
#: name, not by inspecting the server: a custom module can override one of
#: these to write. For such a model, pass ``idempotent=False``.
READ_ONLY_METHODS = frozenset(
    {
        "check_access",
        "context_get",
        "default_get",
        "fields_get",
        "has_access",
        "has_group",
        "name_search",
        "read",
        "read_group",
        "search",
        "search_count",
        "search_fetch",
        "search_read",
    }
)

_RETRY_STATUSES = frozenset({429, 502, 503, 504})
_MODEL_RE = re.compile(r"[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*\Z")
_METHOD_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_]*\Z")
_EXCEPTION_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*\Z")
_CONTROL_RE = re.compile(r"[\x00-\x1f\x7f]")
_LOOPBACK_RE = re.compile(r"127\.\d{1,3}\.\d{1,3}\.\d{1,3}\Z")
_BODY_EXCERPT = 2000
_CHUNK = 65536


# -- Errors --------------------------------------------------------------


class OdooError(Exception):
    """Base class of everything this client raises, apart from TypeError and
    ValueError for invalid arguments."""

    def __init__(self, message: str, *, model: str | None = None, method: str | None = None) -> None:
        super().__init__(message)
        self.model = model
        self.method = method


class OdooConfigError(OdooError, ValueError):
    """The client was constructed with options it refuses (bad URL, plain http)."""


class OdooHTTPError(OdooError):
    """Odoo answered with a status other than 2xx, or with a redirect, which is
    never followed.

    ``str(error)`` never contains Odoo's own message text, which can quote the
    values sent. ``payload`` holds Odoo's error object when there was one, and
    ``body`` the start of a body that was not one.
    """

    def __init__(
        self,
        status: int,
        *,
        model: str | None = None,
        method: str | None = None,
        payload: dict[str, Any] | None = None,
        body: str | None = None,
        location: str | None = None,
    ) -> None:
        name = payload.get("name") if payload else None
        exception = name if isinstance(name, str) and len(name) <= 200 and _EXCEPTION_RE.match(name) else None
        target = f"{model}/{method}" if model and method else "request"
        if 300 <= status < 400:
            what = f"redirect to {location}, not followed" if location else "redirect, not followed"
        else:
            what = exception or "no Odoo error payload"
        super().__init__(f"Odoo {target}: HTTP {status} {what}", model=model, method=method)
        self.status = status
        self.exception = exception
        self.location = location
        self.payload = payload
        self.body = body

    @property
    def exception_name(self) -> str | None:
        """The exception's class name without its module, e.g. ``AccessError``."""
        return self.exception.rsplit(".", 1)[-1] if self.exception else None

    def __repr__(self) -> str:
        return f"{type(self).__name__}({self.status}, exception={self.exception!r})"


class OdooTimeoutError(OdooError):
    """The call took longer than its timeout."""


class OdooNetworkError(OdooError):
    """The request failed below HTTP: DNS, TLS, refused connection, reset.
    ``__cause__`` is the underlying error."""


class OdooResponseError(OdooError):
    """A 2xx whose body was not JSON, or a helper got a result of the wrong shape."""

    def __init__(self, message: str, status: int, *, model: str | None = None, method: str | None = None, body: str | None = None) -> None:
        super().__init__(message, model=model, method=method)
        self.status = status
        self.body = body

    def __repr__(self) -> str:
        return f"{type(self).__name__}({str(self)!r}, status={self.status})"


# -- Helpers -------------------------------------------------------------


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    # urllib would follow a redirect and copy the Authorization header to the
    # new host. Returning None makes it raise HTTPError for the 3xx instead.
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # type: ignore[override]
        return None


def _is_loopback(hostname: str) -> bool:
    return hostname in ("localhost", "::1") or bool(_LOOPBACK_RE.match(hostname))


def _check_ids(ids: Any, where: str) -> list[int]:
    if isinstance(ids, (str, bytes)) or not isinstance(ids, Iterable):
        raise TypeError(f"{where}: ids must be a list of positive integers")
    out = list(ids)
    if not all(isinstance(i, int) and not isinstance(i, bool) and i > 0 for i in out):
        raise TypeError(f"{where}: ids must be a list of positive integers")
    return out


def _error_payload(value: Any) -> dict[str, Any] | None:
    if not isinstance(value, dict) or not isinstance(value.get("name"), str):
        return None
    keep = {"name": value["name"]}
    for key in ("message", "arguments", "context", "debug"):
        if key in value:
            keep[key] = value[key]
    return keep


def _retryable(err: BaseException) -> bool:
    if isinstance(err, (OdooNetworkError, OdooTimeoutError)):
        return True
    return isinstance(err, OdooHTTPError) and err.status in _RETRY_STATUSES


# -- Client --------------------------------------------------------------


class OdooClient:
    """A JSON-2 client for one Odoo server, database and API key.

    :param url: the server's base URL, e.g. ``https://odoo.example.com``.
        https only, unless loopback or ``allow_insecure_http``.
    :param api_key: an API key for the user the integration acts as. Never a password.
    :param database: sent as ``X-Odoo-Database``; needed only where one server
        hosts several databases.
    :param timeout: seconds. Limits each socket operation, and the body is
        checked against the same deadline between reads. The status line and
        headers are not, so a server that trickles bytes can take longer.
    :param context: merged into every call's context; a call's own context wins.
    :param retries: extra attempts after a network error, a timeout, or HTTP 429,
        502, 503 or 504. Applied only to read-only methods or to calls made with
        ``idempotent=True``. Default 0.
    :param retry_delay: base delay in seconds between attempts, doubled each time.
    :param ssl_context: for a private certificate authority.
    :param opener: a ``urllib.request.OpenerDirector`` to use instead of the
        default one. It must not follow redirects.
    """

    def __init__(
        self,
        url: str,
        api_key: str,
        *,
        database: str | None = None,
        timeout: float = 30.0,
        user_agent: str | None = None,
        context: Mapping[str, Any] | None = None,
        retries: int = 0,
        retry_delay: float = 0.5,
        allow_insecure_http: bool = False,
        ssl_context: ssl.SSLContext | None = None,
        opener: urllib.request.OpenerDirector | None = None,
    ) -> None:
        parts = urllib.parse.urlsplit(str(url or "").strip())
        if parts.scheme not in ("https", "http") or not parts.hostname:
            raise OdooConfigError("url must be an absolute https URL")
        if parts.scheme == "http" and not _is_loopback(parts.hostname) and not allow_insecure_http:
            raise OdooConfigError("url must be https: the API key travels in a header (allow_insecure_http overrides)")
        if parts.username or parts.password:
            raise OdooConfigError("url must not carry credentials")
        if parts.query or parts.fragment:
            raise OdooConfigError("url must not carry a query or fragment")
        self.url = f"{parts.scheme}://{parts.netloc}{parts.path.rstrip('/')}"

        key = api_key.strip() if isinstance(api_key, str) else ""
        if not key:
            raise OdooConfigError("api_key is required")
        if re.search(r"\s", key) or _CONTROL_RE.search(key):
            raise OdooConfigError("api_key must not contain spaces or control characters")
        self.__api_key = key

        db = str(database).strip() if database is not None else ""
        if _CONTROL_RE.search(db):
            raise OdooConfigError("database must not contain control characters")
        self.database = db or None

        if not timeout > 0:
            raise OdooConfigError("timeout must be positive")
        if not isinstance(retries, int) or retries < 0:
            raise OdooConfigError("retries must be a whole number")
        if retry_delay < 0:
            raise OdooConfigError("retry_delay must not be negative")
        self.timeout = float(timeout)
        self.retries = retries
        self.retry_delay = float(retry_delay)
        self.user_agent = user_agent or f"odoo-json2/{__version__} (Python)"
        if _CONTROL_RE.search(self.user_agent):
            raise OdooConfigError("user_agent must not contain control characters")
        self._context = dict(context or {})

        if opener is None:
            handlers: list[urllib.request.BaseHandler] = [_NoRedirect()]
            if ssl_context is not None:
                handlers.append(urllib.request.HTTPSHandler(context=ssl_context))
            opener = urllib.request.build_opener(*handlers)
        self._opener = opener

    def __repr__(self) -> str:
        # Never show the key.
        return f"OdooClient(url={self.url!r}, database={self.database!r})"

    # -- Any method ----------------------------------------------------

    def call(
        self,
        model: str,
        method: str,
        params: Mapping[str, Any] | None = None,
        *,
        ids: Sequence[int] | None = None,
        context: Mapping[str, Any] | None = None,
        timeout: float | None = None,
        idempotent: bool | None = None,
    ) -> Any:
        """Call any public model method: ``POST /json/2/<model>/<method>``.

        ``params`` holds the method's named arguments. ``ids`` is the records
        to call a record method on, and ``context`` is merged over the
        client's. Returns the method's return value, decoded from JSON.
        """
        if not isinstance(model, str) or not _MODEL_RE.match(model):
            raise TypeError(f"invalid model name: {model!r}")
        if not isinstance(method, str) or not _METHOD_RE.match(method):
            raise TypeError(f"invalid method name: {method!r}")
        if params is not None and not isinstance(params, Mapping):
            raise TypeError("params must be a mapping of named arguments")

        body: dict[str, Any] = dict(params or {})
        if ids is not None:
            body["ids"] = ids
        if "ids" in body:
            body["ids"] = _check_ids(body["ids"], f"{model}/{method}")
        own = body.pop("context", None) or {}
        if not isinstance(own, Mapping) or (context is not None and not isinstance(context, Mapping)):
            raise TypeError("context must be a mapping")
        merged = {**self._context, **own, **(context or {})}
        if merged:
            body["context"] = merged

        headers = {
            "Authorization": f"bearer {self.__api_key}",
            "Content-Type": "application/json; charset=utf-8",
            "Accept": "application/json",
            "User-Agent": self.user_agent,
        }
        if self.database:
            headers["X-Odoo-Database"] = self.database
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")

        retryable = idempotent if idempotent is not None else method in READ_ONLY_METHODS
        url = f"{self.url}/json/2/{model}/{method}"
        return self._with_retries(retryable, lambda: self._send(url, data, headers, model, method, timeout))

    # -- Common calls --------------------------------------------------

    def search_read(
        self,
        model: str,
        domain: Sequence[Any] | None = None,
        fields: Sequence[str] | None = None,
        *,
        offset: int | None = None,
        limit: int | None = None,
        order: str | None = None,
        context: Mapping[str, Any] | None = None,
        timeout: float | None = None,
        **extra: Any,
    ) -> list[dict[str, Any]]:
        """search_read: search, then read, in one transaction."""
        params: dict[str, Any] = {"domain": list(domain or []), **extra}
        if fields is not None:
            params["fields"] = list(fields)
        _put(params, offset=offset, limit=limit, order=order)
        return self.call(model, "search_read", params, context=context, timeout=timeout)

    def search(
        self,
        model: str,
        domain: Sequence[Any] | None = None,
        *,
        offset: int | None = None,
        limit: int | None = None,
        order: str | None = None,
        context: Mapping[str, Any] | None = None,
        timeout: float | None = None,
    ) -> list[int]:
        """search: ids of the matching records."""
        params: dict[str, Any] = {"domain": list(domain or [])}
        _put(params, offset=offset, limit=limit, order=order)
        return self._ids(self.call(model, "search", params, context=context, timeout=timeout), model, "search")

    def search_count(
        self,
        model: str,
        domain: Sequence[Any] | None = None,
        *,
        limit: int | None = None,
        context: Mapping[str, Any] | None = None,
        timeout: float | None = None,
    ) -> int:
        """search_count: the number of matching records."""
        params: dict[str, Any] = {"domain": list(domain or [])}
        _put(params, limit=limit)
        r = self.call(model, "search_count", params, context=context, timeout=timeout)
        if not isinstance(r, int) or isinstance(r, bool):
            raise OdooResponseError("search_count did not return a whole number", 200, model=model, method="search_count")
        return r

    def read(
        self,
        model: str,
        ids: Sequence[int],
        fields: Sequence[str] | None = None,
        *,
        context: Mapping[str, Any] | None = None,
        timeout: float | None = None,
        **extra: Any,
    ) -> list[dict[str, Any]]:
        """read: the given records' fields (all fields when ``fields`` is None)."""
        params: dict[str, Any] = dict(extra)
        if fields is not None:
            params["fields"] = list(fields)
        return self.call(model, "read", params, ids=_check_ids(ids, f"{model}/read"), context=context, timeout=timeout)

    def create(
        self,
        model: str,
        values: Mapping[str, Any] | Sequence[Mapping[str, Any]],
        *,
        context: Mapping[str, Any] | None = None,
        timeout: float | None = None,
        idempotent: bool | None = None,
    ) -> list[int]:
        """create: one record or several. Always returns the list of new ids."""
        vals_list = [values] if isinstance(values, Mapping) else list(values)
        if not vals_list or not all(isinstance(v, Mapping) for v in vals_list):
            raise TypeError(f"{model}/create: values must be a mapping or a non-empty list of mappings")
        r = self.call(model, "create", {"vals_list": [dict(v) for v in vals_list]}, context=context, timeout=timeout, idempotent=idempotent)
        return self._ids(r, model, "create")

    def write(
        self,
        model: str,
        ids: Sequence[int],
        values: Mapping[str, Any],
        *,
        context: Mapping[str, Any] | None = None,
        timeout: float | None = None,
        idempotent: bool | None = None,
    ) -> bool:
        """write: the same values on every given record. Returns True."""
        if not isinstance(values, Mapping):
            raise TypeError(f"{model}/write: values must be a mapping")
        return self.call(
            model, "write", {"vals": dict(values)}, ids=_check_ids(ids, f"{model}/write"), context=context, timeout=timeout, idempotent=idempotent
        )

    def unlink(
        self,
        model: str,
        ids: Sequence[int],
        *,
        context: Mapping[str, Any] | None = None,
        timeout: float | None = None,
        idempotent: bool | None = None,
    ) -> bool:
        """unlink: delete the given records, all or none. Returns True."""
        return self.call(model, "unlink", None, ids=_check_ids(ids, f"{model}/unlink"), context=context, timeout=timeout, idempotent=idempotent)

    def fields_get(
        self,
        model: str,
        allfields: Sequence[str] | None = None,
        attributes: Sequence[str] | None = None,
        *,
        context: Mapping[str, Any] | None = None,
        timeout: float | None = None,
    ) -> dict[str, dict[str, Any]]:
        """fields_get: the model's field definitions, keyed by field name."""
        params: dict[str, Any] = {}
        if allfields is not None:
            params["allfields"] = list(allfields)
        if attributes is not None:
            params["attributes"] = list(attributes)
        return self.call(model, "fields_get", params, context=context, timeout=timeout)

    def context_get(self, *, timeout: float | None = None) -> dict[str, Any]:
        """res.users/context_get: the key's own user. The documented way to learn
        the user id under JSON-2. Odoo 19 and 20 return ``uid``, ``lang`` and ``tz``."""
        r = self.call("res.users", "context_get", timeout=timeout)
        if not isinstance(r, dict) or not isinstance(r.get("uid"), int):
            raise OdooResponseError("context_get did not return a user id", 200, model="res.users", method="context_get")
        return r

    def version(self, *, timeout: float | None = None) -> dict[str, Any]:
        """GET /web/version, which needs no key. The key is not sent."""
        headers = {"Accept": "application/json", "User-Agent": self.user_agent}
        return self._with_retries(True, lambda: self._send(f"{self.url}/web/version", None, headers, None, None, timeout))

    # -- Transport -----------------------------------------------------

    @staticmethod
    def _ids(r: Any, model: str, method: str) -> list[int]:
        if not isinstance(r, list) or not all(isinstance(i, int) and not isinstance(i, bool) for i in r):
            raise OdooResponseError(f"{method} did not return a list of ids", 200, model=model, method=method)
        return r

    def _with_retries(self, retryable: bool, attempt: Any) -> Any:
        n = 0
        while True:
            try:
                return attempt()
            except OdooError as err:
                if not retryable or n >= self.retries or not _retryable(err):
                    raise
                time.sleep(self.retry_delay * (2**n))
                n += 1

    def _send(
        self,
        url: str,
        data: bytes | None,
        headers: dict[str, str],
        model: str | None,
        method: str | None,
        timeout: float | None,
    ) -> Any:
        where = {"model": model, "method": method}
        limit = self.timeout if timeout is None else float(timeout)
        deadline = time.monotonic() + limit
        req = urllib.request.Request(url, data=data, headers=headers, method="POST" if data is not None else "GET")

        def read_all(fp: Any) -> str:
            chunks = []
            while True:
                chunk = fp.read(_CHUNK)
                if not chunk:
                    break
                chunks.append(chunk)
                if time.monotonic() > deadline:
                    raise TimeoutError("deadline passed while reading the body")
            return b"".join(chunks).decode("utf-8", "replace")

        try:
            try:
                with self._opener.open(req, timeout=limit) as resp:
                    status = resp.status
                    text = read_all(resp)
            except urllib.error.HTTPError as err:
                status = err.code
                try:
                    if 300 <= status < 400:
                        raise OdooHTTPError(status, location=err.headers.get("Location"), **where) from None
                    text = read_all(err)
                finally:
                    err.close()
                try:
                    parsed = json.loads(text)
                except ValueError:
                    parsed = None
                payload = _error_payload(parsed)
                if payload is not None:
                    raise OdooHTTPError(status, payload=payload, **where) from None
                # not JSON: a proxy's page, or Odoo's "no database selected" page
                raise OdooHTTPError(status, body=text[:_BODY_EXCERPT], **where) from None
        except OdooError:
            raise
        except urllib.error.URLError as err:
            if isinstance(err.reason, TimeoutError):
                raise OdooTimeoutError(f"timed out after {limit:g} s", **where) from err
            raise OdooNetworkError(f"network error: {err.reason}", **where) from err
        except TimeoutError as err:
            raise OdooTimeoutError(f"timed out after {limit:g} s", **where) from err
        except (OSError, http.client.HTTPException) as err:
            raise OdooNetworkError(f"network error: {type(err).__name__}", **where) from err

        try:
            return json.loads(text)
        except ValueError:
            raise OdooResponseError("the response was not JSON", status, body=text[:_BODY_EXCERPT], **where) from None


def _put(params: dict[str, Any], **values: Any) -> None:
    for key, value in values.items():
        if value is not None:
            params[key] = value


def client_from_env(env: Mapping[str, str] | None = None, **options: Any) -> OdooClient | None:
    """Build a client from ODOO_URL, ODOO_API_KEY and, optionally, ODOO_DATABASE.

    Returns None when ODOO_URL or ODOO_API_KEY is missing, so an integration
    can stay off until it is configured.
    """
    env = os.environ if env is None else env
    url = (env.get("ODOO_URL") or "").strip()
    key = (env.get("ODOO_API_KEY") or "").strip()
    database = (env.get("ODOO_DATABASE") or "").strip() or None
    if not url or not key:
        return None
    return OdooClient(url, key, database=database, **options)
