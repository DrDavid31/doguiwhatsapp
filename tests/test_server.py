"""End-to-end tests for server.py.

Runs the real Handler against a real (temporary) SQLite database over
a real socket, the same way the manual curl-based verification during
development was done. No third-party dependencies, to match the
project's zero-dependency style: only stdlib.

Run with:  python -m unittest discover -s tests -v
"""

import http.client
import json
import os
import shutil
import sys
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import server as srv  # noqa: E402


class DoguiTestCase(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.mkdtemp(prefix="dogui-test-")
        srv.DB_PATH = Path(self.tmpdir) / "test.db"
        srv.MEDIA_DIR = Path(self.tmpdir) / "media"
        srv.META_APP_SECRET = ""
        srv.PUBLIC_BASE_URL = ""
        srv.VERIFY_TOKEN = "cambia-este-token"
        srv.init_db()

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), srv.Handler)
        self.httpd.daemon_threads = True
        self.port = self.httpd.server_address[1]
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join(timeout=5)
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def request(self, method, path, body=None, headers=None, cookie=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        try:
            send_headers = dict(headers or {})
            data = None
            if body is not None:
                data = body if isinstance(body, (bytes, str)) else json.dumps(body)
                if isinstance(data, str):
                    data = data.encode("utf-8")
                send_headers.setdefault("Content-Type", "application/json")
            if cookie:
                send_headers["Cookie"] = f"checador_session={cookie}"
            conn.request(method, path, body=data, headers=send_headers)
            response = conn.getresponse()
            raw = response.read()
            try:
                payload = json.loads(raw) if raw else None
            except json.JSONDecodeError:
                payload = raw.decode("utf-8", errors="replace")
            return response.status, payload, dict(response.getheaders())
        finally:
            conn.close()

    def login(self, email="admin@empresa.mx", password="admin123"):
        status, payload, headers = self.request("POST", "/api/login", {"email": email, "password": password})
        self.assertEqual(status, 200, payload)
        set_cookie = headers["Set-Cookie"]
        token = set_cookie.split("checador_session=", 1)[1].split(";", 1)[0]
        return token, payload["user"]

    def create_user(self, email, role, password="test1234"):
        salt, digest = srv.hash_password(password)
        with srv.connect() as con:
            con.execute(
                """
                INSERT INTO users (id, company_id, email, name, role, password_salt, password_hash, active, created_at)
                VALUES (?, 'co-demo', ?, ?, ?, ?, ?, 1, ?)
                """,
                (f"usr-{email}", email, f"Test {role}", role, salt, digest, srv.utc_now()),
            )


class StaticFileAllowlistTests(DoguiTestCase):
    def test_sensitive_files_are_not_served(self):
        for path in ("/server.py", "/README.md", "/.env.example", "/.gitignore", "/run-server.ps1"):
            with self.subTest(path=path):
                status, _, _ = self.request("GET", path)
                self.assertEqual(status, 404, f"{path} should not be servable")

    def test_head_requests_are_also_blocked(self):
        status, _, _ = self.request("HEAD", "/server.py")
        self.assertEqual(status, 404)

    def test_allowlisted_static_files_are_served(self):
        for path in ("/", "/index.html", "/app.js", "/styles.css"):
            with self.subTest(path=path):
                status, _, _ = self.request("GET", path)
                self.assertEqual(status, 200, f"{path} should be servable")


class AuthTests(DoguiTestCase):
    def test_login_success(self):
        token, user = self.login()
        self.assertTrue(token)
        self.assertEqual(user["role"], "Dueno")

    def test_login_wrong_password(self):
        status, payload, _ = self.request("POST", "/api/login", {"email": "admin@empresa.mx", "password": "wrong"})
        self.assertEqual(status, 401)
        self.assertEqual(payload["error"], "credenciales_invalidas")

    def test_login_rejects_non_object_json(self):
        for body in ([1, 2, 3], '"just a string"', "42"):
            with self.subTest(body=body):
                status, payload, _ = self.request("POST", "/api/login", body)
                self.assertEqual(status, 400)
                self.assertEqual(payload["error"], "invalid_json")

    def test_login_rejects_malformed_json(self):
        status, payload, _ = self.request("POST", "/api/login", "{not valid json")
        self.assertEqual(status, 400)
        self.assertEqual(payload["error"], "invalid_json")

    def test_me_is_public_and_reports_no_user_when_logged_out(self):
        status, payload, _ = self.request("GET", "/api/me")
        self.assertEqual(status, 200)
        self.assertIsNone(payload["user"])


class DataEndpointAuthTests(DoguiTestCase):
    PROTECTED_GET_PATHS = [
        "/api/state",
        "/api/employees",
        "/api/records",
        "/api/issues",
        "/api/media",
        "/api/security/tickets",
        "/api/security/alerts",
        "/api/phishing/campaigns",
        "/api/phishing/reports/monthly",
    ]

    def test_protected_endpoints_reject_anonymous_reads(self):
        for path in self.PROTECTED_GET_PATHS:
            with self.subTest(path=path):
                status, _, _ = self.request("GET", path)
                self.assertEqual(status, 401, f"{path} should require auth")

    def test_protected_endpoints_allow_authenticated_reads(self):
        token, _ = self.login()
        for path in self.PROTECTED_GET_PATHS:
            with self.subTest(path=path):
                status, _, _ = self.request("GET", path, cookie=token)
                self.assertEqual(status, 200, f"{path} should work when logged in")

    def test_public_endpoints_stay_public(self):
        for path in ("/api/health", "/api/phishing/templates"):
            with self.subTest(path=path):
                status, _, _ = self.request("GET", path)
                self.assertEqual(status, 200)

    def test_simulate_whatsapp_requires_auth(self):
        status, _, _ = self.request("POST", "/api/simulate-whatsapp", {"from": "+525512340002", "text": "entrar"})
        self.assertEqual(status, 401)

    def test_simulate_whatsapp_works_when_authenticated(self):
        token, _ = self.login()
        status, payload, _ = self.request(
            "POST", "/api/simulate-whatsapp", {"from": "+525512340002", "text": "entrar"}, cookie=token
        )
        self.assertEqual(status, 200, payload)
        self.assertEqual(payload["event"], "entrada")


class WebhookSignatureTests(DoguiTestCase):
    def test_webhook_rejects_when_secret_unset(self):
        srv.META_APP_SECRET = ""
        status, payload, _ = self.request("POST", "/webhooks/whatsapp", {"entry": []})
        self.assertEqual(status, 403)
        self.assertEqual(payload["error"], "invalid signature")

    def test_webhook_rejects_bad_signature(self):
        srv.META_APP_SECRET = "topsecret"
        status, _, _ = self.request(
            "POST", "/webhooks/whatsapp", {"entry": []}, headers={"X-Hub-Signature-256": "sha256=deadbeef"}
        )
        self.assertEqual(status, 403)

    def test_webhook_accepts_valid_signature(self):
        import hashlib
        import hmac

        srv.META_APP_SECRET = "topsecret"
        body = json.dumps({"entry": []}).encode("utf-8")
        signature = "sha256=" + hmac.new(b"topsecret", body, hashlib.sha256).hexdigest()
        status, payload, _ = self.request(
            "POST", "/webhooks/whatsapp", body, headers={"X-Hub-Signature-256": signature}
        )
        self.assertEqual(status, 200, payload)


class RoleGatingTests(DoguiTestCase):
    def test_empleado_role_is_blocked_from_admin_actions(self):
        self.create_user("empleado@test.mx", "Empleado")
        token, _ = self.login("empleado@test.mx", "test1234")

        status, _, _ = self.request("DELETE", "/api/employees/emp-carlos", cookie=token)
        self.assertEqual(status, 403)

        status, _, _ = self.request("POST", "/api/issues/whatever/status", {"status": "Aprobada"}, cookie=token)
        self.assertEqual(status, 403)

    def test_dueno_role_can_perform_admin_actions(self):
        token, _ = self.login()
        status, payload, _ = self.request("DELETE", "/api/employees/emp-carlos", cookie=token)
        self.assertEqual(status, 200, payload)


class EndToEndFlowTests(DoguiTestCase):
    def test_login_report_incident_and_approve(self):
        token, _ = self.login()

        status, payload, _ = self.request(
            "POST", "/api/simulate-whatsapp", {"from": "+52 55 1234 0001", "text": "vacaciones 10/06 al 12/06"}, cookie=token
        )
        self.assertEqual(status, 200, payload)

        status, state, _ = self.request("GET", "/api/state", cookie=token)
        self.assertEqual(status, 200)
        pending = [issue for issue in state["issues"] if issue["status"] == "Pendiente"]
        self.assertEqual(len(pending), 1)

        status, payload, _ = self.request(
            "POST", f"/api/issues/{pending[0]['id']}/status", {"status": "Aprobada"}, cookie=token
        )
        self.assertEqual(status, 200, payload)

        status, state, _ = self.request("GET", "/api/state", cookie=token)
        approved = next(issue for issue in state["issues"] if issue["id"] == pending[0]["id"])
        self.assertEqual(approved["status"], "Aprobada")


class TrainingPageEscapingTests(unittest.TestCase):
    def test_title_and_body_are_escaped(self):
        html = srv.training_page('<script>alert(1)</script>', 'body & "quotes"')
        self.assertNotIn("<script>alert(1)</script>", html)
        self.assertIn("&lt;script&gt;", html)

    def test_action_url_is_escaped(self):
        html = srv.training_page("t", "b", '"><script>alert(1)</script>')
        self.assertNotIn('"><script>alert(1)</script>', html)


if __name__ == "__main__":
    unittest.main()
