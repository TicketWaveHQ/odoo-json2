"""The Python client against the mock Odoo on 127.0.0.1."""

from __future__ import annotations

import socket
import sys
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from mock_odoo import DATABASE, KEY, MockOdoo, delay, stall  # noqa: E402

from odoo_json2 import (  # noqa: E402
    READ_ONLY_METHODS,
    OdooClient,
    OdooConfigError,
    OdooHTTPError,
    OdooNetworkError,
    OdooResponseError,
    OdooTimeoutError,
    __version__,
    client_from_env,
)


class ClientTests(unittest.TestCase):
    odoo: MockOdoo

    @classmethod
    def setUpClass(cls) -> None:
        cls.odoo = MockOdoo()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.odoo.close()

    def setUp(self) -> None:
        self.odoo.reset()

    def client(self, **extra) -> OdooClient:
        return OdooClient(self.odoo.url, KEY, **extra)

    def last(self) -> dict:
        return self.odoo.requests[-1]

    # -- Request shape -----------------------------------------------

    def test_request_shape(self) -> None:
        self.client(database=DATABASE).call(
            "res.partner", "search_read", {"domain": [["is_company", "=", True]], "fields": ["name"], "limit": 5}
        )
        r = self.last()
        self.assertEqual(r["method"], "POST")
        self.assertEqual(r["path"], "/json/2/res.partner/search_read")
        self.assertEqual(r["headers"]["authorization"], f"bearer {KEY}")
        self.assertEqual(r["headers"]["x-odoo-database"], DATABASE)
        self.assertEqual(r["headers"]["content-type"], "application/json; charset=utf-8")
        self.assertEqual(r["headers"]["accept"], "application/json")
        self.assertEqual(r["headers"]["user-agent"], f"odoo-json2/{__version__} (Python)")
        self.assertEqual(r["body"], {"domain": [["is_company", "=", True]], "fields": ["name"], "limit": 5})

    def test_no_database_header_ids_or_context_unless_given(self) -> None:
        self.client().call("res.users", "context_get")
        self.assertNotIn("x-odoo-database", self.last()["headers"])
        self.assertEqual(self.last()["body"], {})

    def test_context_merge(self) -> None:
        c = self.client(context={"lang": "en_GB", "tz": "Europe/London"})
        c.search_read("res.partner", fields=["name"], context={"lang": "fr_FR", "active_test": False})
        self.assertEqual(self.last()["body"]["context"], {"lang": "fr_FR", "tz": "Europe/London", "active_test": False})

    def test_url_prefix_and_trailing_slash(self) -> None:
        self.assertEqual(OdooClient("https://odoo.example.com/odoo/", KEY).url, "https://odoo.example.com/odoo")

    def test_non_ascii_is_sent_as_utf8(self) -> None:
        [new_id] = self.client().create("res.partner", {"name": "Café Ŵales"})
        self.assertEqual(self.last()["body"]["vals_list"][0]["name"], "Café Ŵales")
        self.assertEqual(self.client().read("res.partner", [new_id], ["name"])[0]["name"], "Café Ŵales")

    # -- Helpers -----------------------------------------------------

    def test_search_read_and_read(self) -> None:
        c = self.client()
        rows = c.search_read("res.partner", [["is_company", "=", True]], ["name"])
        self.assertEqual(rows, [{"id": 1, "name": "Example Ltd"}, {"id": 2, "name": "Sample Co"}])
        self.assertEqual(c.read("res.partner", [1], ["email"]), [{"id": 1, "email": "hello@example.com"}])
        self.assertEqual(self.last()["body"], {"fields": ["email"], "ids": [1]})

    def test_search_and_count(self) -> None:
        c = self.client()
        self.assertEqual(c.search("res.partner", [["is_company", "=", True]]), [1, 2])
        self.assertEqual(c.search("res.partner", [["is_company", "=", True]], limit=1), [1])
        self.assertEqual(self.last()["body"], {"domain": [["is_company", "=", True]], "limit": 1})
        self.assertEqual(c.search("res.partner", [["name", "=", "Archived Person"]], context={"active_test": False}), [3])
        self.assertEqual(c.search_count("res.partner", [["is_company", "=", True]]), 2)

    def test_create_write_unlink(self) -> None:
        c = self.client()
        [new_id] = c.create("res.partner", {"name": "New Ltd"})
        self.assertEqual(self.last()["body"], {"vals_list": [{"name": "New Ltd"}]})
        self.assertEqual(len(c.create("res.partner", [{"name": "A"}, {"name": "B"}])), 2)
        self.assertIs(c.write("res.partner", [new_id], {"email": "new@example.com"}), True)
        self.assertEqual(self.last()["body"], {"ids": [new_id], "vals": {"email": "new@example.com"}})
        self.assertIs(c.unlink("res.partner", [new_id]), True)
        self.assertEqual(self.last()["body"], {"ids": [new_id]})

    def test_fields_get_context_get_version(self) -> None:
        c = self.client(database=DATABASE)
        self.assertEqual(c.fields_get("res.partner", ["name"], ["type"])["name"]["type"], "char")
        self.assertEqual(self.last()["body"], {"allfields": ["name"], "attributes": ["type"]})
        self.assertEqual(c.context_get()["uid"], 7)
        self.assertEqual(c.version()["version"], "19.0")
        self.assertEqual(self.last()["method"], "GET")
        self.assertNotIn("authorization", self.last()["headers"])

    def test_bad_arguments_send_nothing(self) -> None:
        c = self.client()
        with self.assertRaises(TypeError):
            c.call("res.partner/../x", "read")
        with self.assertRaises(TypeError):
            c.call("res.partner", "read?x=1")
        with self.assertRaises(TypeError):
            c.read("res.partner", ["1"])  # type: ignore[list-item]
        with self.assertRaises(TypeError):
            c.unlink("res.partner", [0])
        with self.assertRaises(TypeError):
            c.unlink("res.partner", [True])  # type: ignore[list-item]
        with self.assertRaises(TypeError):
            c.create("res.partner", [])
        self.assertEqual(self.odoo.requests, [])

    # -- Errors ------------------------------------------------------

    def test_refused_key(self) -> None:
        bad = "f" * 40
        with self.assertRaises(OdooHTTPError) as cm:
            OdooClient(self.odoo.url, bad).context_get()
        e = cm.exception
        self.assertEqual(e.status, 401)
        self.assertEqual(e.exception, "werkzeug.exceptions.Unauthorized")
        self.assertEqual(e.exception_name, "Unauthorized")
        self.assertEqual(e.payload["message"], "Invalid apikey")
        self.assertIn("Traceback", e.payload["debug"])
        self.assertEqual((e.model, e.method), ("res.users", "context_get"))
        self.assertNotIn("Invalid apikey", str(e))
        self.assertNotIn(bad, str(e) + repr(e))

    def test_odoo_exceptions_keep_class_and_status(self) -> None:
        c = self.client()
        with self.assertRaises(OdooHTTPError) as v:
            c.create("res.partner", {"email": "x@example.com"})
        self.assertEqual((v.exception.status, v.exception.exception_name), (422, "ValidationError"))
        with self.assertRaises(OdooHTTPError) as m:
            c.read("res.partner", [999])
        self.assertEqual((m.exception.status, m.exception.exception), (404, "odoo.exceptions.MissingError"))
        with self.assertRaises(OdooHTTPError) as n:
            c.search_read("no.such.model")
        self.assertEqual((n.exception.status, n.exception.exception), (404, "werkzeug.exceptions.NotFound"))

    def test_access_error(self) -> None:
        self.odoo.handle = lambda e, h: {
            "status": 403,
            "body": {"name": "odoo.exceptions.AccessError", "message": "not allowed", "arguments": [], "context": {}, "debug": ""},
        }
        with self.assertRaises(OdooHTTPError) as cm:
            self.client().write("res.partner", [1], {"name": "x"})
        self.assertEqual((cm.exception.status, cm.exception.exception_name), (403, "AccessError"))

    def test_non_json_error_body(self) -> None:
        self.odoo.handle = lambda e, h: {"status": 502, "body": "<html>Bad gateway</html>"}
        with self.assertRaises(OdooHTTPError) as cm:
            self.client().search_read("res.partner")
        self.assertEqual(cm.exception.status, 502)
        self.assertIsNone(cm.exception.exception)
        self.assertIsNone(cm.exception.payload)
        self.assertIn("Bad gateway", cm.exception.body)

    def test_multi_database_needs_the_header(self) -> None:
        self.odoo.multi_database = True
        with self.assertRaises(OdooHTTPError) as cm:
            self.client().context_get()
        self.assertEqual(cm.exception.status, 404)
        self.assertIn("No database is selected", cm.exception.body)
        self.assertEqual(self.client(database=DATABASE).context_get()["uid"], 7)

    def test_200_that_is_not_json(self) -> None:
        self.odoo.handle = lambda e, h: {"status": 200, "body": "<html>login</html>"}
        with self.assertRaises(OdooResponseError) as cm:
            self.client().search_read("res.partner")
        self.assertEqual(cm.exception.status, 200)

    def test_redirect_is_not_followed(self) -> None:
        other = MockOdoo()
        try:
            target = f"{other.url}/json/2/res.users/context_get"
            self.odoo.handle = lambda e, h: {"status": 307, "body": "", "headers": {"Location": target}}
            with self.assertRaises(OdooHTTPError) as cm:
                self.client().context_get()
            self.assertEqual(cm.exception.status, 307)
            self.assertEqual(cm.exception.location, target)
            self.assertEqual(other.requests, [])
        finally:
            other.close()

    def test_timeouts(self) -> None:
        self.odoo.handle = delay(1.0)
        t0 = time.monotonic()
        with self.assertRaises(OdooTimeoutError):
            self.client(timeout=0.2).search_read("res.partner")
        self.assertLess(time.monotonic() - t0, 0.9)
        self.odoo.handle = stall(1.0)
        with self.assertRaises(OdooTimeoutError):
            self.client(timeout=0.2).search("res.partner")

    def test_refused_connection(self) -> None:
        s = socket.socket()
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
        s.close()
        with self.assertRaises(OdooNetworkError):
            OdooClient(f"http://127.0.0.1:{port}", KEY).context_get()

    # -- Retries -----------------------------------------------------

    def test_no_retries_by_default(self) -> None:
        self.odoo.handle = lambda e, h: {"status": 503, "body": "busy"}
        with self.assertRaises(OdooHTTPError):
            self.client().search_read("res.partner")
        self.assertEqual(len(self.odoo.requests), 1)

    def test_retries_apply_to_reads_not_to_create(self) -> None:
        count = {"n": 0}

        def flaky(e, h):
            count["n"] += 1
            return {"status": 503, "body": "busy"} if count["n"] <= 2 else None

        self.odoo.handle = flaky
        c = self.client(retries=2, retry_delay=0.001)
        self.assertEqual(len(c.search_read("res.partner", [["is_company", "=", True]], ["name"])), 2)
        self.assertEqual(len(self.odoo.requests), 3)

        self.odoo.requests.clear()
        self.odoo.handle = lambda e, h: {"status": 503, "body": "busy"}
        with self.assertRaises(OdooHTTPError):
            c.create("res.partner", {"name": "Once"})
        self.assertEqual(len(self.odoo.requests), 1)

        self.odoo.requests.clear()
        with self.assertRaises(OdooHTTPError):
            c.create("res.partner", {"name": "Twice"}, idempotent=True)
        self.assertEqual(len(self.odoo.requests), 3)
        self.assertIn("search_read", READ_ONLY_METHODS)
        self.assertNotIn("create", READ_ONLY_METHODS)

    def test_4xx_is_never_retried(self) -> None:
        self.odoo.handle = lambda e, h: {"status": 422, "body": {"name": "odoo.exceptions.UserError", "message": "no"}}
        with self.assertRaises(OdooHTTPError):
            self.client(retries=3, retry_delay=0.001).search_read("res.partner")
        self.assertEqual(len(self.odoo.requests), 1)

    # -- Configuration -----------------------------------------------

    def test_http_only_to_loopback(self) -> None:
        with self.assertRaises(OdooConfigError):
            OdooClient("http://odoo.example.com", KEY)
        OdooClient("http://odoo.example.com", KEY, allow_insecure_http=True)
        OdooClient("http://localhost:8069", KEY)
        OdooClient("http://[::1]:8069", KEY)

    def test_bad_options(self) -> None:
        for url, key in [
            ("https://odoo.example.com", " "),
            ("https://user:pw@odoo.example.com", KEY),
            ("https://odoo.example.com/?db=x", KEY),
            ("ftp://odoo.example.com", KEY),
            ("not a url", KEY),
            ("https://odoo.example.com", "a\nb"),
        ]:
            with self.assertRaises(OdooConfigError, msg=url):
                OdooClient(url, key)
        self.assertTrue(issubclass(OdooConfigError, ValueError))

    def test_key_not_in_repr(self) -> None:
        self.assertNotIn(KEY, repr(self.client()))

    def test_client_from_env(self) -> None:
        self.assertIsNone(client_from_env({"ODOO_URL": "https://odoo.example.com"}))
        c = client_from_env({"ODOO_URL": "https://odoo.example.com", "ODOO_API_KEY": KEY, "ODOO_DATABASE": DATABASE})
        assert c is not None
        self.assertEqual(c.database, DATABASE)


if __name__ == "__main__":
    unittest.main()
