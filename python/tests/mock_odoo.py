"""A small stand-in for an Odoo server's JSON-2 endpoint, on 127.0.0.1 and an
ephemeral port. It answers the shapes Odoo 19 and 20 document: a bare JSON
result on success, and {name, message, arguments, context, debug} with a 4xx or
5xx on failure. Nothing here talks to a real network."""

from __future__ import annotations

import json
import re
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Callable

KEY = "0123456789abcdef0123456789abcdef01234567"
DATABASE = "example"


def error_body(name: str, message: str, status: int) -> dict[str, Any]:
    return {
        "name": name,
        "message": message,
        "arguments": [message, status],
        "context": {},
        "debug": f"Traceback (most recent call last):\n  ...\n{name}: {message}\n",
    }


class MockOdoo:
    def __init__(self, version: dict[str, Any] | None = None) -> None:
        self.requests: list[dict[str, Any]] = []
        self.multi_database = False
        self.admin = False
        self.version = version or {"version_info": [19, 0, 0, "final", 0, ""], "version": "19.0"}
        self.handle: Callable[[dict[str, Any], BaseHTTPRequestHandler], Any] | None = None
        self.partners = [
            {"id": 1, "name": "Example Ltd", "is_company": True, "email": "hello@example.com", "active": True},
            {"id": 2, "name": "Sample Co", "is_company": True, "email": False, "active": True},
            {"id": 3, "name": "Archived Person", "is_company": False, "email": False, "active": False},
        ]
        self.next_id = 100
        mock = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args: Any) -> None:  # quiet
                pass

            def do_GET(self) -> None:
                mock._dispatch(self, "GET")

            def do_POST(self) -> None:
                mock._dispatch(self, "POST")

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()

    def reset(self) -> None:
        self.requests.clear()
        self.handle = None
        self.multi_database = False
        self.admin = False

    # -- plumbing ----------------------------------------------------

    @staticmethod
    def send(h: BaseHTTPRequestHandler, status: int, value: Any, headers: dict[str, str] | None = None) -> None:
        is_text = isinstance(value, str)
        data = (value if is_text else json.dumps(value)).encode("utf-8")
        h.send_response(status)
        h.send_header("Content-Type", "text/html; charset=utf-8" if is_text else "application/json; charset=utf-8")
        h.send_header("Content-Length", str(len(data)))
        for k, v in (headers or {}).items():
            h.send_header(k, v)
        h.end_headers()
        h.wfile.write(data)

    def _dispatch(self, h: BaseHTTPRequestHandler, verb: str) -> None:
        length = int(h.headers.get("Content-Length") or 0)
        raw = h.rfile.read(length).decode("utf-8") if length else ""
        try:
            body: Any = json.loads(raw) if raw else {}
        except ValueError:
            body = None
        entry = {"method": verb, "path": h.path, "headers": {k.lower(): v for k, v in h.headers.items()}, "raw": raw, "body": body}
        self.requests.append(entry)

        if self.handle:
            out = self.handle(entry, h)
            if out == "handled":
                return
            if out:
                return self.send(h, out["status"], out["body"], out.get("headers"))

        if verb == "GET" and h.path == "/web/version":
            return self.send(h, 200, self.version)
        m = re.fullmatch(r"/json/2/([^/]+)/([^/]+)", h.path)
        if verb != "POST" or not m:
            return self.send(h, 404, "<html><body>Not Found</body></html>")
        if self.multi_database and entry["headers"].get("x-odoo-database") != DATABASE:
            return self.send(
                h, 404, "<!DOCTYPE html><title>404</title><p>No database is selected and the requested URL was not found in the server-wide controllers.</p>"
            )
        auth = re.fullmatch(r"bearer\s+(.+)", entry["headers"].get("authorization", ""), re.IGNORECASE)
        if not auth or auth.group(1) != KEY:
            return self.send(h, 401, error_body("werkzeug.exceptions.Unauthorized", "Invalid apikey", 401), {"WWW-Authenticate": "Bearer"})
        if body is None:
            return self.send(h, 400, error_body("werkzeug.exceptions.BadRequest", "could not parse the body as json", 400))
        return self._rpc(h, m.group(1), m.group(2), body)

    # -- a tiny ORM --------------------------------------------------

    @staticmethod
    def _matches(rec: dict[str, Any], domain: list[Any] | None, context: dict[str, Any] | None) -> bool:
        if (context or {}).get("active_test") is not False and rec.get("active") is False:
            return False
        for leaf in domain or []:
            if not isinstance(leaf, list):
                continue
            field, op, value = leaf
            if op == "=" and rec.get(field) != value:
                return False
            if op == "ilike" and str(value).replace("%", "").lower() not in str(rec.get(field)).lower():
                return False
            if op == "in" and rec.get(field) not in value:
                return False
        return True

    @staticmethod
    def _pick(rec: dict[str, Any], fields: list[str] | None) -> dict[str, Any]:
        if not fields:
            return dict(rec)
        return {"id": rec["id"], **{f: rec.get(f, False) for f in fields}}

    def _rpc(self, h: BaseHTTPRequestHandler, model: str, method: str, body: dict[str, Any]) -> None:
        ids = body.get("ids") or []
        if model == "res.users":
            if method == "context_get":
                return self.send(h, 200, {"lang": "en_GB", "tz": "Europe/London", "uid": 7})
            if method == "has_group":
                return self.send(h, 200, self.admin if body.get("group_ext_id") == "base.group_system" else True)
        if method == "has_access":
            return self.send(h, 200, body.get("operation") != "unlink")
        if model != "res.partner":
            return self.send(h, 404, error_body("werkzeug.exceptions.NotFound", f"the model '{model}' does not exist", 404))
        ctx = body.get("context")
        found = [p for p in self.partners if self._matches(p, body.get("domain"), ctx)]
        if method == "search":
            off = body.get("offset") or 0
            lim = body.get("limit")
            return self.send(h, 200, [p["id"] for p in found[off : off + lim if lim else None]])
        if method == "search_count":
            return self.send(h, 200, len(found))
        if method == "search_read":
            lim = body.get("limit") or len(found)
            return self.send(h, 200, [self._pick(p, body.get("fields")) for p in found[:lim]])
        if method == "read":
            missing = [i for i in ids if not any(p["id"] == i for p in self.partners)]
            if missing:
                return self.send(h, 404, error_body("odoo.exceptions.MissingError", "Record does not exist or has been deleted.", 404))
            return self.send(h, 200, [self._pick(next(p for p in self.partners if p["id"] == i), body.get("fields")) for i in ids])
        if method == "create":
            vals_list = body.get("vals_list")
            if not isinstance(vals_list, list):
                return self.send(h, 422, error_body("werkzeug.exceptions.UnprocessableEntity", "missing a required argument: 'vals_list'", 422))
            if any(not v.get("name") for v in vals_list):
                return self.send(h, 422, error_body("odoo.exceptions.ValidationError", "The partner name is required.", 422))
            new_ids = []
            for v in vals_list:
                rec = {"id": self.next_id, "active": True, **v}
                self.next_id += 1
                self.partners.append(rec)
                new_ids.append(rec["id"])
            return self.send(h, 200, new_ids)
        if method == "write":
            for p in self.partners:
                if p["id"] in ids:
                    p.update(body.get("vals") or {})
            return self.send(h, 200, True)
        if method == "unlink":
            self.partners = [p for p in self.partners if p["id"] not in ids]
            return self.send(h, 200, True)
        if method == "fields_get":
            return self.send(h, 200, {"name": {"type": "char", "string": "Name"}, "email": {"type": "char", "string": "Email"}})
        return self.send(h, 404, error_body("werkzeug.exceptions.NotFound", f"The method '{method}' does not exist", 404))


def stall(seconds: float) -> Callable[[dict[str, Any], BaseHTTPRequestHandler], str]:
    """A handler that sends headers and part of a body, then goes quiet."""

    def handler(_entry: dict[str, Any], h: BaseHTTPRequestHandler) -> str:
        h.send_response(200)
        h.send_header("Content-Type", "application/json")
        h.send_header("Content-Length", "100")
        h.end_headers()
        h.wfile.write(b"[1, 2,")
        h.wfile.flush()
        time.sleep(seconds)
        return "handled"

    return handler


def delay(seconds: float, status: int = 200, body: Any = None) -> Callable[[dict[str, Any], BaseHTTPRequestHandler], dict[str, Any]]:
    def handler(_entry: dict[str, Any], _h: BaseHTTPRequestHandler) -> dict[str, Any]:
        time.sleep(seconds)
        return {"status": status, "body": [] if body is None else body}

    return handler
