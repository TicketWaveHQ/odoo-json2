"""odoo-json2 preflight: prove that a URL, a database and an API key can reach
Odoo's JSON-2 API, with harmless read-only calls only.

    export ODOO_URL=https://odoo.example.com
    export ODOO_DATABASE=example          # only if the server hosts several
    read -rs ODOO_API_KEY && export ODOO_API_KEY
    python -m odoo_json2.preflight [--model res.partner ...]

The key is read from the environment only, never from the command line, where
it would land in shell history and process listings. It is never printed.
Exit code: 0 all checks passed (warnings allowed), 1 a check failed, 2 a usage
error.
"""

from __future__ import annotations

import argparse
import os
import re
import sys
from typing import Any, Sequence

from .client import (
    OdooClient,
    OdooError,
    OdooHTTPError,
    OdooNetworkError,
    OdooTimeoutError,
    __version__,
)

DESCRIPTION = """\
Reads ODOO_URL, ODOO_DATABASE and ODOO_API_KEY from the environment. --url and
--database override the first two. There is no flag for the key, on purpose.

Checks: the URL is https, /web/version answers, the key is accepted
(res.users/context_get), whether the key's user is a Settings administrator,
and, for each --model, which of read, write, create and unlink it may do
(has_access). Nothing is created, changed or deleted.
"""


class _Report:
    def __init__(self, out: Any) -> None:
        self.out = out
        self.failures = 0
        self.colour = bool(getattr(out, "isatty", lambda: False)()) and not os.environ.get("NO_COLOR")

    def _paint(self, code: str, s: str) -> str:
        return f"\x1b[{code}m{s}\x1b[0m" if self.colour else s

    def line(self, s: str = "") -> None:
        print(s, file=self.out, flush=True)

    def passed(self, m: str, extra: str = "") -> None:
        self.line(f"  {self._paint('32', 'PASS')}  {m}" + (f"  {self._paint('2', extra)}" if extra else ""))

    def warn(self, m: str, why: str = "") -> None:
        self.line(f"  {self._paint('33', 'WARN')}  {m}" + (f"\n        {why}" if why else ""))

    def info(self, m: str) -> None:
        self.line(f"  {self._paint('2', 'INFO')}  {m}")

    def fail(self, m: str, why: str = "") -> None:
        self.failures += 1
        self.line(f"  {self._paint('31', 'FAIL')}  {m}" + (f"\n        {why}" if why else ""))


def explain(err: BaseException) -> str:
    """Explain a failed call. Odoo's message is shown, truncated; its traceback never is."""
    if isinstance(err, OdooHTTPError):
        message = err.payload.get("message") if err.payload else None
        msg = f": {str(message)[:300]}" if message else ""
        head = f"HTTP {err.status}{' ' + err.exception if err.exception else ''}{msg}"
        if 300 <= err.status < 400:
            where = f" to {err.location}" if err.location else ""
            return f"{head}. The URL redirects{where}. Use the final URL: redirects are not followed, so that the key is never re-sent."
        if err.status == 401:
            return f"{head}. Odoo refused the key: check that it is a current API key (not a password) for a user of this database. Keys expire."
        if err.status == 404:
            return (
                f"{head}. No JSON-2 endpoint answered: the server may be older than Odoo 19, the URL may have the wrong path, "
                "or no database was selected (set ODOO_DATABASE when the server hosts several)."
            )
        return head
    if isinstance(err, OdooTimeoutError):
        return "timed out"
    if isinstance(err, OdooNetworkError):
        cause = err.__cause__
        reason = getattr(cause, "reason", None) or cause
        return f"network error: {reason}" if reason else "network error"
    return str(err)


def _major(v: dict[str, Any]) -> int | None:
    info = v.get("version_info")
    first = info[0] if isinstance(info, list) and info else v.get("version")
    m = re.search(r"(\d+)", str(first or ""))
    return int(m.group(1)) if m else None


class _Parser(argparse.ArgumentParser):
    def error(self, message: str) -> None:  # type: ignore[override]
        self.print_usage(sys.stdout)
        print(f"odoo-json2-preflight: {message}", file=sys.stdout)
        raise SystemExit(2)


def main(argv: Sequence[str] | None = None, out: Any = None) -> int:
    out = out or sys.stdout
    parser = _Parser(prog="odoo-json2-preflight", description=DESCRIPTION, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--url", help="overrides ODOO_URL")
    parser.add_argument("--database", help="overrides ODOO_DATABASE")
    parser.add_argument("--model", action="append", default=[], help="a model to check access rights on; repeatable")
    parser.add_argument("--timeout", type=float, default=15.0, help="seconds per call (default 15)")
    raw = list(sys.argv[1:] if argv is None else argv)
    for a in raw:
        if a.split("=", 1)[0] in ("--key", "--api-key"):
            print(f"odoo-json2-preflight: {a.split('=', 1)[0]} is not accepted: put the key in ODOO_API_KEY (read -rs ODOO_API_KEY)", file=out)
            return 2
    try:
        args = parser.parse_args(raw)
    except SystemExit as e:
        return int(e.code or 0)
    if not args.timeout > 0:
        print("odoo-json2-preflight: --timeout must be a positive number of seconds", file=out)
        return 2

    r = _Report(out)
    r.line(f"\nodoo-json2 preflight {__version__} (Python)\n")
    r.line("Configuration")
    url = (args.url if args.url is not None else os.environ.get("ODOO_URL", "")).strip()
    database = (args.database if args.database is not None else os.environ.get("ODOO_DATABASE", "")).strip()
    key = os.environ.get("ODOO_API_KEY", "").strip()
    missing = [name for name, value in (("ODOO_URL", url), ("ODOO_API_KEY", key)) if not value]
    if missing:
        r.fail(f"missing: {', '.join(missing)}", "Set them in the environment. Read the key with: read -rs ODOO_API_KEY && export ODOO_API_KEY")
        return 1
    r.passed("URL and key present")
    if not re.fullmatch(r"[0-9a-f]{40}(?:_oak)?", key):
        r.warn(
            "the key does not look like one Odoo generated",
            'Odoo 19 generates 40 hexadecimal characters, and Odoo 20 adds "_oak". Make sure it is an API key, not a password.',
        )
    if database:
        r.info(f"database: {database} (sent as X-Odoo-Database)")
    else:
        r.info("no ODOO_DATABASE: the server must choose the database from the host name")

    try:
        client = OdooClient(url, key, database=database or None, timeout=args.timeout)
    except OdooError as e:
        r.fail("the client refused the configuration", str(e))
        return 1
    if client.url.startswith("https://"):
        r.passed("URL is https", client.url)
    else:
        r.warn("URL is plain http to a loopback address", "Fine for a local test server, never for a real one.")

    r.line("\nServer")
    try:
        v = client.version()
    except OdooError as e:
        r.fail("could not reach /web/version", explain(e))
        r.line("\nCheck ODOO_URL. Everything below depends on it.\n")
        return 1
    r.passed("reached /web/version", f"server {v.get('version', 'unknown')}")
    major = _major(v)
    if major is not None and major < 19:
        r.warn(f"server reports Odoo {major}", "Odoo documents the JSON-2 API from 19.0. On an older server use its XML-RPC or JSON-RPC API instead.")

    r.line("\nThe key")
    try:
        ctx = client.context_get()
    except OdooError as e:
        r.fail("the key was not accepted", explain(e))
        r.line()
        return 1
    uid = ctx["uid"]
    extra = ", ".join(x for x in (f"user id {uid}", f"lang {ctx['lang']}" if ctx.get("lang") else "", f"tz {ctx['tz']}" if ctx.get("tz") else "") if x)
    r.passed("the key is accepted (res.users/context_get)", extra)

    try:
        admin = client.call("res.users", "has_group", {"group_ext_id": "base.group_system"}, ids=[uid])
        if admin is True:
            r.warn("the key's user is a Settings administrator", "Give each integration its own user with only the access it needs. See SECURITY.md.")
        else:
            r.passed("the key's user is not a Settings administrator")
    except OdooError as e:
        r.info(f"could not check administrator rights: {explain(e)}")

    if args.model:
        r.line("\nAccess rights (has_access, model level)")
    for model in args.model:
        seen = []
        try:
            for operation in ("read", "write", "create", "unlink"):
                ok = client.call(model, "has_access", {"operation": operation})
                seen.append(f"{operation} {'yes' if ok is True else 'no'}")
        except (OdooError, TypeError) as e:
            r.fail(f"{model}: could not check {operation}", explain(e))
            continue
        r.info(f"{model}: {', '.join(seen)}")

    r.line()
    if r.failures == 0:
        r.line(f"{r._paint('32', 'All checks passed.')} Read any warnings above.\n")
        return 0
    plural = "" if r.failures == 1 else "s"
    r.line(f"{r._paint('31', f'{r.failures} check{plural} failed.')}\n")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
