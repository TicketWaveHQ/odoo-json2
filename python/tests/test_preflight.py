"""The preflight, run as `python -m odoo_json2.preflight` against the mock Odoo."""

from __future__ import annotations

import os
import socket
import subprocess
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
SRC = HERE.parent / "src"
sys.path.insert(0, str(HERE))

from mock_odoo import DATABASE, KEY, MockOdoo  # noqa: E402


def run(env: dict[str, str], *args: str) -> tuple[int, str]:
    clean = {"PATH": os.environ.get("PATH", ""), "NO_COLOR": "1", "PYTHONPATH": str(SRC), **env}
    p = subprocess.run(
        [sys.executable, "-m", "odoo_json2.preflight", *args], env=clean, capture_output=True, text=True, timeout=30
    )
    return p.returncode, p.stdout + p.stderr


class PreflightTests(unittest.TestCase):
    odoo: MockOdoo

    @classmethod
    def setUpClass(cls) -> None:
        cls.odoo = MockOdoo()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.odoo.close()

    def setUp(self) -> None:
        self.odoo.reset()

    def test_passes_and_never_prints_the_key(self) -> None:
        code, out = run({"ODOO_URL": self.odoo.url, "ODOO_DATABASE": DATABASE, "ODOO_API_KEY": KEY}, "--model", "res.partner")
        self.assertEqual(code, 0, out)
        self.assertIn("PASS  reached /web/version  server 19.0", out)
        self.assertIn("PASS  the key is accepted (res.users/context_get)  user id 7, lang en_GB, tz Europe/London", out)
        self.assertIn("PASS  the key's user is not a Settings administrator", out)
        self.assertIn("INFO  res.partner: read yes, write yes, create yes, unlink no", out)
        self.assertIn("All checks passed", out)
        self.assertNotIn(KEY, out)

    def test_refused_key(self) -> None:
        bad = "f" * 40
        code, out = run({"ODOO_URL": self.odoo.url, "ODOO_API_KEY": bad})
        self.assertEqual(code, 1)
        self.assertIn("FAIL  the key was not accepted", out)
        self.assertIn("HTTP 401 werkzeug.exceptions.Unauthorized: Invalid apikey", out)
        self.assertNotIn(bad, out)
        self.assertNotIn("Traceback", out)

    def test_warnings(self) -> None:
        code, out = run({"ODOO_URL": self.odoo.url, "ODOO_API_KEY": "hunter2"})
        self.assertEqual(code, 1)
        self.assertIn("WARN  the key does not look like one Odoo generated", out)
        self.odoo.admin = True
        code, out = run({"ODOO_URL": self.odoo.url, "ODOO_API_KEY": KEY})
        self.assertEqual(code, 0, out)
        self.assertIn("WARN  the key's user is a Settings administrator", out)

    def test_missing_database(self) -> None:
        self.odoo.multi_database = True
        code, out = run({"ODOO_URL": self.odoo.url, "ODOO_API_KEY": KEY})
        self.assertEqual(code, 1)
        self.assertIn("HTTP 404", out)
        self.assertIn("no database was selected", out)

    def test_missing_config_and_key_flag(self) -> None:
        code, out = run({})
        self.assertEqual(code, 1)
        self.assertIn("FAIL  missing: ODOO_URL, ODOO_API_KEY", out)
        code, out = run({}, "--key", "x")
        self.assertEqual(code, 2)
        self.assertIn("--key is not accepted", out)

    def test_unreachable(self) -> None:
        s = socket.socket()
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
        s.close()
        code, out = run({"ODOO_URL": f"http://127.0.0.1:{port}", "ODOO_API_KEY": KEY}, "--timeout", "2")
        self.assertEqual(code, 1)
        self.assertIn("FAIL  could not reach /web/version", out)
        self.assertIn("network error:", out)

    def test_old_server(self) -> None:
        old = MockOdoo(version={"version_info": [17, 0, 0, "final", 0, ""], "version": "17.0"})
        try:
            _code, out = run({"ODOO_URL": old.url, "ODOO_API_KEY": KEY})
            self.assertIn("WARN  server reports Odoo 17", out)
        finally:
            old.close()


if __name__ == "__main__":
    unittest.main()
