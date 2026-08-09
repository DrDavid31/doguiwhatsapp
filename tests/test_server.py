"""End-to-end tests for server.py.

Runs the real Handler against a real (temporary) SQLite database over
a real socket, the same way the manual curl-based verification during
development was done. No third-party dependencies, to match the
project's zero-dependency style: only stdlib.

Run with:  python -m unittest discover -s tests -v
"""

import contextlib
import http.client
import io
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

    def create_user(self, email, role, password="test1234", company_id="co-demo"):
        salt, digest = srv.hash_password(password)
        with srv.connect() as con:
            con.execute(
                """
                INSERT INTO users (id, company_id, email, name, role, password_salt, password_hash, active, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
                """,
                (f"usr-{email}", company_id, email, f"Test {role}", role, salt, digest, srv.utc_now()),
            )

    def create_company(self, company_id, name):
        with srv.connect() as con:
            con.execute(
                "INSERT INTO companies (id, name, created_at) VALUES (?, ?, ?)",
                (company_id, name, srv.utc_now()),
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

    def test_empleado_role_is_blocked_from_policy_and_branches(self):
        self.create_user("empleado2@test.mx", "Empleado")
        token, _ = self.login("empleado2@test.mx", "test1234")

        status, _, _ = self.request("POST", "/api/policy", {"tolerance": 5}, cookie=token)
        self.assertEqual(status, 403)

        status, _, _ = self.request("POST", "/api/branches", {"name": "X", "lat": 1, "lng": 1}, cookie=token)
        self.assertEqual(status, 403)

    def test_empleado_role_is_blocked_from_state_and_employee_writes(self):
        self.create_user("empleado3@test.mx", "Empleado")
        token, _ = self.login("empleado3@test.mx", "test1234")

        status, _, _ = self.request("PUT", "/api/state", {"employees": []}, cookie=token)
        self.assertEqual(status, 403)

        status, _, _ = self.request("POST", "/api/employees", {"name": "X", "phone": "+521"}, cookie=token)
        self.assertEqual(status, 403)

    def test_dueno_role_can_save_state_and_create_employees(self):
        token, _ = self.login()
        status, state, _ = self.request("GET", "/api/state", cookie=token)
        status, payload, _ = self.request("PUT", "/api/state", {**state, "_version": state["version"]}, cookie=token)
        self.assertEqual(status, 200, payload)

        status, payload, _ = self.request("POST", "/api/employees", {"name": "Nuevo", "phone": "+521"}, cookie=token)
        self.assertEqual(status, 200, payload)


class TenantIsolationTests(DoguiTestCase):
    def setUp(self):
        super().setUp()
        self.create_company("co-other", "Otra Empresa")
        self.create_user("owner@other.mx", "Dueno", company_id="co-other")
        with srv.connect() as con:
            con.execute(
                "INSERT INTO branches (id, company_id, name, lat, lng, active) VALUES ('br-other', 'co-other', 'Sucursal Otra', 0, 0, 1)"
            )
            con.execute(
                """
                INSERT INTO employees (id, company_id, branch_id, name, phone, phone_normalized, area, mode, role, start_time, end_time, vacation_days, active)
                VALUES ('emp-other', 'co-other', 'br-other', 'Empleado Otro', '+52 55 0000 0001', '525500000001', 'General', 'Presencial', 'Empleado', '09:00', '18:00', 5, 1)
                """
            )

    def test_employee_listing_is_scoped_to_own_company(self):
        token, _ = self.login()  # Dueno of co-demo
        status, employees, _ = self.request("GET", "/api/employees", cookie=token)
        self.assertEqual(status, 200)
        names = [e["name"] for e in employees]
        self.assertNotIn("Empleado Otro", names)

        status, state, _ = self.request("GET", "/api/state", cookie=token)
        self.assertNotIn("Empleado Otro", [e["name"] for e in state["employees"]])
        self.assertNotIn("Otra Empresa", [c["name"] for c in state["companies"]])
        self.assertNotIn("Sucursal Otra", [b["name"] for b in state["branches"]])

    def test_cannot_overwrite_another_companys_employee(self):
        token, _ = self.login()  # Dueno of co-demo
        status, payload, _ = self.request(
            "POST", "/api/employees", {"id": "emp-other", "name": "Hijacked", "phone": "+52 55 9999 9999"}, cookie=token
        )
        self.assertEqual(status, 403, payload)

        with srv.connect() as con:
            row = con.execute("SELECT name, phone FROM employees WHERE id = 'emp-other'").fetchone()
        self.assertEqual(row["name"], "Empleado Otro")
        self.assertEqual(row["phone"], "+52 55 0000 0001")

    def test_cannot_deactivate_another_companys_employee(self):
        token, _ = self.login()  # Dueno of co-demo
        status, _, _ = self.request("DELETE", "/api/employees/emp-other", cookie=token)
        self.assertEqual(status, 404)

        with srv.connect() as con:
            row = con.execute("SELECT active FROM employees WHERE id = 'emp-other'").fetchone()
        self.assertEqual(row["active"], 1)

    def test_state_save_cannot_inject_data_into_another_company(self):
        token, _ = self.login()  # Dueno of co-demo
        status, state, _ = self.request("GET", "/api/state", cookie=token)
        malicious = {**state, "_version": state["version"], "selectedCompanyId": "co-other", "policy": {**state["policy"], "tolerance": 999}}
        status, payload, _ = self.request("PUT", "/api/state", malicious, cookie=token)
        self.assertEqual(status, 200, payload)

        with srv.connect() as con:
            other_policy = con.execute("SELECT tolerance FROM policies WHERE company_id = 'co-other'").fetchone()
            own_policy = con.execute("SELECT tolerance FROM policies WHERE company_id = 'co-demo'").fetchone()
        self.assertIsNone(other_policy, "save must not be able to write policy for a company the caller doesn't belong to")
        self.assertEqual(own_policy["tolerance"], 999)


class ChangePasswordTests(DoguiTestCase):
    def test_change_password_requires_current_password(self):
        token, _ = self.login()
        status, payload, _ = self.request(
            "POST", "/api/change-password", {"currentPassword": "wrong", "newPassword": "una-clave-nueva-larga"}, cookie=token
        )
        self.assertEqual(status, 401)
        self.assertEqual(payload["error"], "invalid_current_password")

    def test_change_password_rejects_short_passwords(self):
        token, _ = self.login()
        status, payload, _ = self.request(
            "POST", "/api/change-password", {"currentPassword": "admin123", "newPassword": "short"}, cookie=token
        )
        self.assertEqual(status, 400)
        self.assertEqual(payload["error"], "weak_password")

    def test_change_password_succeeds_and_rotates_credential(self):
        token, _ = self.login()
        status, payload, _ = self.request(
            "POST", "/api/change-password", {"currentPassword": "admin123", "newPassword": "una-clave-nueva-larga"}, cookie=token
        )
        self.assertEqual(status, 200, payload)

        status, payload, _ = self.request("POST", "/api/login", {"email": "admin@empresa.mx", "password": "admin123"})
        self.assertEqual(status, 401, "old password must stop working")

        status, payload, _ = self.request(
            "POST", "/api/login", {"email": "admin@empresa.mx", "password": "una-clave-nueva-larga"}
        )
        self.assertEqual(status, 200, payload)

    def test_change_password_invalidates_existing_sessions(self):
        token, _ = self.login()
        status, _, _ = self.request(
            "POST", "/api/change-password", {"currentPassword": "admin123", "newPassword": "una-clave-nueva-larga"}, cookie=token
        )
        self.assertEqual(status, 200)

        status, _, _ = self.request("GET", "/api/state", cookie=token)
        self.assertEqual(status, 401, "the old session token should be revoked after a password change")


class SecurityWarningsTests(DoguiTestCase):
    def test_warns_when_default_admin_password_is_unchanged(self):
        buffer = io.StringIO()
        with contextlib.redirect_stdout(buffer):
            srv.print_security_warnings()
        self.assertIn("admin123", buffer.getvalue())

    def test_no_warning_after_password_is_changed(self):
        with srv.connect() as con:
            row = con.execute("SELECT id FROM users WHERE email = 'admin@empresa.mx'").fetchone()
            salt, digest = srv.hash_password("una-clave-nueva-larga")
            con.execute("UPDATE users SET password_salt = ?, password_hash = ? WHERE id = ?", (salt, digest, row["id"]))

        buffer = io.StringIO()
        with contextlib.redirect_stdout(buffer):
            srv.print_security_warnings()
        self.assertNotIn("admin123", buffer.getvalue())


class PhishingTrackingTests(DoguiTestCase):
    def launch_campaign(self, token):
        status, payload, _ = self.request(
            "POST",
            "/api/phishing/campaigns",
            {"name": "Prueba", "channel": "Correo", "template": "Aviso SAT", "department": "Todos", "launchNow": True},
            cookie=token,
        )
        self.assertEqual(status, 200, payload)
        with srv.connect() as con:
            target = con.execute(
                "SELECT * FROM phishing_targets WHERE campaign_id = ? LIMIT 1", (payload["campaign"]["id"],)
            ).fetchone()
        return payload["campaign"]["id"], target

    def test_real_target_id_still_tracks_a_click(self):
        token, _ = self.login()
        campaign_id, target = self.launch_campaign(token)
        status, body = self._get_raw(f"/t/{campaign_id}/{target['id']}")
        self.assertEqual(status, 200)
        self.assertIn(b"registrado", body)

        with srv.connect() as con:
            row = con.execute("SELECT clicked_at FROM phishing_targets WHERE id = ?", (target["id"],)).fetchone()
        self.assertIsNotNone(row["clicked_at"])

    def test_click_token_still_tracks_a_click(self):
        token, _ = self.login()
        campaign_id, target = self.launch_campaign(token)
        status, body = self._get_raw(f"/t/{campaign_id}/{target['click_token']}")
        self.assertEqual(status, 200)
        self.assertIn(b"registrado", body)

    def test_employee_id_alone_does_not_track_a_click(self):
        token, _ = self.login()
        campaign_id, target = self.launch_campaign(token)
        status, body = self._get_raw(f"/t/{campaign_id}/{target['employee_id']}")
        self.assertEqual(status, 404)
        self.assertIn(b"no encontro", body.lower())

        with srv.connect() as con:
            row = con.execute("SELECT clicked_at FROM phishing_targets WHERE id = ?", (target["id"],)).fetchone()
        self.assertIsNone(row["clicked_at"], "employee_id must not be able to fake a click")

    def _get_raw(self, path):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        conn.request("GET", path)
        response = conn.getresponse()
        raw = response.read()
        conn.close()
        return response.status, raw


class PolicyBranchAlertTests(DoguiTestCase):
    def test_update_policy(self):
        token, _ = self.login()
        status, payload, _ = self.request(
            "POST",
            "/api/policy",
            {"tolerance": 20, "forgottenExitHours": 6, "geofenceRadius": 400, "overtimeAfterHours": 7, "requireGps": False, "requireSelfie": True},
            cookie=token,
        )
        self.assertEqual(status, 200, payload)
        status, state, _ = self.request("GET", "/api/state", cookie=token)
        self.assertEqual(state["policy"]["tolerance"], 20)
        self.assertEqual(state["policy"]["geofenceRadius"], 400)
        self.assertFalse(state["policy"]["requireGps"])

    def test_update_policy_rejects_bad_values(self):
        token, _ = self.login()
        status, payload, _ = self.request("POST", "/api/policy", {"tolerance": "not-a-number"}, cookie=token)
        self.assertEqual(status, 400)
        self.assertEqual(payload["error"], "invalid_policy_values")

    def test_create_branch(self):
        token, _ = self.login()
        status, payload, _ = self.request("POST", "/api/branches", {"name": "Sucursal Sur", "lat": 19.3, "lng": -99.2}, cookie=token)
        self.assertEqual(status, 200, payload)
        status, state, _ = self.request("GET", "/api/state", cookie=token)
        names = [b["name"] for b in state["branches"]]
        self.assertIn("Sucursal Sur", names)

    def test_create_branch_requires_name(self):
        token, _ = self.login()
        status, payload, _ = self.request("POST", "/api/branches", {"lat": 1, "lng": 1}, cookie=token)
        self.assertEqual(status, 400)
        self.assertEqual(payload["error"], "name_required")

    def test_close_alert(self):
        token, _ = self.login()
        with srv.connect() as con:
            con.execute(
                "INSERT INTO alerts (id, alert_key, employee_id, type, detail, severity, status, timestamp) "
                "VALUES ('alert-1', 'k1', 'emp-ana', 'GPS faltante', 'test', 'warn', 'Abierta', ?)",
                (srv.utc_now(),),
            )
        status, payload, _ = self.request("POST", "/api/alerts/alert-1/status", {"status": "Cerrada"}, cookie=token)
        self.assertEqual(status, 200, payload)
        status, state, _ = self.request("GET", "/api/state", cookie=token)
        alert = next(a for a in state["alerts"] if a["id"] == "alert-1")
        self.assertEqual(alert["status"], "Cerrada")

    def test_close_alert_not_found(self):
        token, _ = self.login()
        status, payload, _ = self.request("POST", "/api/alerts/does-not-exist/status", {"status": "Cerrada"}, cookie=token)
        self.assertEqual(status, 404)


class StateConcurrencyTests(DoguiTestCase):
    def test_state_includes_version(self):
        token, _ = self.login()
        status, state, _ = self.request("GET", "/api/state", cookie=token)
        self.assertEqual(status, 200)
        self.assertEqual(state["version"], 0)

    def test_stale_version_is_rejected(self):
        token, _ = self.login()
        status, payload, _ = self.request("PUT", "/api/state", {"_version": 999, "employees": []}, cookie=token)
        self.assertEqual(status, 409)
        self.assertEqual(payload["error"], "conflict")

    def test_current_version_is_accepted_and_increments(self):
        token, _ = self.login()
        status, payload, _ = self.request("PUT", "/api/state", {"_version": 0, "employees": []}, cookie=token)
        self.assertEqual(status, 200, payload)
        self.assertEqual(payload["version"], 1)

        status, payload, _ = self.request("PUT", "/api/state", {"_version": 0, "employees": []}, cookie=token)
        self.assertEqual(status, 409, payload)

    def test_missing_version_is_backward_compatible(self):
        token, _ = self.login()
        status, payload, _ = self.request("PUT", "/api/state", {"employees": []}, cookie=token)
        self.assertEqual(status, 200, payload)

    def test_approving_vacation_issue_decrements_balance(self):
        token, _ = self.login()
        status, payload, _ = self.request(
            "POST", "/api/simulate-whatsapp", {"from": "+52 55 1234 0001", "text": "vacaciones 10/06 al 12/06"}, cookie=token
        )
        self.assertEqual(status, 200, payload)
        status, state, _ = self.request("GET", "/api/state", cookie=token)
        issue = next(i for i in state["issues"] if i["status"] == "Pendiente")
        before = next(e for e in state["employees"] if e["id"] == "emp-ana")["vacationDays"]

        status, payload, _ = self.request("POST", f"/api/issues/{issue['id']}/status", {"status": "Aprobada"}, cookie=token)
        self.assertEqual(status, 200, payload)

        status, state, _ = self.request("GET", "/api/state", cookie=token)
        after = next(e for e in state["employees"] if e["id"] == "emp-ana")["vacationDays"]
        self.assertEqual(after, before - 1)


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


class JouleSnapshotTests(DoguiTestCase):
    def test_snapshot_includes_platform_wide_data(self):
        token, _ = self.login()
        status, state, _ = self.request("GET", "/api/state", cookie=token)
        self.assertEqual(status, 200)
        snapshot = srv.joule_snapshot(state)
        self.assertIn("empleados", snapshot)
        self.assertIn("sucursales", snapshot)
        self.assertIn("politica", snapshot)
        self.assertGreaterEqual(len(snapshot["sucursales"]), 1)
        self.assertEqual(snapshot["politica"]["tolerance"], state["policy"]["tolerance"])


class TrainingPageEscapingTests(unittest.TestCase):
    def test_title_and_body_are_escaped(self):
        html = srv.training_page('<script>alert(1)</script>', 'body & "quotes"')
        self.assertNotIn("<script>alert(1)</script>", html)
        self.assertIn("&lt;script&gt;", html)

    def test_action_url_is_escaped(self):
        html = srv.training_page("t", "b", '"><script>alert(1)</script>')
        self.assertNotIn('"><script>alert(1)</script>', html)


class LoginAuditLogTests(DoguiTestCase):
    def test_successful_login_is_logged(self):
        self.login()
        with srv.connect() as con:
            rows = con.execute(
                "SELECT * FROM login_logs WHERE email_attempted = ?", ("admin@empresa.mx",)
            ).fetchall()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["success"], 1)
        self.assertIsNone(rows[0]["failure_reason"])
        self.assertIsNotNone(rows[0]["user_id"])
        self.assertEqual(rows[0]["role_at_login"], "Dueno")
        self.assertIsNotNone(rows[0]["timestamp"])

    def test_failed_login_with_wrong_password_is_logged(self):
        status, payload, _ = self.request(
            "POST", "/api/login", {"email": "admin@empresa.mx", "password": "wrong"}
        )
        self.assertEqual(status, 401)
        with srv.connect() as con:
            rows = con.execute(
                "SELECT * FROM login_logs WHERE email_attempted = ?", ("admin@empresa.mx",)
            ).fetchall()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["success"], 0)
        self.assertEqual(rows[0]["failure_reason"], "bad_password")
        self.assertIsNotNone(rows[0]["user_id"])

    def test_failed_login_with_nonexistent_user_is_logged(self):
        status, payload, _ = self.request(
            "POST", "/api/login", {"email": "nadie@test.mx", "password": "loquesea"}
        )
        self.assertEqual(status, 401)
        with srv.connect() as con:
            rows = con.execute(
                "SELECT * FROM login_logs WHERE email_attempted = ?", ("nadie@test.mx",)
            ).fetchall()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["success"], 0)
        self.assertEqual(rows[0]["failure_reason"], "user_not_found")
        self.assertIsNone(rows[0]["user_id"])

    def test_login_error_response_does_not_reveal_which_reason_failed(self):
        _, wrong_password_payload, _ = self.request(
            "POST", "/api/login", {"email": "admin@empresa.mx", "password": "wrong"}
        )
        _, unknown_user_payload, _ = self.request(
            "POST", "/api/login", {"email": "nadie@test.mx", "password": "wrong"}
        )
        self.assertEqual(wrong_password_payload, unknown_user_payload)


class BasicoRoleGatingTests(DoguiTestCase):
    def test_basico_role_is_blocked_from_login_logs_endpoint(self):
        self.create_user("basico@test.mx", "Basico")
        token, _ = self.login("basico@test.mx", "test1234")
        status, _, _ = self.request("GET", "/api/access/login-logs", cookie=token)
        self.assertEqual(status, 403)

    def test_basico_role_is_blocked_from_existing_admin_endpoints(self):
        self.create_user("basico2@test.mx", "Basico")
        token, _ = self.login("basico2@test.mx", "test1234")

        status, _, _ = self.request("DELETE", "/api/employees/emp-carlos", cookie=token)
        self.assertEqual(status, 403)

        status, _, _ = self.request("POST", "/api/policy", {"tolerance": 5}, cookie=token)
        self.assertEqual(status, 403)

        status, _, _ = self.request("PUT", "/api/state", {"employees": []}, cookie=token)
        self.assertEqual(status, 403)

        status, _, _ = self.request("POST", "/api/employees", {"name": "X", "phone": "+521"}, cookie=token)
        self.assertEqual(status, 403)

    def test_basico_role_can_still_read_general_data_endpoints(self):
        self.create_user("basico3@test.mx", "Basico")
        token, _ = self.login("basico3@test.mx", "test1234")
        status, _, _ = self.request("GET", "/api/state", cookie=token)
        self.assertEqual(status, 200)

    # Barre TODOS los endpoints protegidos con require_role(ADMIN_ROLES) en server.py
    # (no solo los nuevos de esta funcionalidad), para que "Basico" nunca quede
    # expuesto por un endpoint que se agregue despues y se nos olvide auditar aqui.
    ADMIN_ONLY_ENDPOINTS = [
        ("PUT", "/api/state", {"employees": []}),
        ("POST", "/api/state", {"employees": []}),
        ("POST", "/api/employees", {"name": "X", "phone": "+521"}),
        ("POST", "/api/security/tickets/tk-fake/status", {"status": "Cerrado"}),
        ("POST", "/api/phishing/campaigns", {"name": "X"}),
        ("POST", "/api/phishing/campaigns/camp-fake/launch", None),
        ("POST", "/api/issues/issue-fake/status", {"status": "Aprobada"}),
        ("POST", "/api/alerts/alert-fake/status", {"status": "Cerrada"}),
        ("POST", "/api/policy", {"tolerance": 5}),
        ("POST", "/api/branches", {"name": "X", "lat": 1, "lng": 1}),
        ("DELETE", "/api/employees/emp-fake", None),
        ("GET", "/api/access/login-logs", None),
    ]

    def test_basico_role_gets_403_on_every_admin_only_endpoint(self):
        self.create_user("basico-sweep@test.mx", "Basico")
        token, _ = self.login("basico-sweep@test.mx", "test1234")
        for method, path, body in self.ADMIN_ONLY_ENDPOINTS:
            with self.subTest(method=method, path=path):
                status, payload, _ = self.request(method, path, body, cookie=token)
                self.assertEqual(status, 403, f"{method} {path} deberia devolver 403 para Basico, devolvio {status}: {payload}")


class LoginLogsAccessEndpointTests(DoguiTestCase):
    def test_admin_can_read_paginated_login_logs(self):
        token, _ = self.login()
        for _ in range(3):
            self.request("POST", "/api/login", {"email": "admin@empresa.mx", "password": "wrong"})

        status, payload, _ = self.request("GET", "/api/access/login-logs?limit=2&offset=0", cookie=token)
        self.assertEqual(status, 200, payload)
        self.assertEqual(len(payload["items"]), 2)
        self.assertEqual(payload["limit"], 2)
        self.assertEqual(payload["offset"], 0)
        self.assertGreaterEqual(payload["total"], 4)

    def test_admin_can_filter_login_logs_by_user_id(self):
        token, admin_user = self.login()
        self.create_user("otro@test.mx", "RRHH")
        self.login("otro@test.mx", "test1234")

        status, payload, _ = self.request(
            "GET", f"/api/access/login-logs?userId={admin_user['id']}", cookie=token
        )
        self.assertEqual(status, 200, payload)
        self.assertTrue(payload["items"])
        self.assertTrue(all(item["userId"] == admin_user["id"] for item in payload["items"]))

    def test_admin_can_filter_login_logs_by_date_range(self):
        token, _ = self.login()
        status, payload, _ = self.request(
            "GET", "/api/access/login-logs?from=2999-01-01T00:00:00", cookie=token
        )
        self.assertEqual(status, 200, payload)
        self.assertEqual(payload["items"], [])

    def test_invalid_pagination_params_are_rejected(self):
        token, _ = self.login()
        status, payload, _ = self.request("GET", "/api/access/login-logs?limit=abc", cookie=token)
        self.assertEqual(status, 400, payload)


class LoginLogsSurviveEmployeeDeactivationTests(DoguiTestCase):
    def test_login_logs_survive_linked_employee_deactivation(self):
        token, _ = self.login()
        status, employee_payload, _ = self.request(
            "POST", "/api/employees", {"name": "Empleado Vinculado", "phone": "+52 55 9999 0001"}, cookie=token
        )
        self.assertEqual(status, 200, employee_payload)
        employee_id = employee_payload["id"]

        salt, digest = srv.hash_password("test1234")
        with srv.connect() as con:
            con.execute(
                """
                INSERT INTO users (id, company_id, email, name, role, password_salt, password_hash, active, created_at, employee_id)
                VALUES ('usr-vinculado', 'co-demo', 'vinculado@test.mx', 'Usuario Vinculado', 'Basico', ?, ?, 1, ?, ?)
                """,
                (salt, digest, srv.utc_now(), employee_id),
            )

        self.login("vinculado@test.mx", "test1234")
        self.request("POST", "/api/login", {"email": "vinculado@test.mx", "password": "wrong"})

        with srv.connect() as con:
            before = con.execute(
                "SELECT COUNT(*) FROM login_logs WHERE user_id = 'usr-vinculado'"
            ).fetchone()[0]
        self.assertEqual(before, 2)

        status, _, _ = self.request("DELETE", f"/api/employees/{employee_id}", cookie=token)
        self.assertEqual(status, 200)

        with srv.connect() as con:
            after_rows = con.execute(
                "SELECT * FROM login_logs WHERE user_id = 'usr-vinculado' ORDER BY timestamp"
            ).fetchall()
            employee_row = con.execute("SELECT active FROM employees WHERE id = ?", (employee_id,)).fetchone()
        self.assertEqual(employee_row["active"], 0)
        self.assertEqual(len(after_rows), before)
        self.assertEqual(after_rows[0]["email_attempted"], "vinculado@test.mx")


if __name__ == "__main__":
    unittest.main()
