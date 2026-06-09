import base64
import hashlib
import hmac
import json
import mimetypes
import os
import secrets
import sqlite3
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from http import cookies
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


ROOT = Path(__file__).resolve().parent
DB_PATH = ROOT / "checador.db"
MEDIA_DIR = ROOT / "media"
PORT = int(os.getenv("PORT", "8080"))
GRAPH_API_VERSION = os.getenv("GRAPH_API_VERSION", "v20.0")
VERIFY_TOKEN = os.getenv("WHATSAPP_VERIFY_TOKEN", "cambia-este-token")
META_APP_SECRET = os.getenv("META_APP_SECRET", "")
WHATSAPP_TOKEN = os.getenv("WHATSAPP_TOKEN", "")
WHATSAPP_PHONE_NUMBER_ID = os.getenv("WHATSAPP_PHONE_NUMBER_ID", "")
SESSION_DAYS = int(os.getenv("SESSION_DAYS", "7"))
PUBLIC_BASE_URL = os.getenv("PUBLIC_BASE_URL", "").rstrip("/")
CORS_ORIGIN = os.getenv("CORS_ORIGIN", "")
SENDGRID_API_KEY = os.getenv("SENDGRID_API_KEY", "")
EMAIL_FROM = os.getenv("EMAIL_FROM", "seguridad@dogui.mx")
TWILIO_ACCOUNT_SID = os.getenv("TWILIO_ACCOUNT_SID", "")
TWILIO_AUTH_TOKEN = os.getenv("TWILIO_AUTH_TOKEN", "")
TWILIO_FROM = os.getenv("TWILIO_FROM", "")


DEFAULT_POLICY = {
    "tolerance": 10,
    "forgottenExitHours": 10,
    "geofenceRadius": 250,
    "overtimeAfterHours": 8,
    "requireGps": True,
    "requireSelfie": False,
}


DEFAULT_STATE = {
    "companies": [{"id": "co-demo", "name": "Empresa Demo"}],
    "selectedCompanyId": "co-demo",
    "branches": [
        {"id": "br-centro", "companyId": "co-demo", "name": "Sucursal Centro", "lat": 19.432608, "lng": -99.133209},
        {"id": "br-norte", "companyId": "co-demo", "name": "Planta Norte", "lat": 19.4938, "lng": -99.1462},
    ],
    "selectedBranchId": "br-centro",
    "policy": DEFAULT_POLICY,
    "employees": [
        {
            "id": "emp-ana",
            "name": "Ana Lopez",
            "phone": "+52 55 1234 0001",
            "area": "Administracion",
            "branchId": "br-centro",
            "mode": "Hibrido",
            "role": "Supervisor",
            "start": "09:00",
            "end": "18:00",
            "vacationDays": 12,
            "active": True,
        },
        {
            "id": "emp-carlos",
            "name": "Carlos Mendez",
            "phone": "+52 55 1234 0002",
            "area": "Operaciones",
            "branchId": "br-norte",
            "mode": "Presencial",
            "role": "Empleado",
            "start": "08:00",
            "end": "17:00",
            "vacationDays": 8,
            "active": True,
        },
    ],
    "records": [],
    "issues": [],
    "alerts": [],
    "audit": [],
    "chat": [],
    "securityTickets": [],
    "securityAlerts": [],
    "phishingTemplates": [
        {"id": "tpl-factura", "name": "Factura proveedor", "category": "proveedor", "channel": "Correo", "risk": "Alta"},
        {"id": "tpl-banco", "name": "Validacion bancaria", "category": "banco", "channel": "SMS", "risk": "Alta"},
        {"id": "tpl-rh", "name": "Actualizacion RH", "category": "RH", "channel": "WhatsApp", "risk": "Media"},
        {"id": "tpl-paqueteria", "name": "Paqueteria retenida", "category": "paqueteria", "channel": "SMS", "risk": "Media"},
        {"id": "tpl-sat", "name": "Aviso SAT", "category": "SAT", "channel": "Correo", "risk": "Alta"},
    ],
    "phishingCampaigns": [],
    "report": {"from": datetime.now().date().isoformat(), "to": datetime.now().date().isoformat(), "area": "Todas"},
}


def utc_now():
    return datetime.now(timezone.utc).isoformat()


def make_id(prefix):
    return f"{prefix}-{int(time.time() * 1000)}-{os.urandom(3).hex()}"


def normalize_phone(value):
    return "".join(ch for ch in str(value or "") if ch.isdigit())


def bool_int(value):
    return 1 if bool(value) else 0


def row_json(value, default):
    if value in (None, ""):
        return default
    try:
        return json.loads(value)
    except json.JSONDecodeError:
        return default


def hash_password(password, salt=None):
    salt = salt or secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt.encode("utf-8"), 120_000)
    return salt, base64.b64encode(digest).decode("ascii")


def verify_password(password, salt, expected_hash):
    _, actual_hash = hash_password(password, salt)
    return hmac.compare_digest(actual_hash, expected_hash)


def connect():
    con = sqlite3.connect(DB_PATH, timeout=10)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys = ON")
    con.execute("PRAGMA busy_timeout = 5000")
    con.execute("PRAGMA journal_mode = WAL")
    con.execute("PRAGMA synchronous = NORMAL")
    return con


def init_db():
    MEDIA_DIR.mkdir(exist_ok=True)
    with connect() as con:
        con.executescript(
            """
            CREATE TABLE IF NOT EXISTS companies (
              id TEXT PRIMARY KEY,
              name TEXT NOT NULL,
              created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS branches (
              id TEXT PRIMARY KEY,
              company_id TEXT NOT NULL REFERENCES companies(id),
              name TEXT NOT NULL,
              lat REAL NOT NULL,
              lng REAL NOT NULL,
              active INTEGER NOT NULL DEFAULT 1
            );
            CREATE TABLE IF NOT EXISTS policies (
              company_id TEXT PRIMARY KEY REFERENCES companies(id),
              tolerance INTEGER NOT NULL,
              forgotten_exit_hours REAL NOT NULL,
              geofence_radius INTEGER NOT NULL,
              overtime_after_hours REAL NOT NULL,
              require_gps INTEGER NOT NULL,
              require_selfie INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS users (
              id TEXT PRIMARY KEY,
              company_id TEXT NOT NULL REFERENCES companies(id),
              email TEXT NOT NULL UNIQUE,
              name TEXT NOT NULL,
              role TEXT NOT NULL,
              password_salt TEXT NOT NULL,
              password_hash TEXT NOT NULL,
              active INTEGER NOT NULL DEFAULT 1,
              created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS sessions (
              token TEXT PRIMARY KEY,
              user_id TEXT NOT NULL REFERENCES users(id),
              expires_at TEXT NOT NULL,
              created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS employees (
              id TEXT PRIMARY KEY,
              company_id TEXT NOT NULL REFERENCES companies(id),
              branch_id TEXT NOT NULL REFERENCES branches(id),
              name TEXT NOT NULL,
              phone TEXT NOT NULL,
              phone_normalized TEXT NOT NULL,
              area TEXT NOT NULL,
              mode TEXT NOT NULL,
              role TEXT NOT NULL,
              start_time TEXT NOT NULL,
              end_time TEXT NOT NULL,
              vacation_days REAL NOT NULL DEFAULT 0,
              active INTEGER NOT NULL DEFAULT 1
            );
            CREATE TABLE IF NOT EXISTS records (
              id TEXT PRIMARY KEY,
              employee_id TEXT NOT NULL REFERENCES employees(id),
              branch_id TEXT NOT NULL REFERENCES branches(id),
              event TEXT NOT NULL,
              message TEXT NOT NULL,
              location TEXT,
              lat REAL,
              lng REAL,
              distance REAL,
              evidence INTEGER NOT NULL DEFAULT 0,
              suspicious INTEGER NOT NULL DEFAULT 0,
              flags_json TEXT NOT NULL DEFAULT '[]',
              status TEXT NOT NULL,
              timestamp TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS issues (
              id TEXT PRIMARY KEY,
              employee_id TEXT NOT NULL REFERENCES employees(id),
              type TEXT NOT NULL,
              detail TEXT NOT NULL,
              evidence INTEGER NOT NULL DEFAULT 0,
              status TEXT NOT NULL,
              timestamp TEXT NOT NULL,
              resolved_at TEXT
            );
            CREATE TABLE IF NOT EXISTS alerts (
              id TEXT PRIMARY KEY,
              alert_key TEXT UNIQUE,
              employee_id TEXT REFERENCES employees(id),
              type TEXT NOT NULL,
              detail TEXT NOT NULL,
              severity TEXT NOT NULL,
              status TEXT NOT NULL,
              timestamp TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS audit (
              id TEXT PRIMARY KEY,
              action TEXT NOT NULL,
              detail TEXT NOT NULL,
              user_name TEXT NOT NULL,
              role TEXT NOT NULL,
              timestamp TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS chat (
              id TEXT PRIMARY KEY,
              employee_id TEXT REFERENCES employees(id),
              employee_name TEXT NOT NULL,
              message TEXT NOT NULL,
              response TEXT NOT NULL,
              timestamp TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS whatsapp_events (
              wa_message_id TEXT PRIMARY KEY,
              sender_phone TEXT,
              message_type TEXT,
              message_text TEXT,
              raw_payload TEXT NOT NULL,
              created_at TEXT NOT NULL,
              processed_at TEXT NOT NULL,
              status TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS media_attachments (
              id TEXT PRIMARY KEY,
              wa_message_id TEXT REFERENCES whatsapp_events(wa_message_id),
              employee_id TEXT REFERENCES employees(id),
              media_id TEXT,
              type TEXT NOT NULL,
              mime_type TEXT,
              sha256 TEXT,
              filename TEXT,
              caption TEXT,
              local_path TEXT,
              created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS security_tickets (
              id TEXT PRIMARY KEY,
              company_id TEXT NOT NULL REFERENCES companies(id),
              employee_id TEXT REFERENCES employees(id),
              number TEXT NOT NULL UNIQUE,
              type TEXT NOT NULL,
              detail TEXT NOT NULL,
              severity TEXT NOT NULL,
              status TEXT NOT NULL,
              response TEXT NOT NULL,
              source_channel TEXT NOT NULL DEFAULT 'Panel',
              wa_message_id TEXT REFERENCES whatsapp_events(wa_message_id),
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              closed_at TEXT
            );
            CREATE TABLE IF NOT EXISTS security_alerts (
              id TEXT PRIMARY KEY,
              ticket_id TEXT REFERENCES security_tickets(id),
              title TEXT NOT NULL,
              detail TEXT NOT NULL,
              severity TEXT NOT NULL,
              status TEXT NOT NULL,
              created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS security_evidence (
              id TEXT PRIMARY KEY,
              ticket_id TEXT NOT NULL REFERENCES security_tickets(id),
              media_id TEXT,
              kind TEXT NOT NULL,
              mime_type TEXT,
              filename TEXT,
              local_path TEXT,
              sha256 TEXT,
              created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS phishing_templates (
              id TEXT PRIMARY KEY,
              name TEXT NOT NULL,
              category TEXT NOT NULL,
              channel TEXT NOT NULL,
              risk TEXT NOT NULL,
              subject TEXT,
              body TEXT,
              landing_url TEXT,
              active INTEGER NOT NULL DEFAULT 1,
              created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS phishing_campaigns (
              id TEXT PRIMARY KEY,
              company_id TEXT NOT NULL REFERENCES companies(id),
              name TEXT NOT NULL,
              channel TEXT NOT NULL,
              template_id TEXT REFERENCES phishing_templates(id),
              template_name TEXT NOT NULL,
              department TEXT NOT NULL,
              status TEXT NOT NULL,
              sent INTEGER NOT NULL DEFAULT 0,
              clicked INTEGER NOT NULL DEFAULT 0,
              reported INTEGER NOT NULL DEFAULT 0,
              trained INTEGER NOT NULL DEFAULT 0,
              score INTEGER NOT NULL DEFAULT 100,
              created_at TEXT NOT NULL,
              launched_at TEXT,
              monthly_report_json TEXT NOT NULL DEFAULT '{}'
            );
            CREATE TABLE IF NOT EXISTS phishing_targets (
              id TEXT PRIMARY KEY,
              campaign_id TEXT NOT NULL REFERENCES phishing_campaigns(id),
              employee_id TEXT NOT NULL REFERENCES employees(id),
              employee_name TEXT NOT NULL,
              department TEXT NOT NULL,
              phone TEXT NOT NULL,
              email TEXT,
              status TEXT NOT NULL,
              click_token TEXT NOT NULL UNIQUE,
              report_token TEXT NOT NULL UNIQUE,
              training_token TEXT NOT NULL UNIQUE,
              sent_at TEXT,
              clicked_at TEXT,
              reported_at TEXT,
              trained_at TEXT
            );
            CREATE TABLE IF NOT EXISTS phishing_events (
              id TEXT PRIMARY KEY,
              campaign_id TEXT NOT NULL REFERENCES phishing_campaigns(id),
              target_id TEXT REFERENCES phishing_targets(id),
              employee_id TEXT REFERENCES employees(id),
              event TEXT NOT NULL,
              channel TEXT NOT NULL,
              metadata_json TEXT NOT NULL DEFAULT '{}',
              created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS training_assignments (
              id TEXT PRIMARY KEY,
              employee_id TEXT NOT NULL REFERENCES employees(id),
              campaign_id TEXT NOT NULL REFERENCES phishing_campaigns(id),
              status TEXT NOT NULL,
              due_at TEXT NOT NULL,
              completed_at TEXT,
              created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS app_meta (
              key TEXT PRIMARY KEY,
              value TEXT NOT NULL
            );
            """
        )
        ensure_webhook_event_columns(con)
        ensure_indexes(con)
        migrate_legacy_state(con)
        seed_phishing_templates(con)
        migrate_product_meta(con)
        seed_auth(con)


def ensure_webhook_event_columns(con):
    columns = {row["name"] for row in con.execute("PRAGMA table_info(whatsapp_events)")}
    additions = {
        "wa_message_id": "TEXT",
        "sender_phone": "TEXT",
        "message_type": "TEXT",
        "message_text": "TEXT",
        "raw_payload": "TEXT",
        "created_at": "TEXT",
        "processed_at": "TEXT",
        "status": "TEXT",
    }
    for name, definition in additions.items():
        if name not in columns:
            con.execute(f"ALTER TABLE whatsapp_events ADD COLUMN {name} {definition}")
    con.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_whatsapp_events_wa_message_id ON whatsapp_events(wa_message_id)")


def ensure_indexes(con):
    con.executescript(
        """
        CREATE INDEX IF NOT EXISTS idx_branches_company_active ON branches(company_id, active);
        CREATE INDEX IF NOT EXISTS idx_employees_company_branch_active ON employees(company_id, branch_id, active);
        CREATE INDEX IF NOT EXISTS idx_employees_phone_normalized ON employees(phone_normalized);
        CREATE INDEX IF NOT EXISTS idx_records_branch_timestamp ON records(branch_id, timestamp);
        CREATE INDEX IF NOT EXISTS idx_records_employee_timestamp ON records(employee_id, timestamp);
        CREATE INDEX IF NOT EXISTS idx_issues_status_timestamp ON issues(status, timestamp);
        CREATE INDEX IF NOT EXISTS idx_alerts_status_timestamp ON alerts(status, timestamp);
        CREATE INDEX IF NOT EXISTS idx_chat_timestamp ON chat(timestamp);
        CREATE INDEX IF NOT EXISTS idx_security_tickets_company_status_created ON security_tickets(company_id, status, created_at);
        CREATE INDEX IF NOT EXISTS idx_security_alerts_status_created ON security_alerts(status, created_at);
        CREATE INDEX IF NOT EXISTS idx_phishing_campaigns_company_created ON phishing_campaigns(company_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_phishing_targets_campaign ON phishing_targets(campaign_id);
        CREATE INDEX IF NOT EXISTS idx_phishing_targets_tokens ON phishing_targets(campaign_id, click_token, report_token, training_token);
        CREATE INDEX IF NOT EXISTS idx_phishing_events_campaign_created ON phishing_events(campaign_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_training_assignments_campaign_employee ON training_assignments(campaign_id, employee_id);
        """
    )


def migrate_legacy_state(con):
    if con.execute("SELECT COUNT(*) FROM companies").fetchone()[0]:
        return
    legacy = con.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='app_state'").fetchone()
    if legacy:
        row = con.execute("SELECT payload FROM app_state WHERE id = 1").fetchone()
        source = json.loads(row["payload"]) if row else DEFAULT_STATE
    else:
        source = DEFAULT_STATE
    import_state(con, source, replace=True)


def phishing_template_content(template):
    name = template.get("name", "Simulacion DOGUI")
    channel = template.get("channel", "Correo")
    subject = {
        "Factura proveedor": "Factura pendiente de validacion",
        "Validacion bancaria": "Validacion urgente de cuenta",
        "Actualizacion RH": "Actualizacion de expediente RH",
        "Paqueteria retenida": "Paquete retenido por datos incompletos",
        "Aviso SAT": "Aviso de obligaciones fiscales",
    }.get(name, f"{name} - DOGUI")
    body = (
        "Hola {employee_name}, esta es una simulacion controlada de DOGUI. "
        "Si recibes un mensaje real con urgencia, adjuntos o links inesperados, reportalo por WhatsApp. "
        "Liga de prueba: {click_url}. Reportar: {report_url}."
    )
    if channel == "SMS":
        body = "DOGUI simulacion: revisa {click_url}. Si lo detectas, reporta aqui {report_url}."
    if channel == "WhatsApp":
        body = "DOGUI simulacion de seguridad. Revisa esta liga de prueba: {click_url}. Para reportarla usa {report_url}."
    return subject, body


def seed_phishing_templates(con):
    if con.execute("SELECT COUNT(*) FROM phishing_templates").fetchone()[0]:
        return
    for template in DEFAULT_STATE["phishingTemplates"]:
        subject, body = phishing_template_content(template)
        con.execute(
            """
            INSERT INTO phishing_templates
            (id, name, category, channel, risk, subject, body, landing_url, active, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
            """,
            (
                template["id"],
                template["name"],
                template.get("category", "general"),
                template.get("channel", "Correo"),
                template.get("risk", "Media"),
                subject,
                body,
                "/t/{campaign_id}/{target_id}",
                utc_now(),
            ),
        )


def migrate_product_meta(con):
    if not con.execute("SELECT COUNT(*) FROM security_tickets").fetchone()[0]:
        for ticket in row_json(get_meta(con, "security_tickets", "[]"), []):
            employee_id = ticket.get("employeeId") or lookup_employee_id(con, ticket.get("employeeName"))
            company_id = get_meta(con, "selected_company_id", "co-demo")
            created_at = ticket.get("timestamp", utc_now())
            con.execute(
                """
                INSERT OR IGNORE INTO security_tickets
                (id, company_id, employee_id, number, type, detail, severity, status, response, source_channel, wa_message_id, created_at, updated_at, closed_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    ticket.get("id", make_id("sec")),
                    company_id,
                    employee_id,
                    ticket.get("number") or next_ticket_number(con),
                    ticket.get("type", "Reporte"),
                    ticket.get("detail", ""),
                    ticket.get("severity", "Media"),
                    ticket.get("status", "En revision"),
                    ticket.get("response") or security_response_for(ticket.get("type", "Reporte")),
                    ticket.get("sourceChannel", "Demo"),
                    ticket.get("waMessageId"),
                    created_at,
                    ticket.get("updatedAt", created_at),
                    ticket.get("closedAt"),
                ),
            )

    if not con.execute("SELECT COUNT(*) FROM security_alerts").fetchone()[0]:
        for alert in row_json(get_meta(con, "security_alerts", "[]"), []):
            con.execute(
                """
                INSERT OR IGNORE INTO security_alerts
                (id, ticket_id, title, detail, severity, status, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    alert.get("id", make_id("secalert")),
                    alert.get("ticketId"),
                    alert.get("title", "Alerta de seguridad"),
                    alert.get("detail", ""),
                    alert.get("severity", "Media"),
                    alert.get("status", "Activa"),
                    alert.get("timestamp", utc_now()),
                ),
            )

    for template in row_json(get_meta(con, "phishing_templates", "[]"), []):
        subject, body = phishing_template_content(template)
        con.execute(
            """
            INSERT OR IGNORE INTO phishing_templates
            (id, name, category, channel, risk, subject, body, landing_url, active, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
            """,
            (
                template.get("id", make_id("tpl")),
                template.get("name", "Plantilla DOGUI"),
                template.get("category", "general"),
                template.get("channel", "Correo"),
                template.get("risk", "Media"),
                template.get("subject", subject),
                template.get("body", body),
                template.get("landingUrl", "/t/{campaign_id}/{target_id}"),
                utc_now(),
            ),
        )

    if not con.execute("SELECT COUNT(*) FROM phishing_campaigns").fetchone()[0]:
        for campaign in row_json(get_meta(con, "phishing_campaigns", "[]"), []):
            template_name = campaign.get("template", "Plantilla DOGUI")
            template = con.execute("SELECT id FROM phishing_templates WHERE name = ? LIMIT 1", (template_name,)).fetchone()
            sent = int(campaign.get("sent", 0))
            clicked = int(campaign.get("clicked", 0))
            reported = int(campaign.get("reported", 0))
            trained = int(campaign.get("trained", 0))
            score = calculate_resilience_score(sent, clicked, reported)
            created_at = campaign.get("timestamp", utc_now())
            con.execute(
                """
                INSERT OR IGNORE INTO phishing_campaigns
                (id, company_id, name, channel, template_id, template_name, department, status, sent, clicked, reported, trained, score, created_at, launched_at, monthly_report_json)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    campaign.get("id", make_id("camp")),
                    get_meta(con, "selected_company_id", "co-demo"),
                    campaign.get("name", "Campana DOGUI"),
                    campaign.get("channel", "Correo"),
                    template["id"] if template else None,
                    template_name,
                    campaign.get("department", "Todos"),
                    campaign.get("status", "Simulada"),
                    sent,
                    clicked,
                    reported,
                    trained,
                    score,
                    created_at,
                    campaign.get("launchedAt", created_at),
                    json.dumps(campaign.get("monthlyReport", {}), ensure_ascii=False),
                ),
            )


def seed_auth(con):
    if con.execute("SELECT COUNT(*) FROM users").fetchone()[0]:
        return
    salt, digest = hash_password("admin123")
    con.execute(
        """
        INSERT INTO users (id, company_id, email, name, role, password_salt, password_hash, active, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
        """,
        ("usr-admin", "co-demo", "admin@empresa.mx", "Administrador", "Dueno", salt, digest, utc_now()),
    )


def import_state(con, state, replace=False):
    if replace:
        for table in [
            "training_assignments",
            "phishing_events",
            "phishing_targets",
            "phishing_campaigns",
            "security_evidence",
            "security_alerts",
            "security_tickets",
            "media_attachments",
            "chat",
            "audit",
            "alerts",
            "issues",
            "records",
            "employees",
            "branches",
            "policies",
        ]:
            con.execute(f"DELETE FROM {table}")

    for company in state.get("companies", DEFAULT_STATE["companies"]):
        con.execute(
            "INSERT OR REPLACE INTO companies (id, name, created_at) VALUES (?, ?, COALESCE((SELECT created_at FROM companies WHERE id = ?), ?))",
            (company["id"], company["name"], company["id"], utc_now()),
        )

    policy = {**DEFAULT_POLICY, **state.get("policy", {})}
    company_id = state.get("selectedCompanyId", "co-demo")
    con.execute(
        """
        INSERT OR REPLACE INTO policies
        (company_id, tolerance, forgotten_exit_hours, geofence_radius, overtime_after_hours, require_gps, require_selfie)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (
            company_id,
            int(policy["tolerance"]),
            float(policy["forgottenExitHours"]),
            int(policy["geofenceRadius"]),
            float(policy["overtimeAfterHours"]),
            bool_int(policy["requireGps"]),
            bool_int(policy["requireSelfie"]),
        ),
    )

    for branch in state.get("branches", DEFAULT_STATE["branches"]):
        con.execute(
            "INSERT OR REPLACE INTO branches (id, company_id, name, lat, lng, active) VALUES (?, ?, ?, ?, ?, 1)",
            (branch["id"], branch.get("companyId", company_id), branch["name"], float(branch["lat"]), float(branch["lng"])),
        )

    for employee in state.get("employees", DEFAULT_STATE["employees"]):
        con.execute(
            """
            INSERT OR REPLACE INTO employees
            (id, company_id, branch_id, name, phone, phone_normalized, area, mode, role, start_time, end_time, vacation_days, active)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                employee["id"],
                company_id,
                employee.get("branchId") or state.get("selectedBranchId", "br-centro"),
                employee["name"],
                employee.get("phone", ""),
                normalize_phone(employee.get("phone")),
                employee.get("area", "General"),
                employee.get("mode", "Presencial"),
                employee.get("role", "Empleado"),
                employee.get("start", "09:00"),
                employee.get("end", "18:00"),
                float(employee.get("vacationDays", 0)),
                bool_int(employee.get("active", True)),
            ),
        )

    for record in state.get("records", []):
        employee_id = record.get("employeeId")
        if not employee_id or not con.execute("SELECT 1 FROM employees WHERE id = ?", (employee_id,)).fetchone():
            continue
        con.execute(
            """
            INSERT OR REPLACE INTO records
            (id, employee_id, branch_id, event, message, location, lat, lng, distance, evidence, suspicious, flags_json, status, timestamp)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                record.get("id", make_id("rec")),
                employee_id,
                record.get("branchId") or state.get("selectedBranchId", "br-centro"),
                record.get("event", "mensaje"),
                record.get("message", ""),
                record.get("location"),
                record.get("lat"),
                record.get("lng"),
                record.get("distance"),
                bool_int(record.get("evidence", False)),
                bool_int(record.get("suspicious", False)),
                json.dumps(record.get("flags", []), ensure_ascii=False),
                record.get("status", "Registrado"),
                record.get("timestamp", utc_now()),
            ),
        )

    for issue in state.get("issues", []):
        employee_id = issue.get("employeeId")
        if not employee_id or not con.execute("SELECT 1 FROM employees WHERE id = ?", (employee_id,)).fetchone():
            continue
        con.execute(
            """
            INSERT OR REPLACE INTO issues
            (id, employee_id, type, detail, evidence, status, timestamp, resolved_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                issue.get("id", make_id("issue")),
                employee_id,
                issue.get("type", "permiso"),
                issue.get("detail", ""),
                bool_int(issue.get("evidence", False)),
                issue.get("status", "Pendiente"),
                issue.get("timestamp", utc_now()),
                issue.get("resolvedAt"),
            ),
        )

    for alert in state.get("alerts", []):
        employee_id = lookup_employee_id(con, alert.get("employeeName"))
        con.execute(
            """
            INSERT OR REPLACE INTO alerts
            (id, alert_key, employee_id, type, detail, severity, status, timestamp)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                alert.get("id", make_id("alert")),
                alert.get("key"),
                employee_id,
                alert.get("type", "Alerta"),
                alert.get("detail", ""),
                alert.get("severity", "warn"),
                alert.get("status", "Abierta"),
                alert.get("timestamp", utc_now()),
            ),
        )

    for item in state.get("audit", []):
        con.execute(
            "INSERT OR REPLACE INTO audit (id, action, detail, user_name, role, timestamp) VALUES (?, ?, ?, ?, ?, ?)",
            (item.get("id", make_id("audit")), item.get("action", ""), item.get("detail", ""), item.get("user", "Sistema"), item.get("role", "Sistema"), item.get("timestamp", utc_now())),
        )

    for item in state.get("chat", []):
        employee_id = lookup_employee_id(con, item.get("employeeName"))
        con.execute(
            "INSERT OR REPLACE INTO chat (id, employee_id, employee_name, message, response, timestamp) VALUES (?, ?, ?, ?, ?, ?)",
            (item.get("id", make_id("chat")), employee_id, item.get("employeeName", "Empleado"), item.get("message", ""), item.get("response", ""), item.get("timestamp", utc_now())),
        )

    con.execute("INSERT OR REPLACE INTO app_meta (key, value) VALUES ('selected_company_id', ?)", (company_id,))
    con.execute("INSERT OR REPLACE INTO app_meta (key, value) VALUES ('selected_branch_id', ?)", (state.get("selectedBranchId", "br-centro"),))
    con.execute("INSERT OR REPLACE INTO app_meta (key, value) VALUES ('security_tickets', ?)", (json.dumps(state.get("securityTickets", []), ensure_ascii=False),))
    con.execute("INSERT OR REPLACE INTO app_meta (key, value) VALUES ('security_alerts', ?)", (json.dumps(state.get("securityAlerts", []), ensure_ascii=False),))
    con.execute("INSERT OR REPLACE INTO app_meta (key, value) VALUES ('phishing_templates', ?)", (json.dumps(state.get("phishingTemplates", DEFAULT_STATE["phishingTemplates"]), ensure_ascii=False),))
    con.execute("INSERT OR REPLACE INTO app_meta (key, value) VALUES ('phishing_campaigns', ?)", (json.dumps(state.get("phishingCampaigns", []), ensure_ascii=False),))


def lookup_employee_id(con, employee_name):
    if not employee_name:
        return None
    row = con.execute("SELECT id FROM employees WHERE name = ? LIMIT 1", (employee_name,)).fetchone()
    return row["id"] if row else None


def get_meta(con, key, default):
    row = con.execute("SELECT value FROM app_meta WHERE key = ?", (key,)).fetchone()
    return row["value"] if row else default


def security_response_for(incident_type):
    responses = {
        "Link sospechoso": "No abras el enlace. DOGUI creo un ticket y seguridad revisara el dominio antes de autorizar cualquier accion.",
        "Correo falso": "No respondas el correo ni descargues adjuntos. Reenvia evidencia y espera confirmacion de seguridad.",
        "Archivo raro": "No abras el archivo. Aisla el mensaje y espera revision del equipo de seguridad.",
        "Intento de fraude": "Deten cualquier pago o transferencia. Seguridad y finanzas revisaran el intento.",
        "Check-in de seguridad": "Check-in recibido. Si estas en una situacion activa, comparte ubicacion y evidencia.",
    }
    return responses.get(incident_type, "Reporte recibido. Espera revision antes de realizar cualquier accion.")


def classify_security_report(message, message_type="text", media=None):
    text = (message or "").lower()
    if any(term in text for term in ["check-in seguridad", "checkin seguridad", "seguridad ok", "sos seguridad"]):
        return "Check-in de seguridad", "Media"
    if any(term in text for term in ["fraude", "estafa", "suplantacion", "transferencia", "deposito", "pago urgente", "ceo fraud"]):
        return "Intento de fraude", "Alta"
    if message_type == "document" or media:
        filename = (media or {}).get("filename", "").lower()
        if any(ext in filename for ext in [".zip", ".rar", ".exe", ".scr", ".bat", ".js", ".docm", ".xlsm"]) or any(term in text for term in ["archivo raro", "adjunto raro", "zip", "rar", "exe"]):
            return "Archivo raro", "Alta" if any(ext in filename for ext in [".exe", ".scr", ".bat", ".js"]) else "Media"
    if any(term in text for term in ["link sospechoso", "liga sospechosa", "http://", "https://", "bit.ly", "tinyurl", "enlace", "link"]):
        return "Link sospechoso", "Alta"
    if any(term in text for term in ["correo falso", "email falso", "mail falso", "banco", "sat", "factura", "proveedor", "contrasena", "password", "token"]):
        return "Correo falso", "Alta"
    return None, None


def next_ticket_number(con):
    count = con.execute("SELECT COUNT(*) FROM security_tickets").fetchone()[0] + 1
    return f"DG-{count:04d}"


def create_security_ticket(con, employee, incident_type, detail, severity="Media", source_channel="Panel", wa_message_id=None, media=None):
    now_value = utc_now()
    ticket_id = make_id("sec")
    response = security_response_for(incident_type)
    status = "Prioridad SOC" if severity == "Alta" else "En revision"
    con.execute(
        """
        INSERT INTO security_tickets
        (id, company_id, employee_id, number, type, detail, severity, status, response, source_channel, wa_message_id, created_at, updated_at, closed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
        """,
        (
            ticket_id,
            employee["company_id"],
            employee["id"],
            next_ticket_number(con),
            incident_type,
            detail,
            severity,
            status,
            response,
            source_channel,
            wa_message_id,
            now_value,
            now_value,
        ),
    )
    alert_id = make_id("secalert")
    con.execute(
        """
        INSERT INTO security_alerts (id, ticket_id, title, detail, severity, status, created_at)
        VALUES (?, ?, ?, ?, ?, 'Activa', ?)
        """,
        (
            alert_id,
            ticket_id,
            f"{severity}: {incident_type}",
            f"{employee['name']} reporto: {detail}",
            severity,
            now_value,
        ),
    )
    if media:
        con.execute(
            """
            INSERT INTO security_evidence
            (id, ticket_id, media_id, kind, mime_type, filename, local_path, sha256, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                make_id("secev"),
                ticket_id,
                media.get("id"),
                media.get("type", "media"),
                media.get("mime_type"),
                media.get("filename"),
                media.get("local_path"),
                media.get("sha256"),
                now_value,
            ),
        )
    create_chat(con, employee, detail, response)
    add_audit(con, "Ticket de seguridad creado", f"{incident_type} - {employee['name']}")
    return get_security_ticket(con, ticket_id), get_security_alert(con, alert_id)


def get_security_ticket(con, ticket_id):
    row = con.execute(
        """
        SELECT st.*, e.name AS employee_name, e.area AS department
        FROM security_tickets st
        LEFT JOIN employees e ON e.id = st.employee_id
        WHERE st.id = ?
        """,
        (ticket_id,),
    ).fetchone()
    if not row:
        return None
    return {
        "id": row["id"],
        "number": row["number"],
        "employeeId": row["employee_id"],
        "employeeName": row["employee_name"] or "Sistema",
        "department": row["department"] or "General",
        "type": row["type"],
        "detail": row["detail"],
        "severity": row["severity"],
        "status": row["status"],
        "response": row["response"],
        "sourceChannel": row["source_channel"],
        "waMessageId": row["wa_message_id"],
        "timestamp": row["created_at"],
        "updatedAt": row["updated_at"],
        "closedAt": row["closed_at"],
    }


def list_security_tickets(con):
    rows = con.execute(
        """
        SELECT st.id
        FROM security_tickets st
        ORDER BY st.created_at DESC
        LIMIT 300
        """
    )
    return [get_security_ticket(con, row["id"]) for row in rows]


def get_security_alert(con, alert_id):
    row = con.execute("SELECT * FROM security_alerts WHERE id = ?", (alert_id,)).fetchone()
    if not row:
        return None
    return {
        "id": row["id"],
        "ticketId": row["ticket_id"],
        "title": row["title"],
        "detail": row["detail"],
        "severity": row["severity"],
        "status": row["status"],
        "timestamp": row["created_at"],
    }


def list_security_alerts(con):
    rows = con.execute("SELECT id FROM security_alerts ORDER BY created_at DESC LIMIT 200")
    return [get_security_alert(con, row["id"]) for row in rows]


def list_phishing_templates(con):
    return [
        {
            "id": row["id"],
            "name": row["name"],
            "category": row["category"],
            "channel": row["channel"],
            "risk": row["risk"],
            "subject": row["subject"],
            "body": row["body"],
            "landingUrl": row["landing_url"],
            "active": bool(row["active"]),
        }
        for row in con.execute("SELECT * FROM phishing_templates WHERE active = 1 ORDER BY name")
    ]


def calculate_resilience_score(sent, clicked, reported):
    if not sent:
        return 100
    click_rate = round((clicked / sent) * 100)
    report_rate = round((reported / sent) * 35)
    return max(0, min(100, 100 - click_rate + report_rate))


def list_phishing_campaigns(con):
    return [
        {
            "id": row["id"],
            "name": row["name"],
            "channel": row["channel"],
            "templateId": row["template_id"],
            "template": row["template_name"],
            "department": row["department"],
            "status": row["status"],
            "sent": row["sent"],
            "clicked": row["clicked"],
            "reported": row["reported"],
            "trained": row["trained"],
            "score": row["score"],
            "timestamp": row["created_at"],
            "launchedAt": row["launched_at"],
            "monthlyReport": row_json(row["monthly_report_json"], {}),
        }
        for row in con.execute("SELECT * FROM phishing_campaigns ORDER BY created_at DESC LIMIT 200")
    ]


def build_state(con):
    selected_company_id = get_meta(con, "selected_company_id", "co-demo")
    selected_branch_id = get_meta(con, "selected_branch_id", "br-centro")
    report = row_json(get_meta(con, "report", "{}"), {})
    if not report:
        today = datetime.now().date().isoformat()
        report = {"from": today, "to": today, "area": "Todas"}

    companies = [dict(row) for row in con.execute("SELECT id, name FROM companies ORDER BY name")]
    branches = [
        {"id": row["id"], "companyId": row["company_id"], "name": row["name"], "lat": row["lat"], "lng": row["lng"]}
        for row in con.execute("SELECT * FROM branches WHERE active = 1 ORDER BY name")
    ]
    policy_row = con.execute("SELECT * FROM policies WHERE company_id = ?", (selected_company_id,)).fetchone()
    policy = DEFAULT_POLICY.copy()
    if policy_row:
        policy = {
            "tolerance": policy_row["tolerance"],
            "forgottenExitHours": policy_row["forgotten_exit_hours"],
            "geofenceRadius": policy_row["geofence_radius"],
            "overtimeAfterHours": policy_row["overtime_after_hours"],
            "requireGps": bool(policy_row["require_gps"]),
            "requireSelfie": bool(policy_row["require_selfie"]),
        }
    employees = [
        {
            "id": row["id"],
            "name": row["name"],
            "phone": row["phone"],
            "area": row["area"],
            "branchId": row["branch_id"],
            "mode": row["mode"],
            "role": row["role"],
            "start": row["start_time"],
            "end": row["end_time"],
            "vacationDays": row["vacation_days"],
            "active": bool(row["active"]),
        }
        for row in con.execute("SELECT * FROM employees ORDER BY active DESC, name")
    ]
    records = [
        {
            "id": row["id"],
            "employeeId": row["employee_id"],
            "employeeName": row["employee_name"],
            "branchId": row["branch_id"],
            "event": row["event"],
            "message": row["message"],
            "location": row["location"],
            "lat": row["lat"],
            "lng": row["lng"],
            "distance": row["distance"],
            "evidence": bool(row["evidence"]),
            "suspicious": bool(row["suspicious"]),
            "flags": row_json(row["flags_json"], []),
            "status": row["status"],
            "timestamp": row["timestamp"],
        }
        for row in con.execute(
            """
            SELECT r.*, e.name AS employee_name
            FROM records r JOIN employees e ON e.id = r.employee_id
            ORDER BY r.timestamp DESC LIMIT 500
            """
        )
    ]
    issues = [
        {
            "id": row["id"],
            "employeeId": row["employee_id"],
            "employeeName": row["employee_name"],
            "type": row["type"],
            "detail": row["detail"],
            "evidence": bool(row["evidence"]),
            "status": row["status"],
            "timestamp": row["timestamp"],
            "resolvedAt": row["resolved_at"],
        }
        for row in con.execute(
            """
            SELECT i.*, e.name AS employee_name
            FROM issues i JOIN employees e ON e.id = i.employee_id
            ORDER BY i.timestamp DESC
            """
        )
    ]
    alerts = [
        {
            "id": row["id"],
            "key": row["alert_key"],
            "employeeName": row["employee_name"] or "Sistema",
            "type": row["type"],
            "detail": row["detail"],
            "severity": row["severity"],
            "status": row["status"],
            "timestamp": row["timestamp"],
        }
        for row in con.execute(
            """
            SELECT a.*, e.name AS employee_name
            FROM alerts a LEFT JOIN employees e ON e.id = a.employee_id
            ORDER BY a.timestamp DESC
            """
        )
    ]
    audit = [
        {"id": row["id"], "action": row["action"], "detail": row["detail"], "user": row["user_name"], "role": row["role"], "timestamp": row["timestamp"]}
        for row in con.execute("SELECT * FROM audit ORDER BY timestamp DESC LIMIT 300")
    ]
    chat = [
        {"id": row["id"], "employeeName": row["employee_name"], "message": row["message"], "response": row["response"], "timestamp": row["timestamp"]}
        for row in con.execute("SELECT * FROM chat ORDER BY timestamp DESC LIMIT 100")
    ]
    return {
        "companies": companies,
        "selectedCompanyId": selected_company_id,
        "branches": branches,
        "selectedBranchId": selected_branch_id,
        "policy": policy,
        "employees": employees,
        "records": records,
        "issues": issues,
        "alerts": alerts,
        "audit": audit,
        "chat": chat,
        "securityTickets": list_security_tickets(con),
        "securityAlerts": list_security_alerts(con),
        "phishingTemplates": list_phishing_templates(con),
        "phishingCampaigns": list_phishing_campaigns(con),
        "report": report,
    }


def save_state(state):
    with connect() as con:
        import_state(con, state, replace=True)
        seed_phishing_templates(con)
        migrate_product_meta(con)


def classify_event(message):
    text = (message or "").lower().strip()
    if text.startswith(("entrar", "entrada", "inicio")):
        return "entrada"
    if text.startswith(("salir", "salida", "fin")):
        return "salida"
    if text.startswith(("descanso", "comida")):
        return "descanso"
    if text.startswith(("regreso", "volver")):
        return "regreso"
    if "vacaciones" in text:
        return "vacaciones"
    if "permiso" in text:
        return "permiso"
    if "incapacidad" in text:
        return "incapacidad"
    if "saldo" in text:
        return "saldo"
    return "mensaje"


def find_employee_by_phone(con, phone):
    row = con.execute("SELECT * FROM employees WHERE active = 1 AND phone_normalized = ? LIMIT 1", (normalize_phone(phone),)).fetchone()
    return row


def add_audit(con, action, detail, user_name="Sistema", role="Sistema"):
    con.execute(
        "INSERT INTO audit (id, action, detail, user_name, role, timestamp) VALUES (?, ?, ?, ?, ?, ?)",
        (make_id("audit"), action, detail, user_name, role, utc_now()),
    )


def create_session(con, user):
    token = secrets.token_urlsafe(32)
    expires_at = (datetime.now(timezone.utc) + timedelta(days=SESSION_DAYS)).isoformat()
    con.execute("INSERT INTO sessions (token, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)", (token, user["id"], expires_at, utc_now()))
    return token, expires_at


def get_user_from_token(con, token):
    if not token:
        return None
    row = con.execute(
        """
        SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token = ? AND s.expires_at > ? AND u.active = 1
        """,
        (token, utc_now()),
    ).fetchone()
    return row


def create_record(con, employee, event, message, status, location="WhatsApp Cloud API", lat=None, lng=None, distance=None, evidence=False, flags=None):
    flags = flags or []
    record_id = make_id("rec")
    con.execute(
        """
        INSERT INTO records
        (id, employee_id, branch_id, event, message, location, lat, lng, distance, evidence, suspicious, flags_json, status, timestamp)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            record_id,
            employee["id"],
            employee["branch_id"],
            event,
            message,
            location,
            lat,
            lng,
            distance,
            bool_int(evidence),
            bool_int(bool(flags)),
            json.dumps(flags, ensure_ascii=False),
            status,
            utc_now(),
        ),
    )
    return record_id


def create_issue(con, employee, event, message, evidence=False):
    con.execute(
        "INSERT INTO issues (id, employee_id, type, detail, evidence, status, timestamp) VALUES (?, ?, ?, ?, ?, 'Pendiente', ?)",
        (make_id("issue"), employee["id"], event, message, bool_int(evidence), utc_now()),
    )


def create_chat(con, employee, message, response):
    con.execute(
        "INSERT INTO chat (id, employee_id, employee_name, message, response, timestamp) VALUES (?, ?, ?, ?, ?, ?)",
        (make_id("chat"), employee["id"], employee["name"], message, response, utc_now()),
    )


def process_business_message(sender_phone, message_text, raw_message, message_type="text", location=None, media=None):
    wa_id = raw_message.get("id") or make_id("wa")
    with connect() as con:
        existing = con.execute("SELECT status FROM whatsapp_events WHERE wa_message_id = ?", (wa_id,)).fetchone()
        if existing:
            return {"status": "duplicate", "waMessageId": wa_id}

        con.execute(
            """
            INSERT INTO whatsapp_events (wa_message_id, sender_phone, message_type, message_text, raw_payload, created_at, processed_at, status)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'processing')
            """,
            (wa_id, sender_phone, message_type, message_text, json.dumps(raw_message, ensure_ascii=False), utc_now(), utc_now()),
        )

        employee = find_employee_by_phone(con, sender_phone)
        if not employee:
            response = "Tu numero no esta autorizado para checar asistencia. Contacta a RRHH."
            con.execute("UPDATE whatsapp_events SET status = 'unknown_phone' WHERE wa_message_id = ?", (wa_id,))
            add_audit(con, "WhatsApp no autorizado", sender_phone)
            send_whatsapp_text(sender_phone, response)
            return {"status": "unknown_phone", "response": response}

        event = classify_event(message_text)
        evidence = bool(media)
        if media:
            store_media_attachment(con, wa_id, employee["id"], media)

        security_type, security_severity = classify_security_report(message_text, message_type, media)
        if event == "mensaje" and security_type:
            detail = message_text or (media or {}).get("filename") or f"Reporte recibido por {message_type}"
            ticket, _ = create_security_ticket(
                con,
                employee,
                security_type,
                detail,
                security_severity,
                source_channel="WhatsApp",
                wa_message_id=wa_id,
                media=media,
            )
            response = f"{ticket['number']} creado. {ticket['response']}"
            add_audit(con, "Webhook Security Assistant", f"{employee['name']}: {security_type}", "Meta", "Sistema")
            con.execute("UPDATE whatsapp_events SET status = 'security_ticket' WHERE wa_message_id = ?", (wa_id,))
            send_whatsapp_text(sender_phone, response)
            return {"status": "security_ticket", "ticket": ticket, "response": response, "waMessageId": wa_id}

        status = "Registrado"
        flags = []
        location_text = "WhatsApp Cloud API"
        lat = lng = None
        if location:
            lat = location.get("latitude")
            lng = location.get("longitude")
            location_text = location.get("name") or location.get("address") or f"{lat}, {lng}"

        if message_type in ["image", "document", "video", "audio"] and not message_text:
            event = "evidencia"
            status = "Evidencia"

        if event == "saldo":
            response = f"{employee['name']}, tienes {employee['vacation_days']} dias de vacaciones disponibles."
        else:
            if event == "entrada":
                status = "A tiempo"
            if event in ["vacaciones", "permiso", "incapacidad"]:
                create_issue(con, employee, event, message_text, evidence)
                status = "Incidencia"
            create_record(con, employee, event, message_text or f"Mensaje {message_type}", status, location_text, lat, lng, None, evidence, flags)
            response = f"{employee['name']}, registramos tu {event} con estado: {status}."

        create_chat(con, employee, message_text or f"Mensaje {message_type}", response)
        add_audit(con, "Webhook WhatsApp", f"{employee['name']}: {message_text or message_type}", "Meta", "Sistema")
        con.execute("UPDATE whatsapp_events SET status = 'processed' WHERE wa_message_id = ?", (wa_id,))
        send_whatsapp_text(sender_phone, response)
        return {"status": "ok", "event": event, "response": response, "waMessageId": wa_id}


def store_media_attachment(con, wa_id, employee_id, media):
    local_path = None
    media_id = media.get("id")
    if media_id and WHATSAPP_TOKEN:
        local_path = download_whatsapp_media(media_id, media.get("mime_type"))
    media["local_path"] = local_path
    con.execute(
        """
        INSERT OR REPLACE INTO media_attachments
        (id, wa_message_id, employee_id, media_id, type, mime_type, sha256, filename, caption, local_path, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            make_id("media"),
            wa_id,
            employee_id,
            media_id,
            media.get("type", "media"),
            media.get("mime_type"),
            media.get("sha256"),
            media.get("filename"),
            media.get("caption"),
            local_path,
            utc_now(),
        ),
    )
    return local_path


def download_whatsapp_media(media_id, mime_type=None):
    info_url = f"https://graph.facebook.com/{GRAPH_API_VERSION}/{media_id}"
    req = urllib.request.Request(info_url, headers={"Authorization": f"Bearer {WHATSAPP_TOKEN}"})
    try:
        with urllib.request.urlopen(req, timeout=10) as res:
            meta = json.loads(res.read().decode("utf-8"))
        media_url = meta.get("url")
        if not media_url:
            return None
        media_req = urllib.request.Request(media_url, headers={"Authorization": f"Bearer {WHATSAPP_TOKEN}"})
        with urllib.request.urlopen(media_req, timeout=20) as res:
            content = res.read()
            mime_type = mime_type or res.headers.get_content_type()
        ext = mimetypes.guess_extension(mime_type or "") or ".bin"
        target = MEDIA_DIR / f"{media_id}{ext}"
        target.write_bytes(content)
        return str(target)
    except (urllib.error.URLError, OSError, json.JSONDecodeError):
        return None


def send_whatsapp_text(to_phone, body):
    if not WHATSAPP_TOKEN or not WHATSAPP_PHONE_NUMBER_ID:
        return {"sent": False, "reason": "WHATSAPP_TOKEN/WHATSAPP_PHONE_NUMBER_ID not configured"}
    url = f"https://graph.facebook.com/{GRAPH_API_VERSION}/{WHATSAPP_PHONE_NUMBER_ID}/messages"
    payload = {
        "messaging_product": "whatsapp",
        "to": normalize_phone(to_phone),
        "type": "text",
        "text": {"preview_url": False, "body": body},
    }
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Authorization": f"Bearer {WHATSAPP_TOKEN}", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as res:
            return {"sent": True, "status": res.status, "body": res.read().decode("utf-8")}
    except urllib.error.URLError as exc:
        return {"sent": False, "reason": str(exc)}


def public_base_url(headers=None):
    if PUBLIC_BASE_URL:
        return PUBLIC_BASE_URL
    host = (headers or {}).get("Host", f"127.0.0.1:{PORT}")
    scheme = "https" if (headers or {}).get("X-Forwarded-Proto") == "https" else "http"
    return f"{scheme}://{host}".rstrip("/")


def create_phishing_campaign(con, payload, company_id):
    template_value = payload.get("templateId") or payload.get("template") or payload.get("templateName")
    template = con.execute(
        """
        SELECT * FROM phishing_templates
        WHERE id = ? OR name = ?
        ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END
        LIMIT 1
        """,
        (template_value, template_value, template_value),
    ).fetchone()
    if not template:
        template = con.execute("SELECT * FROM phishing_templates ORDER BY name LIMIT 1").fetchone()
    department = payload.get("department", "Todos")
    campaign_id = make_id("camp")
    created_at = utc_now()
    con.execute(
        """
        INSERT INTO phishing_campaigns
        (id, company_id, name, channel, template_id, template_name, department, status, sent, clicked, reported, trained, score, created_at, launched_at, monthly_report_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'Borrador', 0, 0, 0, 0, 100, ?, NULL, '{}')
        """,
        (
            campaign_id,
            company_id,
            payload.get("name", f"Campana {created_at[:10]}"),
            payload.get("channel") or template["channel"],
            template["id"],
            template["name"],
            department,
            created_at,
        ),
    )
    target_emails = payload.get("targetEmails", {}) or {}
    employees = con.execute(
        """
        SELECT * FROM employees
        WHERE active = 1 AND company_id = ? AND (? = 'Todos' OR area = ?)
        ORDER BY name
        """,
        (company_id, department, department),
    ).fetchall()
    for employee in employees:
        con.execute(
            """
            INSERT INTO phishing_targets
            (id, campaign_id, employee_id, employee_name, department, phone, email, status, click_token, report_token, training_token, sent_at, clicked_at, reported_at, trained_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'Pendiente', ?, ?, ?, NULL, NULL, NULL, NULL)
            """,
            (
                make_id("target"),
                campaign_id,
                employee["id"],
                employee["name"],
                employee["area"],
                employee["phone"],
                target_emails.get(employee["id"]),
                secrets.token_urlsafe(14),
                secrets.token_urlsafe(14),
                secrets.token_urlsafe(14),
            ),
        )
    add_audit(con, "Campana phishing creada", payload.get("name", campaign_id))
    return get_phishing_campaign(con, campaign_id)


def get_phishing_campaign(con, campaign_id):
    row = con.execute("SELECT * FROM phishing_campaigns WHERE id = ?", (campaign_id,)).fetchone()
    if not row:
        return None
    return {
        "id": row["id"],
        "name": row["name"],
        "channel": row["channel"],
        "templateId": row["template_id"],
        "template": row["template_name"],
        "department": row["department"],
        "status": row["status"],
        "sent": row["sent"],
        "clicked": row["clicked"],
        "reported": row["reported"],
        "trained": row["trained"],
        "score": row["score"],
        "timestamp": row["created_at"],
        "launchedAt": row["launched_at"],
        "monthlyReport": row_json(row["monthly_report_json"], {}),
    }


def render_phishing_body(template, target, campaign, base_url):
    click_url = f"{base_url}/t/{campaign['id']}/{target['id']}"
    report_url = f"{base_url}/r/{campaign['id']}/{target['id']}"
    training_url = f"{base_url}/training/{campaign['id']}/{target['id']}"
    body = template["body"] or phishing_template_content(template)[1]
    return body.format(
        employee_name=target["employee_name"],
        campaign_name=campaign["name"],
        click_url=click_url,
        report_url=report_url,
        training_url=training_url,
    )


def deliver_phishing_message(channel, target, subject, body):
    if channel == "WhatsApp":
        if WHATSAPP_TOKEN and WHATSAPP_PHONE_NUMBER_ID:
            return send_whatsapp_text(target["phone"], body)
        return {"sent": True, "simulated": True, "provider": "Meta WhatsApp", "reason": "WHATSAPP_TOKEN/WHATSAPP_PHONE_NUMBER_ID not configured"}
    if channel == "SMS":
        if TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN and TWILIO_FROM:
            return send_sms_twilio(target["phone"], body)
        return {"sent": True, "simulated": True, "provider": "Twilio SMS", "reason": "TWILIO_* not configured"}
    if SENDGRID_API_KEY and target["email"]:
        return send_email_sendgrid(target["email"], subject, body)
    return {"sent": True, "simulated": True, "provider": "SendGrid", "reason": "SENDGRID_API_KEY or target email not configured"}


def send_email_sendgrid(to_email, subject, body):
    payload = {
        "personalizations": [{"to": [{"email": to_email}]}],
        "from": {"email": EMAIL_FROM},
        "subject": subject,
        "content": [{"type": "text/plain", "value": body}],
    }
    req = urllib.request.Request(
        "https://api.sendgrid.com/v3/mail/send",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Authorization": f"Bearer {SENDGRID_API_KEY}", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=12) as res:
            return {"sent": 200 <= res.status < 300, "status": res.status, "provider": "SendGrid"}
    except urllib.error.URLError as exc:
        return {"sent": False, "provider": "SendGrid", "reason": str(exc)}


def send_sms_twilio(to_phone, body):
    url = f"https://api.twilio.com/2010-04-01/Accounts/{TWILIO_ACCOUNT_SID}/Messages.json"
    payload = urllib.parse.urlencode({"From": TWILIO_FROM, "To": f"+{normalize_phone(to_phone)}", "Body": body}).encode("utf-8")
    basic = base64.b64encode(f"{TWILIO_ACCOUNT_SID}:{TWILIO_AUTH_TOKEN}".encode("utf-8")).decode("ascii")
    req = urllib.request.Request(
        url,
        data=payload,
        headers={"Authorization": f"Basic {basic}", "Content-Type": "application/x-www-form-urlencoded"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=12) as res:
            return {"sent": 200 <= res.status < 300, "status": res.status, "provider": "Twilio SMS"}
    except urllib.error.URLError as exc:
        return {"sent": False, "provider": "Twilio SMS", "reason": str(exc)}


def launch_phishing_campaign(con, campaign_id, base_url):
    campaign = con.execute("SELECT * FROM phishing_campaigns WHERE id = ?", (campaign_id,)).fetchone()
    if not campaign:
        return None
    template = con.execute("SELECT * FROM phishing_templates WHERE id = ?", (campaign["template_id"],)).fetchone()
    targets = con.execute("SELECT * FROM phishing_targets WHERE campaign_id = ? ORDER BY employee_name", (campaign_id,)).fetchall()
    results = []
    launched_at = utc_now()
    for target in targets:
        body = render_phishing_body(template, target, campaign, base_url)
        subject = template["subject"] or f"DOGUI - {campaign['name']}"
        delivery = deliver_phishing_message(campaign["channel"], target, subject, body)
        con.execute("UPDATE phishing_targets SET status = 'Enviado', sent_at = COALESCE(sent_at, ?) WHERE id = ?", (launched_at, target["id"]))
        record_phishing_event(con, campaign_id, target["id"], target["employee_id"], "sent", campaign["channel"], delivery)
        results.append({"targetId": target["id"], "employeeName": target["employee_name"], **delivery})
    con.execute("UPDATE phishing_campaigns SET status = 'Activa', launched_at = COALESCE(launched_at, ?) WHERE id = ?", (launched_at, campaign_id))
    recalculate_campaign_metrics(con, campaign_id)
    add_audit(con, "Campana phishing lanzada", campaign["name"])
    return {"campaign": get_phishing_campaign(con, campaign_id), "delivery": results}


def record_phishing_event(con, campaign_id, target_id, employee_id, event, channel, metadata=None):
    con.execute(
        """
        INSERT INTO phishing_events (id, campaign_id, target_id, employee_id, event, channel, metadata_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (make_id("phevent"), campaign_id, target_id, employee_id, event, channel, json.dumps(metadata or {}, ensure_ascii=False), utc_now()),
    )


def recalculate_campaign_metrics(con, campaign_id):
    row = con.execute(
        """
        SELECT
          COUNT(sent_at) AS sent,
          COUNT(clicked_at) AS clicked,
          COUNT(reported_at) AS reported,
          COUNT(trained_at) AS trained
        FROM phishing_targets
        WHERE campaign_id = ?
        """,
        (campaign_id,),
    ).fetchone()
    sent = row["sent"] or 0
    clicked = row["clicked"] or 0
    reported = row["reported"] or 0
    trained = row["trained"] or 0
    score = calculate_resilience_score(sent, clicked, reported)
    con.execute(
        "UPDATE phishing_campaigns SET sent = ?, clicked = ?, reported = ?, trained = ?, score = ? WHERE id = ?",
        (sent, clicked, reported, trained, score, campaign_id),
    )


def resolve_phishing_target(con, campaign_id, target_value):
    return con.execute(
        """
        SELECT * FROM phishing_targets
        WHERE campaign_id = ?
          AND (id = ? OR employee_id = ? OR click_token = ? OR report_token = ? OR training_token = ?)
        LIMIT 1
        """,
        (campaign_id, target_value, target_value, target_value, target_value, target_value),
    ).fetchone()


def track_phishing_event(con, campaign_id, target_value, event, channel="Landing", metadata=None):
    target = resolve_phishing_target(con, campaign_id, target_value)
    if not target:
        return None
    now_value = utc_now()
    fields = {
        "clicked": ("clicked_at", "Clic registrado"),
        "reported": ("reported_at", "Reportado"),
        "trained": ("trained_at", "Capacitado"),
    }
    field, status = fields[event]
    if not target[field]:
        con.execute(f"UPDATE phishing_targets SET {field} = ?, status = ? WHERE id = ?", (now_value, status, target["id"]))
        if event == "clicked":
            due_at = (datetime.now(timezone.utc) + timedelta(days=7)).isoformat()
            con.execute(
                """
                INSERT INTO training_assignments (id, employee_id, campaign_id, status, due_at, completed_at, created_at)
                VALUES (?, ?, ?, 'Pendiente', ?, NULL, ?)
                """,
                (make_id("train"), target["employee_id"], campaign_id, due_at, now_value),
            )
        if event == "trained":
            con.execute(
                "UPDATE training_assignments SET status = 'Completada', completed_at = ? WHERE employee_id = ? AND campaign_id = ? AND completed_at IS NULL",
                (now_value, target["employee_id"], campaign_id),
            )
    record_phishing_event(con, campaign_id, target["id"], target["employee_id"], event, channel, metadata)
    recalculate_campaign_metrics(con, campaign_id)
    return con.execute("SELECT * FROM phishing_targets WHERE id = ?", (target["id"],)).fetchone()


def build_monthly_phishing_report(con, month=None):
    month = month or datetime.now().strftime("%Y-%m")
    rows = con.execute("SELECT * FROM phishing_campaigns WHERE substr(created_at, 1, 7) = ? ORDER BY created_at DESC", (month,)).fetchall()
    totals = {"sent": 0, "clicked": 0, "reported": 0, "trained": 0}
    departments = {}
    campaigns = []
    for row in rows:
        campaign = get_phishing_campaign(con, row["id"])
        campaigns.append(campaign)
        for key in totals:
            totals[key] += campaign[key]
        dept = departments.setdefault(campaign["department"], {"sent": 0, "clicked": 0, "reported": 0, "trained": 0, "score": 100})
        for key in ["sent", "clicked", "reported", "trained"]:
            dept[key] += campaign[key]
        dept["score"] = calculate_resilience_score(dept["sent"], dept["clicked"], dept["reported"])
    totals["clickRate"] = round((totals["clicked"] / totals["sent"]) * 100) if totals["sent"] else 0
    totals["reportRate"] = round((totals["reported"] / totals["sent"]) * 100) if totals["sent"] else 0
    totals["trainingRate"] = round((totals["trained"] / totals["sent"]) * 100) if totals["sent"] else 0
    totals["score"] = calculate_resilience_score(totals["sent"], totals["clicked"], totals["reported"])
    return {"month": month, "totals": totals, "departments": departments, "campaigns": campaigns}


def training_page(title, body, action_url=None):
    action = f'<a class="button" href="{action_url}">Completar capacitacion</a>' if action_url else ""
    return f"""<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>{title}</title>
  <style>
    body {{ margin:0; min-height:100vh; display:grid; place-items:center; font-family:Arial, sans-serif; background:#0f172a; color:#e5eefb; }}
    main {{ width:min(680px, calc(100% - 32px)); background:#111c33; border:1px solid #2b3b58; border-radius:18px; padding:32px; box-shadow:0 24px 80px rgba(0,0,0,.35); }}
    h1 {{ margin:0 0 12px; font-size:32px; }}
    p {{ line-height:1.55; color:#b7c7dc; }}
    .button {{ display:inline-block; margin-top:14px; background:#2dd4bf; color:#09211f; padding:12px 18px; border-radius:10px; text-decoration:none; font-weight:700; }}
  </style>
</head>
<body><main><h1>{title}</h1><p>{body}</p>{action}</main></body>
</html>"""


def verify_meta_signature(headers, body):
    if not META_APP_SECRET:
        return True
    signature = headers.get("X-Hub-Signature-256", "")
    if not signature.startswith("sha256="):
        return False
    expected = hmac.new(META_APP_SECRET.encode("utf-8"), body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(signature[7:], expected)


def parse_whatsapp_message(message):
    msg_type = message.get("type", "text")
    text = ""
    location = None
    media = None
    if msg_type == "text":
        text = message.get("text", {}).get("body", "")
    elif msg_type == "location":
        location = message.get("location", {})
        text = "entrar"
    elif msg_type in ["image", "document", "video", "audio"]:
        media_obj = message.get(msg_type, {})
        text = media_obj.get("caption", "")
        media = {
            "type": msg_type,
            "id": media_obj.get("id"),
            "mime_type": media_obj.get("mime_type"),
            "sha256": media_obj.get("sha256"),
            "filename": media_obj.get("filename"),
            "caption": media_obj.get("caption"),
        }
    else:
        text = msg_type
    return {"from": message.get("from", ""), "text": text, "type": msg_type, "location": location, "media": media, "raw": message}


def extract_messages(payload):
    messages = []
    for entry in payload.get("entry", []):
        for change in entry.get("changes", []):
            value = change.get("value", {})
            for message in value.get("messages", []):
                parsed = parse_whatsapp_message(message)
                if parsed["from"]:
                    messages.append(parsed)
    return messages


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self):
        if CORS_ORIGIN:
            self.send_header("Access-Control-Allow-Origin", CORS_ORIGIN)
            self.send_header("Access-Control-Allow-Credentials", "true")
            self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Requested-With")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
        super().end_headers()

    def send_json(self, data, status=200, extra_headers=None):
        encoded = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(encoded)))
        for key, value in (extra_headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(encoded)

    def send_html(self, html, status=200):
        encoded = html.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def read_json(self):
        self._json_error = False
        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length)
        if not raw:
            return raw, {}
        try:
            return raw, json.loads(raw.decode("utf-8") or "{}")
        except (UnicodeDecodeError, json.JSONDecodeError):
            self._json_error = True
            return raw, {}

    def reject_invalid_json(self):
        if getattr(self, "_json_error", False):
            self.send_json({"error": "invalid_json"}, 400)
            return True
        return False

    def session_token(self):
        parsed = cookies.SimpleCookie(self.headers.get("Cookie", ""))
        morsel = parsed.get("checador_session")
        return morsel.value if morsel else None

    def current_user(self):
        with connect() as con:
            user = get_user_from_token(con, self.session_token())
            return dict(user) if user else None

    def require_user(self):
        user = self.current_user()
        if not user:
            self.send_json({"error": "auth_required"}, 401)
            return None
        return user

    def do_OPTIONS(self):
        self.send_response(204)
        self.end_headers()

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/api/health":
            return self.send_json({
                "ok": True,
                "db": str(DB_PATH),
                "normalizedDb": True,
                "whatsappConfigured": bool(WHATSAPP_TOKEN and WHATSAPP_PHONE_NUMBER_ID),
                "sendgridConfigured": bool(SENDGRID_API_KEY),
                "twilioConfigured": bool(TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN and TWILIO_FROM),
                "publicBaseUrl": PUBLIC_BASE_URL or public_base_url(self.headers),
            })
        if parsed.path == "/api/me":
            user = self.current_user()
            return self.send_json({"user": public_user(user) if user else None})
        if parsed.path == "/api/state":
            with connect() as con:
                return self.send_json(build_state(con))
        if parsed.path == "/api/employees":
            with connect() as con:
                return self.send_json(build_state(con)["employees"])
        if parsed.path == "/api/records":
            with connect() as con:
                return self.send_json(build_state(con)["records"])
        if parsed.path == "/api/issues":
            with connect() as con:
                return self.send_json(build_state(con)["issues"])
        if parsed.path == "/api/media":
            with connect() as con:
                rows = [dict(row) for row in con.execute("SELECT * FROM media_attachments ORDER BY created_at DESC LIMIT 200")]
            return self.send_json(rows)
        if parsed.path == "/api/security/tickets":
            with connect() as con:
                return self.send_json(list_security_tickets(con))
        if parsed.path == "/api/security/alerts":
            with connect() as con:
                return self.send_json(list_security_alerts(con))
        if parsed.path == "/api/phishing/templates":
            with connect() as con:
                return self.send_json(list_phishing_templates(con))
        if parsed.path == "/api/phishing/campaigns":
            with connect() as con:
                return self.send_json(list_phishing_campaigns(con))
        if parsed.path == "/api/phishing/reports/monthly":
            query = urllib.parse.parse_qs(parsed.query)
            with connect() as con:
                return self.send_json(build_monthly_phishing_report(con, query.get("month", [None])[0]))
        tracking_parts = [urllib.parse.unquote(part) for part in parsed.path.strip("/").split("/") if part]
        if len(tracking_parts) == 3 and tracking_parts[0] in {"t", "r", "training"}:
            action, campaign_id, target_value = tracking_parts
            event_name = {"t": "clicked", "r": "reported", "training": "trained"}[action]
            with connect() as con:
                target = track_phishing_event(con, campaign_id, target_value, event_name, metadata={"ip": self.client_address[0], "userAgent": self.headers.get("User-Agent", "")})
            if not target:
                return self.send_html(training_page("Liga no encontrada", "DOGUI no encontro esta simulacion. Verifica que la campana siga activa."), 404)
            if action == "t":
                training_url = f"{public_base_url(self.headers)}/training/{campaign_id}/{target['id']}"
                return self.send_html(training_page("Simulacion DOGUI", "Este clic fue registrado como parte de una campana controlada. En un ataque real, revisa remitente, dominio, urgencia y adjuntos antes de abrir.", training_url))
            if action == "r":
                return self.send_html(training_page("Reporte recibido", "Buen trabajo. DOGUI registro que reportaste la simulacion antes de interactuar con el enlace. Ese comportamiento sube el score de tu equipo."))
            return self.send_html(training_page("Capacitacion completada", "DOGUI registro la capacitacion. Recuerda reportar links, correos, archivos raros e intentos de fraude directamente por WhatsApp."))
        if parsed.path == "/webhooks/whatsapp":
            query = urllib.parse.parse_qs(parsed.query)
            mode = query.get("hub.mode", [""])[0]
            token = query.get("hub.verify_token", [""])[0]
            challenge = query.get("hub.challenge", [""])[0]
            if mode == "subscribe" and token == VERIFY_TOKEN:
                self.send_response(200)
                self.end_headers()
                self.wfile.write(challenge.encode("utf-8"))
                return
            return self.send_json({"error": "invalid verification token"}, 403)
        return super().do_GET()

    def do_PUT(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/api/state":
            user = self.require_user()
            if not user:
                return
            _, payload = self.read_json()
            if self.reject_invalid_json():
                return
            save_state(payload)
            return self.send_json({"ok": True})
        return self.send_json({"error": "not found"}, 404)

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/api/login":
            _, payload = self.read_json()
            if self.reject_invalid_json():
                return
            with connect() as con:
                user = con.execute("SELECT * FROM users WHERE email = ? AND active = 1", (payload.get("email", ""),)).fetchone()
                if not user or not verify_password(payload.get("password", ""), user["password_salt"], user["password_hash"]):
                    return self.send_json({"error": "credenciales_invalidas"}, 401)
                token, expires_at = create_session(con, user)
                add_audit(con, "Inicio de sesion", user["email"], user["name"], user["role"])
            cookie = f"checador_session={token}; HttpOnly; SameSite=Lax; Path=/; Max-Age={SESSION_DAYS * 86400}"
            return self.send_json({"ok": True, "user": public_user(dict(user)), "expiresAt": expires_at}, extra_headers={"Set-Cookie": cookie})

        if parsed.path == "/api/logout":
            token = self.session_token()
            with connect() as con:
                if token:
                    con.execute("DELETE FROM sessions WHERE token = ?", (token,))
            return self.send_json({"ok": True}, extra_headers={"Set-Cookie": "checador_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0"})

        if parsed.path == "/api/state":
            user = self.require_user()
            if not user:
                return
            _, payload = self.read_json()
            if self.reject_invalid_json():
                return
            save_state(payload)
            return self.send_json({"ok": True})

        if parsed.path == "/api/employees":
            user = self.require_user()
            if not user:
                return
            _, payload = self.read_json()
            if self.reject_invalid_json():
                return
            with connect() as con:
                employee_id = upsert_employee(con, payload, user["company_id"])
                add_audit(con, "Empleado guardado", payload.get("name", employee_id), user["name"], user["role"])
            return self.send_json({"ok": True, "id": employee_id})

        if parsed.path == "/api/security/tickets":
            user = self.require_user()
            if not user:
                return
            _, payload = self.read_json()
            if self.reject_invalid_json():
                return
            with connect() as con:
                employee = con.execute("SELECT * FROM employees WHERE id = ? AND company_id = ? AND active = 1", (payload.get("employeeId"), user["company_id"])).fetchone()
                if not employee:
                    return self.send_json({"error": "employee_not_found"}, 404)
                ticket, alert = create_security_ticket(
                    con,
                    employee,
                    payload.get("type", "Reporte"),
                    payload.get("detail", ""),
                    payload.get("severity", "Media"),
                    source_channel=payload.get("sourceChannel", "Panel"),
                )
                add_audit(con, "Ticket de seguridad creado desde panel", ticket["number"], user["name"], user["role"])
            return self.send_json({"ok": True, "ticket": ticket, "alert": alert})

        if parsed.path.startswith("/api/security/tickets/") and parsed.path.endswith("/status"):
            user = self.require_user()
            if not user:
                return
            ticket_id = parsed.path.split("/")[4]
            _, payload = self.read_json()
            if self.reject_invalid_json():
                return
            status = payload.get("status", "En revision")
            closed_at = utc_now() if status == "Cerrado" else None
            with connect() as con:
                con.execute(
                    "UPDATE security_tickets SET status = ?, updated_at = ?, closed_at = ? WHERE id = ?",
                    (status, utc_now(), closed_at, ticket_id),
                )
                if status == "Cerrado":
                    con.execute("UPDATE security_alerts SET status = 'Cerrada' WHERE ticket_id = ?", (ticket_id,))
                add_audit(con, "Ticket de seguridad actualizado", f"{ticket_id} -> {status}", user["name"], user["role"])
                ticket = get_security_ticket(con, ticket_id)
            return self.send_json({"ok": True, "ticket": ticket})

        if parsed.path == "/api/phishing/campaigns":
            user = self.require_user()
            if not user:
                return
            _, payload = self.read_json()
            if self.reject_invalid_json():
                return
            with connect() as con:
                campaign = create_phishing_campaign(con, payload, user["company_id"])
                if payload.get("launchNow"):
                    launched = launch_phishing_campaign(con, campaign["id"], public_base_url(self.headers))
                    return self.send_json({"ok": True, **launched})
            return self.send_json({"ok": True, "campaign": campaign})

        if parsed.path.startswith("/api/phishing/campaigns/") and parsed.path.endswith("/launch"):
            user = self.require_user()
            if not user:
                return
            campaign_id = parsed.path.split("/")[4]
            with connect() as con:
                launched = launch_phishing_campaign(con, campaign_id, public_base_url(self.headers))
                if not launched:
                    return self.send_json({"error": "campaign_not_found"}, 404)
                add_audit(con, "Campana phishing lanzada desde panel", campaign_id, user["name"], user["role"])
            return self.send_json({"ok": True, **launched})

        if parsed.path.startswith("/api/issues/") and parsed.path.endswith("/status"):
            user = self.require_user()
            if not user:
                return
            issue_id = parsed.path.split("/")[3]
            _, payload = self.read_json()
            if self.reject_invalid_json():
                return
            with connect() as con:
                con.execute("UPDATE issues SET status = ?, resolved_at = ? WHERE id = ?", (payload.get("status", "Pendiente"), utc_now(), issue_id))
                add_audit(con, "Incidencia actualizada", issue_id, user["name"], user["role"])
            return self.send_json({"ok": True})

        if parsed.path == "/webhooks/whatsapp":
            raw, payload = self.read_json()
            if self.reject_invalid_json():
                return
            if not verify_meta_signature(self.headers, raw):
                return self.send_json({"error": "invalid signature"}, 403)
            results = [
                process_business_message(item["from"], item["text"], item["raw"], item["type"], item["location"], item["media"])
                for item in extract_messages(payload)
            ]
            return self.send_json({"ok": True, "results": results})

        if parsed.path == "/api/simulate-whatsapp":
            _, payload = self.read_json()
            if self.reject_invalid_json():
                return
            raw = {
                "id": payload.get("id", make_id("sim")),
                "from": payload.get("from", ""),
                "type": payload.get("type", "text"),
                "text": {"body": payload.get("text", "")},
            }
            if payload.get("type") == "location":
                raw["location"] = {"latitude": payload.get("latitude"), "longitude": payload.get("longitude"), "name": payload.get("name"), "address": payload.get("address")}
            parsed_msg = parse_whatsapp_message(raw)
            result = process_business_message(parsed_msg["from"], parsed_msg["text"], raw, parsed_msg["type"], parsed_msg["location"], parsed_msg["media"])
            return self.send_json(result)

        return self.send_json({"error": "not found"}, 404)

    def do_DELETE(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path.startswith("/api/employees/"):
            user = self.require_user()
            if not user:
                return
            employee_id = parsed.path.split("/")[3]
            with connect() as con:
                con.execute("UPDATE employees SET active = 0 WHERE id = ?", (employee_id,))
                add_audit(con, "Empleado dado de baja", employee_id, user["name"], user["role"])
            return self.send_json({"ok": True})
        return self.send_json({"error": "not found"}, 404)


def upsert_employee(con, payload, company_id):
    employee_id = payload.get("id") or make_id("emp")
    branch_id = payload.get("branchId") or get_meta(con, "selected_branch_id", "")
    if not branch_id or not con.execute("SELECT 1 FROM branches WHERE id = ? AND company_id = ?", (branch_id, company_id)).fetchone():
        row = con.execute("SELECT id FROM branches WHERE company_id = ? AND active = 1 ORDER BY name LIMIT 1", (company_id,)).fetchone()
        if row:
            branch_id = row["id"]
        else:
            branch_id = f"br-default-{company_id}"
            con.execute(
                "INSERT OR IGNORE INTO branches (id, company_id, name, lat, lng, active) VALUES (?, ?, 'Sucursal principal', 0, 0, 1)",
                (branch_id, company_id),
            )
    name = (payload.get("name") or "Empleado sin nombre").strip() or "Empleado sin nombre"
    con.execute(
        """
        INSERT INTO employees
        (id, company_id, branch_id, name, phone, phone_normalized, area, mode, role, start_time, end_time, vacation_days, active)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
        ON CONFLICT(id) DO UPDATE SET
          branch_id=excluded.branch_id,
          name=excluded.name,
          phone=excluded.phone,
          phone_normalized=excluded.phone_normalized,
          area=excluded.area,
          mode=excluded.mode,
          role=excluded.role,
          start_time=excluded.start_time,
          end_time=excluded.end_time,
          vacation_days=excluded.vacation_days,
          active=excluded.active
        """,
        (
            employee_id,
            company_id,
            branch_id,
            name,
            payload.get("phone", ""),
            normalize_phone(payload.get("phone")),
            payload.get("area", "General"),
            payload.get("mode", "Presencial"),
            payload.get("role", "Empleado"),
            payload.get("start", "09:00"),
            payload.get("end", "18:00"),
            float(payload.get("vacationDays", 0)),
        ),
    )
    return employee_id


def public_user(user):
    if not user:
        return None
    return {"id": user["id"], "email": user["email"], "name": user["name"], "role": user["role"], "companyId": user["company_id"]}


if __name__ == "__main__":
    init_db()
    print(f"Checador WA listo en http://127.0.0.1:{PORT}")
    print("Usuario inicial: admin@empresa.mx / admin123")
    print("Webhook WhatsApp: https://TU-DOMINIO/webhooks/whatsapp")
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
