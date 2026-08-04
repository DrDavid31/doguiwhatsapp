const STORAGE_KEY = "checador-wa-state-v3";
const SESSION_KEY = "checador-wa-session";
const oldKeys = ["checador-wa-state-v1", "checador-wa-state-v2"];
const BACKEND_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const configuredApiBase = (window.DOGUI_API_BASE || localStorage.getItem("dogui-api-base") || document.querySelector('meta[name="dogui-api-base"]')?.content || "").replace(/\/$/, "");
const API_BASE = configuredApiBase || (BACKEND_HOSTS.has(location.hostname) && (location.protocol === "http:" || location.protocol === "https:") ? "" : null);
const HAS_BACKEND = API_BASE !== null;
const DEMO_MODE = !HAS_BACKEND;
const now = () => new Date();
const makeId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
let syncingState = false;
let backendUnreachable = false;
let integrationHealth = null;
let backendSaveTimer = null;
let pendingBackendPayload = "";
const elementCache = new Map();
const dayKeyCache = new Map();
const timestampCache = new Map();
const dateFormatter = new Intl.DateTimeFormat("es-MX", { day: "2-digit", month: "2-digit", year: "numeric" });
const timeFormatter = new Intl.DateTimeFormat("es-MX", { hour: "2-digit", minute: "2-digit" });

const defaultPolicy = {
  tolerance: 10,
  forgottenExitHours: 10,
  geofenceRadius: 250,
  overtimeAfterHours: 8,
  requireGps: true,
  requireSelfie: false
};

const seed = {
  companies: [{ id: "co-demo", name: "Empresa Demo" }],
  selectedCompanyId: "co-demo",
  branches: [
    { id: "br-centro", companyId: "co-demo", name: "Sucursal Centro", lat: 19.432608, lng: -99.133209 },
    { id: "br-norte", companyId: "co-demo", name: "Planta Norte", lat: 19.4938, lng: -99.1462 }
  ],
  selectedBranchId: "br-centro",
  policy: defaultPolicy,
  employees: [
    employeeSeed("Ana Lopez", "+52 55 1234 0001", "Administracion", "br-centro", "Hibrido", "Supervisor", "09:00", "18:00", 12),
    employeeSeed("Carlos Mendez", "+52 55 1234 0002", "Operaciones", "br-norte", "Presencial", "Empleado", "08:00", "17:00", 8),
    employeeSeed("Sofia Ramirez", "+52 55 1234 0003", "Ventas", "br-centro", "Remoto", "Empleado", "10:00", "19:00", 10)
  ],
  records: [],
  issues: [],
  alerts: [],
  audit: [],
  chat: [],
  securityTickets: [],
  securityAlerts: [],
  phishingTemplates: [
    { id: "tpl-factura", name: "Factura proveedor", category: "proveedor", channel: "Correo", risk: "Alta" },
    { id: "tpl-banco", name: "Validacion bancaria", category: "banco", channel: "SMS", risk: "Alta" },
    { id: "tpl-rh", name: "Actualizacion RH", category: "RH", channel: "WhatsApp", risk: "Media" },
    { id: "tpl-paqueteria", name: "Paqueteria retenida", category: "paqueteria", channel: "SMS", risk: "Media" },
    { id: "tpl-sat", name: "Aviso SAT", category: "SAT", channel: "Correo", risk: "Alta" }
  ],
  phishingCampaigns: [],
  report: { from: todayIso(), to: todayIso(), area: "Todas" }
};

let state = HAS_BACKEND ? seed : migrateState(loadState());
let session = JSON.parse(localStorage.getItem(SESSION_KEY) || "null");
document.body.dataset.mode = DEMO_MODE ? "demo" : "server";
if (DEMO_MODE) seedPresentationData();

function employeeSeed(name, phone, area, branchId, mode, role, start, end, vacationDays) {
  return { id: makeId(), name, phone, area, branchId, mode, role, start, end, vacationDays, active: true };
}

function loadState() {
  const saved = localStorage.getItem(STORAGE_KEY) || oldKeys.map((key) => localStorage.getItem(key)).find(Boolean);
  if (!saved) return seed;
  try {
    return JSON.parse(saved);
  } catch (error) {
    console.warn("Estado local corrupto, reiniciando demo", error);
    localStorage.removeItem(STORAGE_KEY);
    oldKeys.forEach((key) => localStorage.removeItem(key));
    return seed;
  }
}

function migrateState(raw) {
  const merged = { ...seed, ...raw };
  merged.companies = raw.companies || seed.companies;
  merged.branches = raw.branches || seed.branches;
  merged.policy = { ...defaultPolicy, ...(raw.policy || {}) };
  merged.selectedCompanyId = raw.selectedCompanyId || "co-demo";
  merged.selectedBranchId = raw.selectedBranchId || merged.branches[0]?.id || "";
  merged.report = { from: todayIso(), to: todayIso(), area: "Todas", ...(raw.report || {}) };
  merged.alerts = raw.alerts || [];
  merged.audit = raw.audit || [];
  merged.issues = raw.issues || [];
  merged.chat = raw.chat || [];
  merged.securityTickets = raw.securityTickets || seed.securityTickets;
  merged.securityAlerts = raw.securityAlerts || seed.securityAlerts;
  merged.phishingTemplates = raw.phishingTemplates || seed.phishingTemplates;
  merged.phishingCampaigns = raw.phishingCampaigns || seed.phishingCampaigns;
  merged.records = (raw.records || []).map((record) => ({ branchId: merged.selectedBranchId, evidence: false, suspicious: false, ...record }));
  merged.employees = (raw.employees || seed.employees).map((employee) => ({
    area: "General",
    branchId: merged.selectedBranchId,
    mode: "Presencial",
    role: "Empleado",
    vacationDays: 12,
    active: true,
    ...employee
  }));
  saveState(merged);
  return merged;
}

async function apiFetch(path, options = {}) {
  if (!HAS_BACKEND) throw new Error("Backend no configurado");
  const init = {
    credentials: "include",
    ...options,
    headers: { ...(options.headers || {}) }
  };
  if (init.body && typeof init.body !== "string") {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(init.body);
  }
  return fetch(`${API_BASE}${path}`, init);
}

function saveState(next = state) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  if (HAS_BACKEND && !syncingState && session) {
    pendingBackendPayload = JSON.stringify({ ...next, _version: state.version });
    window.clearTimeout(backendSaveTimer);
    backendSaveTimer = window.setTimeout(() => {
      apiFetch("/api/state", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: pendingBackendPayload
      })
        .then(async (response) => {
          if (response.status === 409) {
            console.warn("Otro usuario guardo cambios primero; recargando estado del servidor.");
            await hydrateFromBackend();
            return;
          }
          const wasUnreachable = backendUnreachable;
          backendUnreachable = !response.ok;
          if (response.ok) {
            const payload = await response.json();
            if (typeof payload.version === "number") state.version = payload.version;
          }
          if (wasUnreachable !== backendUnreachable) render();
        })
        .catch((error) => {
          console.warn("No se pudo guardar en backend", error);
          const wasUnreachable = backendUnreachable;
          backendUnreachable = true;
          if (!wasUnreachable) render();
        });
    }, 450);
  }
}

function demoTimestamp(hoursAgo) {
  const date = new Date();
  date.setHours(date.getHours() - hoursAgo);
  return date.toISOString();
}

function seedPresentationData() {
  if (!state.employees.length) return;
  const first = state.employees[0];
  const second = state.employees[1] || first;
  const third = state.employees[2] || first;
  const branch = state.branches[0];
  if (!state.records.length) {
    state.records = [
      {
        id: makeId(),
        employeeId: first.id,
        employeeName: first.name,
        branchId: first.branchId,
        event: "entrada",
        message: "entrar",
        location: "Sucursal Centro",
        lat: branch.lat,
        lng: branch.lng,
        distance: 18,
        evidence: true,
        suspicious: false,
        flags: [],
        status: "A tiempo",
        timestamp: demoTimestamp(5)
      },
      {
        id: makeId(),
        employeeId: second.id,
        employeeName: second.name,
        branchId: second.branchId,
        event: "entrada",
        message: "entrar",
        location: "Planta Norte",
        lat: 19.4938,
        lng: -99.1462,
        distance: 42,
        evidence: true,
        suspicious: false,
        flags: [],
        status: "Retardo",
        timestamp: demoTimestamp(4)
      },
      {
        id: makeId(),
        employeeId: third.id,
        employeeName: third.name,
        branchId: third.branchId,
        event: "permiso",
        message: "permiso medico",
        location: "WhatsApp",
        evidence: true,
        suspicious: false,
        flags: [],
        status: "Incidencia",
        timestamp: demoTimestamp(2)
      }
    ];
  }
  if (!state.issues.length) {
    state.issues = [
      {
        id: makeId(),
        employeeId: third.id,
        employeeName: third.name,
        type: "permiso",
        detail: "permiso medico con evidencia por WhatsApp",
        evidence: true,
        status: "Pendiente",
        timestamp: demoTimestamp(2)
      }
    ];
  }
  if (!state.alerts.length) {
    state.alerts = [
      {
        id: makeId(),
        key: `demo-alert-${second.id}`,
        employeeName: second.name,
        type: "Retardo",
        detail: "Entrada registrada fuera de tolerancia.",
        severity: "warn",
        status: "Abierta",
        timestamp: demoTimestamp(4)
      }
    ];
  }
  if (!state.chat.length) {
    state.chat = [
      {
        id: makeId(),
        employeeName: first.name,
        message: "entrar",
        response: `${first.name}, registramos tu entrada con estado: A tiempo.`,
        timestamp: demoTimestamp(5)
      },
      {
        id: makeId(),
        employeeName: third.name,
        message: "permiso medico",
        response: `${third.name}, registramos tu permiso con estado: Incidencia.`,
        timestamp: demoTimestamp(2)
      }
    ];
  }
  if (!state.securityTickets?.length) {
    state.securityTickets = [
      securityTicketSeed(first, "Link sospechoso", "Recibi enlace factura-proveedor.mx/descarga por WhatsApp", "Alta", demoTimestamp(1)),
      securityTicketSeed(second, "Correo falso", "Correo de banco pide actualizar token y contrasena", "Alta", demoTimestamp(3)),
      securityTicketSeed(third, "Archivo raro", "Adjunto .zip enviado por supuesto proveedor nuevo", "Media", demoTimestamp(7))
    ];
  }
  if (!state.securityAlerts?.length) {
    state.securityAlerts = [
      { id: makeId(), title: "Bloquear dominio", detail: "factura-proveedor.mx aparece en 2 reportes.", severity: "Alta", status: "Activa", timestamp: demoTimestamp(1) },
      { id: makeId(), title: "Aviso interno", detail: "Enviar alerta de no abrir adjuntos ZIP de proveedores no verificados.", severity: "Media", status: "Activa", timestamp: demoTimestamp(2) }
    ];
  }
  if (!state.phishingCampaigns?.length) {
    state.phishingCampaigns = [
      phishingCampaignSeed("Factura proveedor junio", "Correo", "Factura proveedor", "Operaciones", 34, 11, 19, 28, demoTimestamp(24)),
      phishingCampaignSeed("Aviso SAT urgente", "WhatsApp", "Aviso SAT", "Administracion", 18, 7, 8, 14, demoTimestamp(72)),
      phishingCampaignSeed("Paqueteria retenida", "SMS", "Paqueteria retenida", "Ventas", 21, 6, 11, 18, demoTimestamp(120))
    ];
  }
  if (!state.audit.length) {
    state.audit = [
      {
        id: makeId(),
        action: "Demo GitHub Pages",
        detail: "Datos de presentacion cargados automaticamente",
        user: "Sistema",
        role: "Demo",
        timestamp: demoTimestamp(6)
      }
    ];
  }
  saveState();
}

function securityResponseFor(type) {
  const responses = {
    "Link sospechoso": "No abras el enlace. El equipo de seguridad lo revisara y bloqueara el dominio si aplica.",
    "Correo falso": "No respondas el correo ni descargues adjuntos. Reenvia evidencia y espera confirmacion de DOGUI.",
    "Archivo raro": "No abras el archivo. Aisla el mensaje y espera revision del equipo de seguridad.",
    "Intento de fraude": "Deten cualquier pago o transferencia. Seguridad y finanzas revisaran el intento.",
    "Check-in de seguridad": "Check-in recibido. Si estas en una situacion activa, comparte ubicacion y evidencia."
  };
  return responses[type] || "Reporte recibido. Espera revision antes de realizar cualquier accion.";
}

function securityTicketSeed(employee, type, detail, severity, timestamp = now().toISOString()) {
  return {
    id: makeId(),
    number: `DG-${Math.floor(1000 + Math.random() * 9000)}`,
    employeeId: employee.id,
    employeeName: employee.name,
    department: employee.area,
    type,
    detail,
    severity,
    status: severity === "Alta" ? "Prioridad SOC" : "En revision",
    response: securityResponseFor(type),
    timestamp
  };
}

function phishingCampaignSeed(name, channel, template, department, sent, clicked, reported, trained, timestamp = now().toISOString()) {
  return { id: makeId(), name, channel, template, department, sent, clicked, reported, trained, timestamp };
}

async function createSecurityTicket(event) {
  event.preventDefault();
  const employee = employeeById(byId("securityEmployee").value) || activeEmployees()[0];
  if (!employee) {
    alert("Agrega un empleado activo antes de crear tickets.");
    return;
  }
  const type = byId("securityType").value;
  const detail = byId("securityDetail").value.trim();
  const severity = byId("securitySeverity").value;
  if (!detail) {
    alert("Describe el incidente para crear el ticket.");
    return;
  }
  if (HAS_BACKEND) {
    const response = await apiFetch("/api/security/tickets", {
      method: "POST",
      body: { employeeId: employee.id, type, detail, severity, sourceChannel: "Panel" }
    });
    if (!response.ok) {
      alert("No se pudo crear el ticket en el backend.");
      return;
    }
    const payload = await response.json();
    byId("securityDetail").value = "";
    await hydrateFromBackend();
    byId("securityAutoResponse").innerHTML = `<strong>Respuesta automatica</strong><span>${escapeHtml(payload.ticket.response)}</span>`;
    return;
  }
  const ticket = securityTicketSeed(employee, type, detail, severity);
  state.securityTickets.unshift(ticket);
  state.securityAlerts.unshift({
    id: makeId(),
    title: `${ticket.severity}: ${ticket.type}`,
    detail: `${ticket.employeeName} reporto: ${ticket.detail}`,
    severity: ticket.severity,
    status: "Activa",
    timestamp: ticket.timestamp
  });
  state.chat.unshift({
    id: makeId(),
    employeeName: ticket.employeeName,
    message: ticket.detail,
    response: ticket.response,
    timestamp: ticket.timestamp
  });
  addAudit("Ticket de seguridad creado", `${ticket.number} - ${ticket.type}`);
  byId("securityAutoResponse").innerHTML = `<strong>Respuesta automatica</strong><span>${escapeHtml(ticket.response)}</span>`;
  byId("securityDetail").value = "";
  saveState();
  render();
}

async function performLaunchCampaign(name, channel, template, department) {
  const selectedTargets = activeEmployees().filter((employee) => department === "Todos" || employee.area === department);
  if (!selectedTargets.length) return { ok: false, message: "No hay empleados activos para esta campana." };
  if (HAS_BACKEND) {
    const response = await apiFetch("/api/phishing/campaigns", {
      method: "POST",
      body: { name, channel, template, department, launchNow: true }
    });
    if (!response.ok) return { ok: false, message: "No se pudo lanzar la campana en el backend." };
    await hydrateFromBackend();
    return { ok: true, sent: selectedTargets.length };
  }
  const sent = Math.max(8, selectedTargets.length * 12);
  const riskBoost = template.toLowerCase().includes("sat") || template.toLowerCase().includes("banco") ? 0.34 : 0.24;
  const clicked = Math.max(1, Math.round(sent * riskBoost));
  const reported = Math.max(1, Math.round(sent * 0.42));
  const trained = Math.max(reported, Math.round(sent * 0.78));
  state.phishingCampaigns.unshift(phishingCampaignSeed(name, channel, template, department, sent, clicked, reported, trained));
  addAudit("Campana phishing simulada", `${name} - ${department}`);
  saveState();
  render();
  return { ok: true, sent };
}

async function launchPhishingCampaign(event) {
  event.preventDefault();
  const department = byId("campaignDepartment").value;
  const template = byId("campaignTemplate").value;
  const campaignName = byId("campaignName").value.trim() || `Campana DOGUI ${todayIso()}`;
  const result = await performLaunchCampaign(campaignName, byId("campaignChannel").value, template, department);
  if (!result.ok) alert(result.message);
}

async function hydrateFromBackend() {
  if (!HAS_BACKEND) return;
  try {
    syncingState = true;
    const healthResponse = await apiFetch("/api/health");
    if (healthResponse.ok) integrationHealth = await healthResponse.json();
    const sessionResponse = await apiFetch("/api/me");
    if (!sessionResponse.ok) throw new Error(`HTTP ${sessionResponse.status}`);
    const sessionPayload = await sessionResponse.json();
    if (sessionPayload.user) {
      session = { user: sessionPayload.user.email, role: sessionPayload.user.role, timestamp: now().toISOString() };
      localStorage.setItem(SESSION_KEY, JSON.stringify(session));
    } else {
      if (session) {
        session = null;
        localStorage.removeItem(SESSION_KEY);
      }
      backendUnreachable = false;
      render();
      return;
    }
    const response = await apiFetch("/api/state");
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    state = migrateState(await response.json());
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    backendUnreachable = false;
    render();
  } catch (error) {
    console.warn("No se pudo cargar /api/state; usando localStorage", error);
    backendUnreachable = true;
    render();
  } finally {
    syncingState = false;
  }
}

function byId(id) {
  if (!elementCache.has(id)) elementCache.set(id, document.getElementById(id));
  return elementCache.get(id);
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function validDate(value, fallback = new Date()) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : fallback;
}

function formatDate(dateValue) {
  return dateFormatter.format(validDate(dateValue));
}

function formatTime(dateValue) {
  return timeFormatter.format(validDate(dateValue));
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[char]);
}

function escapeAttr(value) {
  return escapeHtml(value);
}

function clamp(value, min = 0, max = 100) {
  const numeric = Number(value);
  return Math.max(min, Math.min(max, Number.isFinite(numeric) ? numeric : min));
}

function percent(value) {
  return Math.round(clamp(value));
}

function emptyState(message) {
  return `<p class="empty-state">${escapeHtml(message)}</p>`;
}

function branchCoordinate(branch, field) {
  const value = Number(branch?.[field]);
  return Number.isFinite(value) ? value : 0;
}

function dayKey(value) {
  const key = value instanceof Date ? value.toISOString() : String(value || "");
  if (!dayKeyCache.has(key)) {
    if (dayKeyCache.size > 2500) dayKeyCache.clear();
    dayKeyCache.set(key, validDate(value, new Date(0)).toDateString());
  }
  return dayKeyCache.get(key);
}

function timestampMs(value) {
  const key = String(value || "");
  if (!timestampCache.has(key)) {
    if (timestampCache.size > 2500) timestampCache.clear();
    timestampCache.set(key, validDate(value, new Date(0)).getTime());
  }
  return timestampCache.get(key);
}

function minutesFromTime(value) {
  const [hours, minutes] = String(value || "00:00").split(":").map(Number);
  return (Number.isFinite(hours) ? hours : 0) * 60 + (Number.isFinite(minutes) ? minutes : 0);
}

function minutesFromDate(dateValue) {
  const date = validDate(dateValue);
  return date.getHours() * 60 + date.getMinutes();
}

function readCoordinate(id) {
  const value = byId(id).value.trim();
  return value === "" ? NaN : Number(value);
}

function readNumber(id, fallback, min = 0) {
  const value = Number(byId(id).value);
  return Number.isFinite(value) ? Math.max(min, value) : fallback;
}

function normalizePhone(value) {
  return String(value || "").replace(/\D/g, "");
}

function branchById(id) {
  return state.branches.find((branch) => branch.id === id) || state.branches.find((branch) => branch.companyId === state.selectedCompanyId) || state.branches[0] || {
    id: "br-fallback",
    companyId: state.selectedCompanyId || "co-demo",
    name: "Sucursal sin configurar",
    lat: 0,
    lng: 0
  };
}

function employeeById(id) {
  return state.employees.find((employee) => employee.id === id);
}

function activeEmployees() {
  return state.employees.filter((employee) => employee.active && employee.branchId === state.selectedBranchId);
}

function distanceMeters(aLat, aLng, bLat, bLng) {
  const earth = 6371000;
  const toRad = (degrees) => (degrees * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const first = Math.sin(dLat / 2) ** 2;
  const second = Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * earth * Math.asin(Math.sqrt(first + second));
}

function recordsForDay(employeeId, date = new Date()) {
  const day = dayKey(date);
  return state.records.filter((record) => record.employeeId === employeeId && dayKey(record.timestamp) === day);
}

function recordsForReport() {
  const from = timestampMs(`${state.report.from}T00:00:00`);
  const to = timestampMs(`${state.report.to}T23:59:59`);
  return state.records.filter((record) => {
    const employee = employeeById(record.employeeId);
    const stamp = timestampMs(record.timestamp);
    const areaOk = state.report.area === "Todas" || employee?.area === state.report.area;
    return stamp >= from && stamp <= to && areaOk && record.branchId === state.selectedBranchId;
  });
}

function classifyEvent(message) {
  const text = message.toLowerCase().trim();
  if (["entrar", "entrada", "inicio"].some((word) => text.startsWith(word))) return "entrada";
  if (["salir", "salida", "fin"].some((word) => text.startsWith(word))) return "salida";
  if (text.startsWith("descanso") || text.startsWith("comida")) return "descanso";
  if (text.startsWith("regreso") || text.startsWith("volver")) return "regreso";
  if (text.includes("vacaciones")) return "vacaciones";
  if (text.includes("permiso")) return "permiso";
  if (text.includes("incapacidad")) return "incapacidad";
  if (text.includes("saldo")) return "saldo";
  return "mensaje";
}

function currentWorkState(employeeId) {
  const last = recordsForDay(employeeId).sort((a, b) => timestampMs(b.timestamp) - timestampMs(a.timestamp))[0];
  if (!last) return "Ausente";
  if (last.event === "entrada" || last.event === "regreso") return "En turno";
  if (last.event === "descanso") return "En descanso";
  return "Jornada cerrada";
}

function calculateWorkedHours(employeeId, date = new Date()) {
  const records = recordsForDay(employeeId, date).slice().reverse();
  let openEntry = null;
  let totalMs = 0;
  records.forEach((record) => {
    if (record.event === "entrada" || record.event === "regreso") openEntry = timestampMs(record.timestamp);
    if ((record.event === "salida" || record.event === "descanso") && openEntry) {
      totalMs += timestampMs(record.timestamp) - openEntry;
      openEntry = null;
    }
  });
  if (openEntry && dayKey(new Date()) === dayKey(date)) totalMs += Date.now() - openEntry;
  return Math.max(0, totalMs / 1000 / 60 / 60);
}

function addAudit(action, detail) {
  state.audit.unshift({ id: makeId(), action, detail, user: session?.user || "Sistema", role: session?.role || "Sistema", timestamp: now().toISOString() });
}

function addAlert(type, employee, detail, severity = "warn") {
  const key = `${type}-${employee?.id || "system"}-${new Date().toDateString()}`;
  if (state.alerts.some((alert) => alert.key === key && alert.status === "Abierta")) return;
  state.alerts.unshift({ id: makeId(), key, type, employeeName: employee?.name || "Sistema", detail, severity, status: "Abierta", timestamp: now().toISOString() });
}

function processMessage(employeeId, message, location, lat, lng, evidence, incomingPhone) {
  const employee = employeeById(employeeId);
  if (!employee || !employee.active) return;

  const event = classifyEvent(message);
  const timestamp = now().toISOString();
  const branch = branchById(employee.branchId);
  const hasGps = Number.isFinite(lat) && Number.isFinite(lng);
  const branchLat = branchCoordinate(branch, "lat");
  const branchLng = branchCoordinate(branch, "lng");
  const distance = hasGps ? distanceMeters(lat, lng, branchLat, branchLng) : null;
  const duplicate = recordsForDay(employee.id).some((record) => record.event === event && Math.abs(timestampMs(timestamp) - timestampMs(record.timestamp)) < 2 * 60 * 1000);
  let status = "Registrado";
  const flags = [];
  const authorizedPhone = normalizePhone(employee.phone);
  const senderPhone = normalizePhone(incomingPhone || employee.phone);

  if (event === "entrada") {
    const startMinutes = minutesFromTime(employee.start);
    status = minutesFromDate(timestamp) > startMinutes + state.policy.tolerance ? "Retardo" : "A tiempo";
  }

  if (senderPhone !== authorizedPhone) flags.push("Telefono no autorizado");
  if (state.policy.requireGps && !hasGps) flags.push("GPS faltante");
  if (hasGps && employee.mode !== "Remoto" && distance > state.policy.geofenceRadius) flags.push("Fuera de geocerca");
  if (state.policy.requireSelfie && !evidence) flags.push("Evidencia faltante");
  if (duplicate) flags.push("Registro duplicado");

  if (flags.length) {
    status = status === "A tiempo" ? "Revision" : status;
    flags.forEach((flag) => addAlert(flag, employee, `${flag} en ${event}.`));
  }

  if (["vacaciones", "permiso", "incapacidad"].includes(event)) {
    state.issues.unshift({ id: makeId(), employeeId, employeeName: employee.name, type: event, detail: message, evidence, status: "Pendiente", timestamp });
    status = "Incidencia";
  }

  if (event === "saldo") {
    status = "Consulta";
  }

  const record = {
    id: makeId(),
    employeeId,
    employeeName: employee.name,
    branchId: employee.branchId,
    event,
    message,
    location: location || (hasGps ? `${lat.toFixed(5)}, ${lng.toFixed(5)}` : "Sin ubicacion"),
    lat,
    lng,
    distance,
    evidence,
    suspicious: flags.length > 0,
    flags,
    status,
    timestamp
  };

  state.records.unshift(record);
  state.chat.unshift({ id: makeId(), employeeName: employee.name, message, response: buildResponse(employee, event, status, flags), timestamp });
  addAudit("Mensaje WhatsApp", `${employee.name}: ${message}`);
  refreshAlerts();
  saveState();
  render();
}

function buildResponse(employee, event, status, flags) {
  if (event === "saldo") return `${employee.name}, tienes ${employee.vacationDays} dias de vacaciones disponibles.`;
  const labels = { entrada: "entrada", salida: "salida", descanso: "descanso", regreso: "regreso", vacaciones: "vacaciones", permiso: "permiso", incapacidad: "incapacidad", mensaje: "mensaje" };
  const suffix = flags.length ? ` Observaciones: ${flags.join(", ")}.` : "";
  return `${employee.name}, registramos tu ${labels[event]} con estado: ${status}.${suffix}`;
}

function refreshAlerts() {
  activeEmployees().forEach((employee) => {
    const records = recordsForDay(employee.id);
    const workState = currentWorkState(employee.id);
    const start = minutesFromTime(employee.start);
    const current = minutesFromDate(new Date());
    if (!records.some((record) => record.event === "entrada") && current > start + state.policy.tolerance) {
      addAlert("Ausencia", employee, "No registra entrada despues de la tolerancia.", "danger");
    }
    const last = records.sort((a, b) => timestampMs(b.timestamp) - timestampMs(a.timestamp))[0];
    if (workState === "En turno" && last) {
      const hoursOpen = (Date.now() - timestampMs(last.timestamp)) / 1000 / 60 / 60;
      if (hoursOpen > state.policy.forgottenExitHours) addAlert("Salida olvidada", employee, "Jornada abierta por demasiadas horas.", "warn");
    }
  });
}

async function updateIssue(id, status) {
  const issue = state.issues.find((item) => item.id === id);
  if (!issue) return;

  if (HAS_BACKEND) {
    const response = await apiFetch(`/api/issues/${id}/status`, { method: "POST", body: { status } });
    if (!response.ok) {
      alert(response.status === 403 ? "No tienes permiso para resolver incidencias." : "No se pudo actualizar la incidencia.");
      return;
    }
    await hydrateFromBackend();
    return;
  }

  issue.status = status;
  issue.resolvedAt = now().toISOString();
  if (issue.type === "vacaciones" && status === "Aprobada") {
    const employee = employeeById(issue.employeeId);
    if (employee) employee.vacationDays = Math.max(0, employee.vacationDays - 1);
  }
  addAudit(`Incidencia ${status}`, `${issue.employeeName}: ${issue.type}`);
  saveState();
  render();
}

async function closeAlert(id) {
  const alertItem = state.alerts.find((item) => item.id === id);
  if (!alertItem) return;

  if (HAS_BACKEND) {
    const response = await apiFetch(`/api/alerts/${id}/status`, { method: "POST", body: { status: "Cerrada" } });
    if (!response.ok) {
      alert(response.status === 403 ? "No tienes permiso para cerrar alertas." : "No se pudo cerrar la alerta.");
      return;
    }
    await hydrateFromBackend();
    return;
  }

  alertItem.status = "Cerrada";
  addAudit("Alerta cerrada", `${alertItem.employeeName}: ${alertItem.type}`);
  saveState();
  render();
}

async function updateSecurityTicketStatus(id, status) {
  if (HAS_BACKEND) {
    const response = await apiFetch(`/api/security/tickets/${id}/status`, {
      method: "POST",
      body: { status }
    });
    if (!response.ok) {
      alert("No se pudo actualizar el ticket.");
      return;
    }
    await hydrateFromBackend();
    return;
  }
  const ticket = (state.securityTickets || []).find((item) => item.id === id);
  if (!ticket) return;
  ticket.status = status;
  ticket.updatedAt = now().toISOString();
  if (status === "Cerrado") ticket.closedAt = now().toISOString();
  (state.securityAlerts || []).forEach((alert) => {
    if (alert.ticketId === id || alert.detail?.includes(ticket.number)) alert.status = status === "Cerrado" ? "Cerrada" : "Activa";
  });
  addAudit("Ticket de seguridad actualizado", `${ticket.number} -> ${status}`);
  saveState();
  render();
}

async function saveEmployee(event) {
  event.preventDefault();
  const id = byId("employeeId").value;
  const branchId = byId("employeeBranch").value || state.selectedBranchId || branchById().id;
  const payload = {
    name: byId("employeeName").value.trim() || "Empleado sin nombre",
    phone: byId("employeePhone").value.trim(),
    area: byId("employeeArea").value.trim() || "General",
    branchId,
    mode: byId("employeeMode").value,
    role: byId("employeeRole").value,
    start: byId("employeeStart").value || "09:00",
    end: byId("employeeEnd").value || "18:00",
    vacationDays: readNumber("employeeVacation", 0, 0),
    active: true
  };

  if (!payload.phone) {
    alert("Captura el telefono autorizado del empleado.");
    return;
  }

  const form = event.target;

  if (HAS_BACKEND) {
    const response = await apiFetch("/api/employees", {
      method: "POST",
      body: id ? { id, ...payload } : payload
    });
    if (!response.ok) {
      alert("No se pudo guardar el empleado.");
      return;
    }
    form.reset();
    resetEmployeeForm();
    await hydrateFromBackend();
    return;
  }

  if (id) {
    const existing = employeeById(id);
    if (existing) Object.assign(existing, payload);
    else state.employees.push({ id, ...payload });
    addAudit("Empleado editado", payload.name);
  } else {
    state.employees.push({ id: makeId(), ...payload });
    addAudit(isEdit ? "Empleado editado" : "Empleado agregado", payload.name);
  }
  form.reset();
  resetEmployeeForm();
  saveState();
  render();
}

function editEmployee(id) {
  const employee = employeeById(id);
  if (!employee) return;
  byId("employeeId").value = employee.id;
  byId("employeeName").value = employee.name;
  byId("employeePhone").value = employee.phone;
  byId("employeeArea").value = employee.area;
  byId("employeeBranch").value = employee.branchId;
  byId("employeeMode").value = employee.mode;
  byId("employeeRole").value = employee.role;
  byId("employeeStart").value = employee.start;
  byId("employeeEnd").value = employee.end;
  byId("employeeVacation").value = employee.vacationDays;
}

async function performDeactivateEmployee(employee) {
  if (HAS_BACKEND) {
    const response = await apiFetch(`/api/employees/${employee.id}`, { method: "DELETE" });
    if (!response.ok) {
      return { ok: false, message: response.status === 403 ? "No tienes permiso para dar de baja empleados." : "No se pudo dar de baja al empleado." };
    }
    await hydrateFromBackend();
    return { ok: true };
  }
  employee.active = false;
  addAudit("Empleado dado de baja", employee.name);
  saveState();
  render();
  return { ok: true };
}

async function deactivateEmployee(id) {
  const employee = employeeById(id);
  if (!employee) return;
  if (!confirm(`¿Dar de baja a ${employee.name}? Dejara de aparecer como empleado activo y no podra checar por WhatsApp.`)) return;
  const result = await performDeactivateEmployee(employee);
  if (!result.ok) alert(result.message);
}

function resetEmployeeForm() {
  byId("employeeId").value = "";
  byId("employeeStart").value = "09:00";
  byId("employeeEnd").value = "18:00";
  byId("employeeVacation").value = "12";
}

function statusClass(value) {
  if (["A tiempo", "Registrado", "Jornada cerrada", "Aprobada", "Consulta", "Activo"].includes(value)) return "ok";
  if (["Retardo", "Revision", "Pendiente", "En descanso"].includes(value)) return "warn";
  return "danger";
}

function scoreClass(score) {
  if (score >= 82) return "ok";
  if (score >= 62) return "warn";
  return "danger";
}

function getDashboardMetrics() {
  const employees = activeEmployees();
  const today = dayKey(new Date());
  const todayRecords = state.records.filter((record) => record.branchId === state.selectedBranchId && dayKey(record.timestamp) === today);
  const entries = todayRecords.filter((record) => record.event === "entrada").length;
  const late = todayRecords.filter((record) => record.status === "Retardo").length;
  const evidence = todayRecords.filter((record) => record.evidence).length;
  const openIssues = state.issues.filter((issue) => issue.status === "Pendiente").length;
  const openAlerts = state.alerts.filter((alert) => alert.status === "Abierta").length;
  const securityTickets = state.securityTickets || [];
  const openSecurityTickets = securityTickets.filter((ticket) => ticket.status !== "Cerrado").length;
  const highSecurityTickets = securityTickets.filter((ticket) => ticket.severity === "Alta" && ticket.status !== "Cerrado").length;
  const campaigns = state.phishingCampaigns || [];
  const phishingTotals = campaigns.reduce((acc, item) => {
    acc.sent += item.sent || 0;
    acc.clicked += item.clicked || 0;
    acc.reported += item.reported || 0;
    acc.trained += item.trained || 0;
    return acc;
  }, { sent: 0, clicked: 0, reported: 0, trained: 0 });
  const clickRate = phishingTotals.sent ? Math.round((phishingTotals.clicked / phishingTotals.sent) * 100) : 0;
  const reportRate = phishingTotals.sent ? Math.round((phishingTotals.reported / phishingTotals.sent) * 100) : 0;
  const trainingRate = phishingTotals.sent ? Math.round((phishingTotals.trained / phishingTotals.sent) * 100) : 0;
  const attendanceRate = employees.length ? clamp(Math.round((entries / employees.length) * 100)) : 0;
  const evidenceRate = todayRecords.length ? Math.round((evidence / todayRecords.length) * 100) : 0;
  const riskScore = clamp(openAlerts * 14 + openIssues * 10 + late * 8 + highSecurityTickets * 12);
  const operationalScore = clamp(Math.round(100 - riskScore + evidenceRate * 0.15));
  const securityScore = clamp(100 - openSecurityTickets * 8 - highSecurityTickets * 12 + reportRate * 0.15);
  const phishingScore = clamp(100 - clickRate + Math.round(reportRate * 0.4) + Math.round(trainingRate * 0.15));
  const working = employees.filter((employee) => currentWorkState(employee.id) === "En turno").length;
  return {
    employees,
    todayRecords,
    attendanceRate,
    evidenceRate,
    riskScore,
    operationalScore,
    securityScore,
    phishingScore,
    openIssues,
    openAlerts,
    openSecurityTickets,
    highSecurityTickets,
    campaigns,
    clickRate,
    reportRate,
    trainingRate,
    working
  };
}

function renderCommandCenter() {
  const metrics = getDashboardMetrics();
  const riskLabel = metrics.riskScore > 58 ? "Riesgo alto" : metrics.riskScore > 26 ? "Riesgo medio" : "Riesgo bajo";
  byId("modePill").textContent = DEMO_MODE ? "Demo" : "API activa";
  byId("modePill").className = `pill ${DEMO_MODE ? "warn" : "ok"}`;
  byId("riskPill").textContent = riskLabel;
  byId("riskPill").className = `pill ${scoreClass(100 - metrics.riskScore)}`;
  byId("commandNarrative").innerHTML = `
    <strong>${metrics.working} en turno - ${metrics.openSecurityTickets} tickets abiertos - ${metrics.campaigns.length} campanas</strong>
    <span>${riskLabel}. Cobertura ${metrics.attendanceRate}%, evidencia ${metrics.evidenceRate}% y phishing score ${metrics.phishingScore}%.</span>
  `;
  const responseLabel = metrics.openSecurityTickets ? `${Math.min(15, Math.max(3, metrics.openSecurityTickets * 3))} min` : "Al dia";
  const kpis = [
    ["Operacion", `${metrics.operationalScore}%`, `${metrics.openIssues} incidencias abiertas`, metrics.operationalScore],
    ["Seguridad", `${metrics.securityScore}%`, `${metrics.highSecurityTickets} prioridad alta`, metrics.securityScore],
    ["Phishing", `${metrics.phishingScore}%`, `${metrics.reportRate}% reportes`, metrics.phishingScore],
    ["Respuesta", responseLabel, `${metrics.openAlerts} alertas activas`, 100 - metrics.riskScore]
  ];
  byId("commandKpis").innerHTML = kpis.map(([label, value, detail, score]) => `
    <div class="kpi-tile ${scoreClass(score)}">
      <span>${label}</span>
      <strong>${value}</strong>
      <small>${detail}</small>
    </div>
  `).join("");
}

function renderSelectors() {
  byId("companySelect").innerHTML = state.companies.map((company) => `<option value="${escapeAttr(company.id)}">${escapeHtml(company.name)}</option>`).join("");
  byId("companySelect").value = state.selectedCompanyId;
  const branches = state.branches.filter((branch) => branch.companyId === state.selectedCompanyId);
  if (!branches.some((branch) => branch.id === state.selectedBranchId)) {
    state.selectedBranchId = branches[0]?.id || state.branches[0]?.id || "";
  }
  const branchOptions = branches.length
    ? branches.map((branch) => `<option value="${escapeAttr(branch.id)}">${escapeHtml(branch.name)}</option>`).join("")
    : `<option value="">Sin sucursales</option>`;
  byId("branchSelect").innerHTML = branchOptions;
  byId("branchSelect").value = state.selectedBranchId;
  byId("employeeBranch").innerHTML = branchOptions;
  byId("employeeBranch").value = state.selectedBranchId;
  const employees = activeEmployees();
  const employeeOptions = employees.length
    ? employees.map((employee) => `<option value="${escapeAttr(employee.id)}">${escapeHtml(employee.name)} - ${escapeHtml(employee.phone)}</option>`).join("")
    : `<option value="">Sin empleados activos</option>`;
  byId("employeeSelect").innerHTML = employeeOptions;
  byId("securityEmployee").innerHTML = employees.length
    ? employees.map((employee) => `<option value="${escapeAttr(employee.id)}">${escapeHtml(employee.name)} - ${escapeHtml(employee.area)}</option>`).join("")
    : `<option value="">Sin empleados activos</option>`;
  const areas = ["Todas", ...new Set(state.employees.filter((employee) => employee.active).map((employee) => employee.area))];
  byId("reportArea").innerHTML = areas.map((area) => `<option>${escapeHtml(area)}</option>`).join("");
  byId("reportArea").value = state.report.area;
  const departments = ["Todos", ...new Set(state.employees.filter((employee) => employee.active).map((employee) => employee.area))];
  byId("campaignDepartment").innerHTML = departments.map((area) => `<option>${escapeHtml(area)}</option>`).join("");
  byId("campaignTemplate").innerHTML = state.phishingTemplates.map((template) => `<option>${escapeHtml(template.name)}</option>`).join("");
}

function renderEmployees() {
  const employees = state.employees.filter((employee) => employee.branchId === state.selectedBranchId);
  byId("employeeList").innerHTML = employees.length
    ? employees.map((employee) => {
      const hours = calculateWorkedHours(employee.id).toFixed(1);
      const active = employee.active ? "Activo" : "Baja";
      return `
        <div class="row-card">
          <div>
            <strong>${escapeHtml(employee.name)}</strong>
            <span>${escapeHtml(employee.phone)} - ${escapeHtml(employee.area)} - ${escapeHtml(employee.role)} - ${escapeHtml(employee.mode)} - ${escapeHtml(employee.start)}-${escapeHtml(employee.end)}</span>
          </div>
          <div class="row-actions">
            <span class="pill ${statusClass(active)}">${active}</span>
            <span class="pill ok">${hours} h hoy</span>
            <button data-action="edit-employee" data-id="${escapeAttr(employee.id)}">Editar</button>
            <button data-action="deactivate-employee" data-id="${escapeAttr(employee.id)}">Baja</button>
          </div>
        </div>
      `;
    })
    .join("")
    : emptyState("Sin empleados en esta sucursal.");
}

function renderRecords() {
  const rows = state.records
    .filter((record) => record.branchId === state.selectedBranchId)
    .slice(0, 60)
    .map((record) => `
      <tr>
        <td>${formatDate(record.timestamp)}</td>
        <td>${escapeHtml(record.employeeName)}</td>
        <td>${escapeHtml(record.event)}${record.evidence ? " + evidencia" : ""}</td>
        <td>${formatTime(record.timestamp)}</td>
        <td>${escapeHtml(branchById(record.branchId).name)}</td>
        <td>${escapeHtml(record.location)}${record.distance ? ` (${Math.round(record.distance)} m)` : ""}</td>
        <td><span class="pill ${statusClass(record.status)}">${escapeHtml(record.status)}</span></td>
      </tr>
    `)
    .join("");
  byId("recordsTable").innerHTML = rows || `<tr><td colspan="7">Sin registros en esta sucursal.</td></tr>`;
}

function renderIssues() {
  byId("issuesList").innerHTML = state.issues.length
    ? state.issues.map((issue) => `
      <div class="row-card">
        <div>
          <strong>${escapeHtml(issue.employeeName)} - ${escapeHtml(issue.type)}</strong>
          <span>${escapeHtml(issue.detail)} - ${formatDate(issue.timestamp)} ${formatTime(issue.timestamp)}</span>
        </div>
        <div class="row-actions">
          <span class="pill ${statusClass(issue.status)}">${issue.status}</span>
          <button data-action="approve-issue" data-id="${escapeAttr(issue.id)}">Aprobar</button>
          <button data-action="reject-issue" data-id="${escapeAttr(issue.id)}">Rechazar</button>
        </div>
      </div>
    `).join("")
    : emptyState("Sin incidencias por revisar.");
}

function renderBalances() {
  const employees = activeEmployees();
  byId("balancesList").innerHTML = employees.length ? employees.map((employee) => `
    <div class="row-card">
      <div><strong>${escapeHtml(employee.name)}</strong><span>${escapeHtml(employee.area)} - ${escapeHtml(employee.phone)}</span></div>
      <span class="pill ok">${employee.vacationDays} dias disponibles</span>
    </div>
  `).join("") : emptyState("Sin empleados activos en esta sucursal.");
}

function renderChat() {
  byId("chatLog").innerHTML = state.chat.length ? state.chat.slice(0, 10).flatMap((item) => [
    `<div class="bubble"><strong>${escapeHtml(item.employeeName)}</strong><br>${escapeHtml(item.message)}<small>${formatTime(item.timestamp)}</small></div>`,
    `<div class="bubble system">${escapeHtml(item.response)}<small>Bot RRHH</small></div>`
  ]).join("") : emptyState("Sin conversaciones recientes.");
}

function renderWorkingNow() {
  const employees = activeEmployees();
  byId("workingNowList").innerHTML = employees.length ? employees.map((employee) => {
    const workState = currentWorkState(employee.id);
    return `<div class="row-card"><div><strong>${escapeHtml(employee.name)}</strong><span>${escapeHtml(employee.area)} - ${escapeHtml(employee.start)}-${escapeHtml(employee.end)}</span></div><span class="pill ${statusClass(workState)}">${workState}</span></div>`;
  }).join("") : emptyState("Sin empleados activos en esta sucursal.");
}

function renderAlerts() {
  refreshAlerts();
  const open = state.alerts.filter((alert) => alert.status === "Abierta").slice(0, 12);
  byId("alertsList").innerHTML = open.length
    ? open.map((alert) => `
      <div class="row-card">
        <div><strong>${escapeHtml(alert.employeeName)} - ${escapeHtml(alert.type)}</strong><span>${escapeHtml(alert.detail)} - ${formatTime(alert.timestamp)}</span></div>
        <div class="row-actions"><span class="pill ${alert.severity === "danger" ? "danger" : "warn"}">${escapeHtml(alert.status)}</span><button data-action="close-alert" data-id="${escapeAttr(alert.id)}">Cerrar</button></div>
      </div>
    `).join("")
    : emptyState("Sin alertas activas.");
}

function renderSummary() {
  const records = recordsForReport();
  const rows = activeEmployees().map((employee) => {
    const employeeRecords = records.filter((record) => record.employeeId === employee.id);
    const late = employeeRecords.filter((record) => record.status === "Retardo").length;
    const worked = calculateWorkedHours(employee.id);
    const overtime = Math.max(0, worked - state.policy.overtimeAfterHours);
    return { employee, late, worked, overtime, records: employeeRecords.length };
  });
  byId("summaryList").innerHTML = rows.length ? rows.map((row) => `
    <div class="row-card">
      <div><strong>${escapeHtml(row.employee.name)}</strong><span>${row.records} registros - ${row.late} retardos - ${row.worked.toFixed(1)} h trabajadas - ${row.overtime.toFixed(1)} h extra</span></div>
      <span class="pill ${row.late ? "warn" : "ok"}">${escapeHtml(row.employee.area)}</span>
    </div>
  `).join("") : emptyState("Sin empleados activos para resumir.");
  byId("metricWorking").textContent = rows.filter((row) => currentWorkState(row.employee.id) === "En turno").length;
  const today = dayKey(new Date());
  byId("metricLate").textContent = state.records.filter((record) => record.status === "Retardo" && dayKey(record.timestamp) === today).length;
  byId("metricOvertime").textContent = rows.reduce((total, row) => total + row.overtime, 0).toFixed(1);
  byId("metricOpenIssues").textContent = state.issues.filter((issue) => issue.status === "Pendiente").length;
  byId("metricAlerts").textContent = state.alerts.filter((alert) => alert.status === "Abierta").length;
}

function renderExecutiveInsights() {
  const metrics = getDashboardMetrics();
  const rows = [
    ["Cobertura de asistencia", metrics.attendanceRate, "ok"],
    ["Evidencia verificada", metrics.evidenceRate, "ok"],
    ["Operacion al dia", metrics.operationalScore, metrics.operationalScore > 80 ? "ok" : "warn"],
    ["Riesgo operativo", metrics.riskScore, metrics.riskScore > 45 ? "danger" : "warn"]
  ];

  byId("healthInsights").innerHTML = rows.map(([label, value, kind]) => `
    <div class="insight-row">
      <div>
        <strong>${label}</strong>
        <span>${value}%</span>
      </div>
      <div class="bar"><i class="${kind}" style="width:${percent(value)}%"></i></div>
    </div>
  `).join("");
}

function renderGeoMap() {
  const branch = branchById(state.selectedBranchId);
  const branchLat = branchCoordinate(branch, "lat");
  const branchLng = branchCoordinate(branch, "lng");
  const visibleRecords = state.records
    .filter((record) => record.branchId === state.selectedBranchId)
    .filter((record) => Number.isFinite(Number(record.lat)) && Number.isFinite(Number(record.lng)))
    .slice(0, 5);
  const pins = visibleRecords.map((record, index) => {
    const left = percent(Math.max(12, Math.min(88, 50 + (Number(record.lng) - branchLng) * 900 + index * 5)));
    const top = percent(Math.max(16, Math.min(82, 50 - (Number(record.lat) - branchLat) * 900 + index * 4)));
    const kind = record.status === "Retardo" || record.suspicious ? "warn" : "ok";
    return `<button class="map-pin ${kind}" style="left:${left}%;top:${top}%" title="${escapeAttr(`${record.employeeName} - ${record.status}`)}"></button>`;
  }).join("");

  byId("geoMap").innerHTML = `
    <div class="map-grid"></div>
    <div class="map-radius"></div>
    <div class="map-branch"><strong>${escapeHtml(branch.name)}</strong><span>${branchLat.toFixed(4)}, ${branchLng.toFixed(4)}</span></div>
    ${pins || `<button class="map-pin ok" style="left:52%;top:48%" title="Sucursal base"></button>`}
    <div class="map-legend">
      <span><i class="ok"></i> A tiempo</span>
      <span><i class="warn"></i> Revision</span>
    </div>
  `;
}

function renderCalendar() {
  const date = new Date(`${state.report.from}T12:00:00`);
  const days = Array.from({ length: 30 }, (_, index) => {
    const day = new Date(date);
    day.setDate(date.getDate() + index);
    const dayRecords = state.records.filter((record) => dayKey(record.timestamp) === dayKey(day) && record.branchId === state.selectedBranchId);
    const late = dayRecords.some((record) => record.status === "Retardo");
    const cls = dayRecords.length ? (late ? "warn" : "ok") : "";
    return `<div class="day ${cls}"><strong>${day.getDate()}</strong><span>${dayRecords.length} reg.</span></div>`;
  });
  byId("calendarGrid").innerHTML = days.join("");
}

function renderPolicy() {
  byId("policyTolerance").value = state.policy.tolerance;
  byId("policyForgottenExit").value = state.policy.forgottenExitHours;
  byId("policyRadius").value = state.policy.geofenceRadius;
  byId("policyOvertimeAfter").value = state.policy.overtimeAfterHours;
  byId("policyRequireGps").checked = state.policy.requireGps;
  byId("policyRequireSelfie").checked = state.policy.requireSelfie;
}

function renderBranches() {
  const branches = state.branches.filter((branch) => branch.companyId === state.selectedCompanyId);
  byId("branchList").innerHTML = branches.length ? branches.map((branch) => `
    <div class="row-card"><div><strong>${escapeHtml(branch.name)}</strong><span>${branchCoordinate(branch, "lat")}, ${branchCoordinate(branch, "lng")} - radio ${escapeHtml(state.policy.geofenceRadius)} m</span></div><span class="pill ${branch.id === state.selectedBranchId ? "ok" : "warn"}">${branch.id === state.selectedBranchId ? "Actual" : "Disponible"}</span></div>
  `).join("") : emptyState("Sin sucursales configuradas.");
}

function renderIntegrations() {
  const health = integrationHealth || {};
  const modeLabel = HAS_BACKEND ? "Backend conectado" : "Demo local";
  const statusPill = (ok) => `<span class="pill ${ok ? "ok" : "warn"}">${ok ? "Activo" : "Por configurar"}</span>`;
  byId("integrationStatus").innerHTML = `
    <div class="row-card"><div><strong>Modo de operacion</strong><span>${modeLabel}</span></div><span class="pill ${HAS_BACKEND ? "ok" : "warn"}">${HAS_BACKEND ? "API" : "Demo"}</span></div>
    <div class="row-card"><div><strong>Webhook WhatsApp</strong><span>/webhooks/whatsapp para asistencia, evidencias e incidentes.</span></div>${statusPill(Boolean(health.whatsappConfigured))}</div>
    <div class="row-card"><div><strong>SendGrid correo</strong><span>Campanas de phishing por email con tracking.</span></div>${statusPill(Boolean(health.sendgridConfigured))}</div>
    <div class="row-card"><div><strong>Twilio SMS</strong><span>Campanas por SMS y enlaces medibles.</span></div>${statusPill(Boolean(health.twilioConfigured))}</div>
    <div class="row-card"><div><strong>Tracking publico</strong><span>${escapeHtml(health.publicBaseUrl || "Configura PUBLIC_BASE_URL para links reales.")}</span></div><span class="pill ok">Incluido</span></div>
    <div class="row-card"><div><strong>Validacion de telefono</strong><span>El empleado solo puede checar desde su numero registrado.</span></div><span class="pill ok">Incluido</span></div>
    <div class="row-card"><div><strong>Tickets y reportes</strong><span>Security Assistant y Phishing Simulator ya usan tablas propias.</span></div><span class="pill ok">Incluido</span></div>
    <div class="row-card"><div><strong>DOGUI Joule (IA generativa)</strong><span>Skills de asistencia, seguridad y phishing incluidas siempre. Lenguaje libre via Claude cuando hay ANTHROPIC_API_KEY.</span></div>${statusPill(Boolean(health.jouleConfigured))}</div>
  `;
}

function renderSecurityAssistant() {
  const tickets = state.securityTickets || [];
  const openTickets = tickets.filter((ticket) => ticket.status !== "Cerrado").length;
  const highTickets = tickets.filter((ticket) => ticket.severity === "Alta").length;
  const responseRate = tickets.length ? Math.round((tickets.filter((ticket) => ticket.response).length / tickets.length) * 100) : 0;
  byId("securitySuiteStats").innerHTML = `
    <span class="pill ${openTickets ? "warn" : "ok"}">${openTickets} abiertos</span>
    <span class="pill ${highTickets ? "danger" : "ok"}">${highTickets} alta prioridad</span>
    <span class="pill ok">${responseRate}% auto-respuesta</span>
  `;
  byId("securityAutoResponse").innerHTML = `
    <strong>${openTickets} tickets activos</strong>
    <span>${highTickets} de prioridad alta. ${responseRate}% con respuesta automatica lista.</span>
  `;
  byId("securityTickets").innerHTML = tickets.slice(0, 8).map((ticket) => `
    <div class="ticket-card ${ticket.severity === "Alta" ? "critical" : ""}">
      <div>
        <span>${escapeHtml(ticket.number)} - ${escapeHtml(ticket.sourceChannel || "Panel")}</span>
        <strong>${escapeHtml(ticket.type)}</strong>
        <p>${escapeHtml(ticket.detail)}</p>
      </div>
      <div>
        <span class="pill ${ticket.severity === "Alta" ? "danger" : "warn"}">${escapeHtml(ticket.severity)}</span>
        <small>${escapeHtml(ticket.employeeName)} - ${escapeHtml(ticket.department)}</small>
        <small>${escapeHtml(ticket.status)}</small>
        <div class="ticket-actions">
          <button data-action="review-security" data-id="${escapeAttr(ticket.id)}">Revisar</button>
          <button data-action="close-security" data-id="${escapeAttr(ticket.id)}">Cerrar</button>
        </div>
      </div>
    </div>
  `).join("") || emptyState("Sin tickets de seguridad.");
  byId("securityAlerts").innerHTML = (state.securityAlerts || []).slice(0, 6).map((alert) => `
    <div class="row-card">
      <div><strong>${escapeHtml(alert.title)}</strong><span>${escapeHtml(alert.detail)}</span></div>
      <span class="pill ${alert.severity === "Alta" ? "danger" : "warn"}">${escapeHtml(alert.status)}</span>
    </div>
  `).join("") || emptyState("Sin alertas internas.");
}

function renderPhishingSimulator() {
  const campaigns = state.phishingCampaigns || [];
  const dashboard = getDashboardMetrics();
  const clickRate = dashboard.clickRate;
  const reportRate = dashboard.reportRate;
  const trainingRate = dashboard.trainingRate;
  const resilience = dashboard.phishingScore;
  byId("phishingSuiteStats").innerHTML = `
    <span class="pill ${campaigns.length ? "ok" : "warn"}">${campaigns.length} campanas</span>
    <span class="pill ${clickRate > 30 ? "danger" : clickRate > 15 ? "warn" : "ok"}">${clickRate}% clics</span>
    <span class="pill ${resilience > 80 ? "ok" : "warn"}">${resilience}% score</span>
  `;
  const metrics = [
    ["Clics", clickRate, "danger"],
    ["Reportes", reportRate, "ok"],
    ["Capacitacion", trainingRate, "ok"],
    ["Resiliencia", resilience, "ok"]
  ];
  byId("phishingMetrics").innerHTML = metrics.map(([label, value, kind]) => `
    <div class="insight-row">
      <div><strong>${label}</strong><span>${value}%</span></div>
      <div class="bar"><i class="${kind}" style="width:${percent(value)}%"></i></div>
    </div>
  `).join("");
  byId("phishingTemplates").innerHTML = state.phishingTemplates.map((template) => `
    <div class="template-card">
      <span>${escapeHtml(template.channel)}</span>
      <strong>${escapeHtml(template.name)}</strong>
      <small>${escapeHtml(template.category)} - Riesgo ${escapeHtml(template.risk)}</small>
    </div>
  `).join("") || emptyState("Sin plantillas configuradas.");
  const departments = [...new Set(activeEmployees().map((employee) => employee.area))];
  byId("departmentScores").innerHTML = departments.length ? departments.map((department) => {
    const deptCampaigns = campaigns.filter((campaign) => campaign.department === department || campaign.department === "Todos");
    const sent = deptCampaigns.reduce((sum, campaign) => sum + campaign.sent, 0);
    const clicked = deptCampaigns.reduce((sum, campaign) => sum + campaign.clicked, 0);
    const reported = deptCampaigns.reduce((sum, campaign) => sum + campaign.reported, 0);
    const score = sent ? percent(100 - Math.round((clicked / sent) * 100) + Math.round((reported / sent) * 35)) : 86;
    return `<div class="score-row"><strong>${escapeHtml(department)}</strong><span>${score}</span><div class="bar"><i class="${score > 80 ? "ok" : "warn"}" style="width:${score}%"></i></div></div>`;
  }).join("") : emptyState("Sin departamentos activos.");
  const latest = campaigns[0];
  byId("monthlySecurityReport").innerHTML = latest ? `
    <div class="report-card">
      <strong>${escapeHtml(latest.name)}</strong>
      <span>${escapeHtml(latest.channel)} - ${escapeHtml(latest.template)} - ${escapeHtml(latest.department)} - ${escapeHtml(latest.status || "Activa")}</span>
      <div class="report-stats">
        <div><strong>${escapeHtml(latest.sent || 0)}</strong><span>enviados</span></div>
        <div><strong>${escapeHtml(latest.clicked || 0)}</strong><span>clics</span></div>
        <div><strong>${escapeHtml(latest.reported || 0)}</strong><span>reportes</span></div>
        <div><strong>${escapeHtml(latest.trained || 0)}</strong><span>capacitados</span></div>
        <div><strong>${escapeHtml(latest.score || resilience)}</strong><span>score</span></div>
      </div>
    </div>
  ` : emptyState("Sin campanas simuladas.");
}

function renderAudit() {
  byId("auditList").innerHTML = state.audit.slice(0, 30).map((item) => `
    <div class="row-card"><div><strong>${escapeHtml(item.action)}</strong><span>${escapeHtml(item.detail)} - ${escapeHtml(item.user)} (${escapeHtml(item.role)})</span></div><span>${formatDate(item.timestamp)} ${formatTime(item.timestamp)}</span></div>
  `).join("") || emptyState("Sin movimientos de auditoria.");
}

function jouleUpdateBadge() {
  const badge = byId("jouleBadge");
  if (!session) {
    badge.hidden = true;
    return;
  }
  const metrics = getDashboardMetrics();
  const pending = metrics.openIssues + metrics.highSecurityTickets + metrics.openAlerts;
  badge.textContent = pending > 9 ? "9+" : String(pending);
  badge.hidden = pending === 0 || jouleOpen;
}

function renderSession() {
  byId("loginScreen").classList.toggle("hidden", Boolean(session));
  byId("jouleLauncher").classList.toggle("hidden", !session);
  if (!session) jouleClosePanel();
  const mode = DEMO_MODE ? "Demo GitHub Pages" : "Backend conectado";
  const company = state.companies.find((item) => item.id === state.selectedCompanyId) || state.companies[0] || { name: "DOGUI" };
  byId("sessionLabel").textContent = session ? `${company.name} - ${session.user} - ${session.role} - ${mode}` : `${company.name} - ${mode}`;
  byId("backendWarning").hidden = !(HAS_BACKEND && backendUnreachable);
  jouleUpdateBadge();
}

function render() {
  renderSession();
  renderSelectors();
  renderEmployees();
  renderRecords();
  renderIssues();
  renderBalances();
  renderChat();
  renderWorkingNow();
  renderAlerts();
  renderCommandCenter();
  renderSummary();
  renderExecutiveInsights();
  renderGeoMap();
  renderCalendar();
  renderPolicy();
  renderBranches();
  renderIntegrations();
  renderSecurityAssistant();
  renderPhishingSimulator();
  renderAudit();
  if (jouleOpen) jouleRenderQuickPrompts();
}

function downloadCsv() {
  const header = ["fecha", "hora", "empleado", "area", "sucursal", "evento", "ubicacion", "distancia_m", "estado", "evidencia", "observaciones", "mensaje"];
  const rows = recordsForReport().map((record) => {
    const employee = employeeById(record.employeeId);
    return [formatDate(record.timestamp), formatTime(record.timestamp), record.employeeName, employee?.area || "", branchById(record.branchId).name, record.event, record.location, Math.round(record.distance || 0), record.status, record.evidence ? "si" : "no", (record.flags || []).join(" | "), record.message];
  });
  const csv = [header, ...rows].map((row) => row.map((cell) => `"${String(cell).replaceAll('"', '""')}"`).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `reporte-asistencia-dogui-${state.report.from}-${state.report.to}.csv`;
  link.click();
  URL.revokeObjectURL(link.href);
}

/* DOGUI Joule: copiloto conversacional inspirado en SAP Joule.
   Capa de skills deterministas (siempre activa) sobre el mismo `state` del panel,
   mas una capa opcional de lenguaje libre via backend + Claude cuando esta configurada. */
const JOULE_HISTORY_KEY = "dogui-joule-history";
let jouleHistory = JSON.parse(sessionStorage.getItem(JOULE_HISTORY_KEY) || "[]");
let jouleOpen = false;
let jouleBusy = false;
let jouleConfirmAction = null;

const JOULE_CONFIRM_WORDS = /^(si|sí|confirmar|confirmo|dale|ok|de acuerdo|adelante)\b/;

function jouleRequestConfirmation(promptText, run) {
  jouleConfirmAction = { run };
  return `${promptText} Responde "si" para confirmar o cualquier otra cosa para cancelar.`;
}

function jouleGreetingName() {
  return session?.user?.split("@")[0] || "equipo";
}

function currentJouleView() {
  return (location.hash || "#tablero").replace("#", "");
}

// Memoria conversacional corta: el ultimo empleado/ticket mencionado explicitamente,
// para que preguntas de seguimiento ("y cuantos dias tiene?") no requieran repetir el nombre.
let jouleLastEmployeeId = null;
let jouleLastTicketId = null;

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const rows = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) rows[i][0] = i;
  for (let j = 0; j <= b.length; j++) rows[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      rows[i][j] = a[i - 1] === b[j - 1] ? rows[i - 1][j - 1] : 1 + Math.min(rows[i - 1][j - 1], rows[i - 1][j], rows[i][j - 1]);
    }
  }
  return rows[a.length][b.length];
}

function findEmployeeFuzzy(text, pool) {
  const words = text.split(/[^a-zA-ZÀ-ÿ]+/).filter((word) => word.length > 3);
  let best = null;
  let bestDistance = 2;
  pool.forEach((employee) => {
    employee.name
      .toLowerCase()
      .split(/\s+/)
      .filter((nameWord) => nameWord.length > 3)
      .forEach((nameWord) => {
        words.forEach((word) => {
          const distance = levenshtein(word, nameWord);
          if (distance < bestDistance) {
            bestDistance = distance;
            best = employee;
          }
        });
      });
  });
  return best;
}

function findEmployeeForQuery(rawText, { useContext = true } = {}) {
  const text = rawText.toLowerCase();
  const active = state.employees.filter((employee) => employee.active);
  const explicit =
    active.find((employee) => text.includes(employee.name.toLowerCase())) ||
    active.find((employee) => text.includes(employee.name.toLowerCase().split(" ")[0])) ||
    findEmployeeFuzzy(text, active);
  if (explicit) {
    jouleLastEmployeeId = explicit.id;
    return explicit;
  }
  if (useContext && jouleLastEmployeeId) {
    const remembered = employeeById(jouleLastEmployeeId);
    if (remembered && remembered.active) return remembered;
  }
  return null;
}

function findPendingIssueForEmployee(employee, type) {
  return state.issues.find((issue) => issue.employeeId === employee.id && issue.status === "Pendiente" && (!type || issue.type === type));
}

function findBranchForQuery(rawText) {
  const text = rawText.toLowerCase();
  return state.branches.find((branch) => text.includes(branch.name.toLowerCase()));
}

function findTicketForQuery(rawText) {
  const numberMatch = rawText.toUpperCase().match(/DG-\d+/);
  if (numberMatch) {
    const ticket = (state.securityTickets || []).find((item) => item.number === numberMatch[0]);
    if (ticket) jouleLastTicketId = ticket.id;
    return ticket;
  }
  const employee = findEmployeeForQuery(rawText, { useContext: false });
  if (employee) {
    const ticket = (state.securityTickets || []).find((item) => item.employeeId === employee.id && item.status !== "Cerrado");
    if (ticket) {
      jouleLastTicketId = ticket.id;
      return ticket;
    }
  }
  if (jouleLastTicketId) {
    const remembered = (state.securityTickets || []).find((item) => item.id === jouleLastTicketId);
    if (remembered) return remembered;
  }
  return null;
}

function jouleBriefing() {
  const metrics = getDashboardMetrics();
  const riskLabel = metrics.riskScore > 58 ? "alto" : metrics.riskScore > 26 ? "medio" : "bajo";
  const lines = [
    `Hola ${jouleGreetingName()}, esto es lo importante ahora mismo:`,
    `${metrics.working} de ${metrics.employees.length} activos en turno - riesgo ${riskLabel}.`
  ];
  if (metrics.openIssues) lines.push(`${metrics.openIssues} incidencia(s) pendiente(s) de aprobar.`);
  if (metrics.highSecurityTickets) lines.push(`${metrics.highSecurityTickets} ticket(s) de seguridad de prioridad alta sin cerrar.`);
  if (metrics.openAlerts) lines.push(`${metrics.openAlerts} alerta(s) operativa(s) activa(s).`);
  if (!metrics.openIssues && !metrics.highSecurityTickets && !metrics.openAlerts) lines.push("No hay pendientes criticos. Todo en orden.");
  return lines.join("\n");
}

function jouleQuickPrompts() {
  const sampleEmployee = activeEmployees()[0]?.name || "un empleado";
  const pendingIssue = state.issues.find((issue) => issue.status === "Pendiente");
  const byView = {
    seguridad: ["Resume el riesgo de seguridad", "Cuantos tickets de prioridad alta hay abiertos", "Todos los tickets"],
    phishing: ["Como va el score de phishing", "Que campanas hay"],
    incidencias: pendingIssue ? [`Aprueba la incidencia de ${pendingIssue.employeeName}`, "Que incidencias estan pendientes"] : ["Que incidencias estan pendientes"],
    empleados: [`Cuantos dias de vacaciones tiene ${sampleEmployee}`, "Quien esta trabajando ahora", "Cuantos empleados activos hay"],
    configuracion: ["Cual es la politica actual", "Que sucursales hay"],
    reportes: ["Reporte de esta semana", "Exporta el reporte de asistencia"],
    auditoria: ["Que ha pasado hoy"]
  };
  return byView[currentJouleView()] || ["Quien esta trabajando ahora", "Resume el riesgo de hoy", "Que incidencias estan pendientes", "Llevame a reportes"];
}

async function jouleCreateSecurityTicket(employee, type, detail, severity) {
  if (HAS_BACKEND) {
    const response = await apiFetch("/api/security/tickets", {
      method: "POST",
      body: { employeeId: employee.id, type, detail, severity, sourceChannel: "Joule" }
    });
    if (!response.ok) return null;
    const payload = await response.json();
    await hydrateFromBackend();
    return payload.ticket;
  }
  const ticket = securityTicketSeed(employee, type, detail, severity);
  state.securityTickets.unshift(ticket);
  state.securityAlerts.unshift({
    id: makeId(),
    title: `${ticket.severity}: ${ticket.type}`,
    detail: `${ticket.employeeName} reporto: ${ticket.detail}`,
    severity: ticket.severity,
    status: "Activa",
    timestamp: ticket.timestamp
  });
  addAudit("Ticket de seguridad creado desde Joule", `${ticket.number} - ${ticket.type}`);
  saveState();
  render();
  return ticket;
}

async function jouleCreateTicketFromText(raw) {
  const employee = findEmployeeForQuery(raw) || activeEmployees()[0];
  if (!employee) return "No hay empleados activos para asociar el ticket.";
  const typeKeywords = { "link sospechoso": "Link sospechoso", "correo falso": "Correo falso", "archivo raro": "Archivo raro", sat: "Fraude SAT", banco: "Fraude bancario", fraude: "Fraude" };
  const lower = raw.toLowerCase();
  const matchedType = Object.entries(typeKeywords).find(([key]) => lower.includes(key));
  const type = matchedType ? matchedType[1] : "Reporte";
  const ticket = await jouleCreateSecurityTicket(employee, type, raw, "Media");
  if (!ticket) return "No se pudo crear el ticket, intenta de nuevo.";
  return `Ticket ${ticket.number} creado para ${employee.name} (${type}).${ticket.response ? ` ${ticket.response}` : ""}`;
}

function jouleResolveIssue(raw, status) {
  // Para esta accion, un empleado explicito en el mensaje manda sobre la memoria de
  // conversacion: "apruebala"/"aprueba la incidencia" debe resolver a la unica pendiente
  // en vez de a quien se menciono antes por otro motivo (ej. una consulta de estado).
  const explicitEmployee = findEmployeeForQuery(raw, { useContext: false });
  const actionWord = status === "Aprobada" ? "aprueba" : "rechaza";
  const typeMatch = ["vacaciones", "permiso", "incapacidad"].find((type) => raw.toLowerCase().includes(type));

  if (explicitEmployee) {
    const issue = findPendingIssueForEmployee(explicitEmployee, typeMatch);
    if (!issue) return `${explicitEmployee.name} no tiene incidencias pendientes${typeMatch ? ` de ${typeMatch}` : ""}.`;
    updateIssue(issue.id, status);
    return `Listo. Marque la incidencia de ${issue.type} de ${explicitEmployee.name} como "${status}".`;
  }

  const pending = state.issues.filter((issue) => issue.status === "Pendiente" && (!typeMatch || issue.type === typeMatch));
  if (pending.length === 1) {
    updateIssue(pending[0].id, status);
    return `Como solo tenias una incidencia pendiente, marque la de ${pending[0].type} de ${pending[0].employeeName} como "${status}".`;
  }
  return `Dime de quien es la incidencia. Por ejemplo: "${actionWord} las vacaciones de ${activeEmployees()[0]?.name || "Ana Lopez"}".`;
}

function jouleListEmployees(raw) {
  const areaMatch = raw.toLowerCase().match(/empleados?\s+(?:de|del?\s+area)\s+([a-záéíóúñ\s]+)/);
  let employees = activeEmployees();
  let label = "activos";
  if (areaMatch) {
    const area = areaMatch[1].trim();
    employees = employees.filter((employee) => employee.area.toLowerCase().includes(area));
    label = `activos de ${area}`;
  }
  if (!employees.length) return `No hay empleados ${label}.`;
  const detail = employees.slice(0, 10).map((employee) => `${employee.name} - ${employee.area} (${employee.phone})`).join("\n");
  return `${employees.length} empleado(s) ${label}:\n${detail}`;
}

async function jouleApplyNewEmployee(name, phone, area) {
  const payload = { name, phone, area, branchId: state.selectedBranchId, mode: "Presencial", role: "Empleado", start: "09:00", end: "18:00", vacationDays: 12, active: true };
  if (HAS_BACKEND) {
    const response = await apiFetch("/api/employees", { method: "POST", body: payload });
    if (!response.ok) return "No se pudo agregar el empleado.";
    await hydrateFromBackend();
    return `Listo, agregue a ${name} (${area}) con telefono ${phone}.`;
  }
  state.employees.push({ id: makeId(), ...payload });
  addAudit("Empleado agregado desde Joule", name);
  saveState();
  render();
  return `Listo, agregue a ${name} (${area}) con telefono ${phone}.`;
}

function jouleAddEmployeeFromText(raw) {
  const nameMatch =
    raw.match(/llamad[oa]\s+([a-zA-ZÀ-ÿ\s]+?)(?=\s+(?:con|tel[eé]fono|tel\b|[aá]rea|en\b)|$)/i) ||
    raw.match(/empleado\s+([a-zA-ZÀ-ÿ\s]+?)(?=\s+(?:con|tel[eé]fono|tel\b|[aá]rea|en\b)|$)/i);
  if (!nameMatch) return 'Dime el nombre asi: "agrega un empleado llamado Luis Perez con telefono +52 55 0000 0000".';
  const name = nameMatch[1].trim();
  const phoneMatch = raw.match(/(\+?\d[\d\s]{7,}\d)/);
  if (!phoneMatch) return `Necesito el telefono de ${name}. Ejemplo: "agrega un empleado llamado ${name} con telefono +52 55 0000 0000".`;
  const phone = phoneMatch[1].trim();
  const areaMatch = raw.match(/[aá]rea\s+([a-zA-ZÀ-ÿ\s]+?)(?=\s+(?:con|tel[eé]fono|tel\b)|$)/i);
  const area = areaMatch ? areaMatch[1].trim() : "General";
  return jouleApplyNewEmployee(name, phone, area);
}

function jouleDeactivateEmployeeFromText(raw) {
  const employee = findEmployeeForQuery(raw);
  if (!employee) return `Dime el nombre del empleado. Por ejemplo: "da de baja a ${activeEmployees()[0]?.name || "Carlos Mendez"}".`;
  return jouleRequestConfirmation(`¿Confirmas dar de baja a ${employee.name}? Ya no podra checar por WhatsApp.`, async () => {
    const result = await performDeactivateEmployee(employee);
    return result.ok ? `Listo, ${employee.name} fue dado de baja.` : result.message;
  });
}

function jouleListBranches() {
  if (!state.branches.length) return "No hay sucursales configuradas.";
  const detail = state.branches.map((branch) => `${branch.name}${branch.id === state.selectedBranchId ? " (actual)" : ""}`).join("\n");
  return `Sucursales:\n${detail}`;
}

function jouleSwitchBranchFromText(raw) {
  const branch = findBranchForQuery(raw);
  if (!branch) return `No encontre esa sucursal. Sucursales disponibles: ${state.branches.map((item) => item.name).join(", ")}.`;
  state.selectedBranchId = branch.id;
  saveState();
  render();
  return `Listo, cambie la vista a ${branch.name}.`;
}

async function jouleApplyBranch(name, lat, lng) {
  if (HAS_BACKEND) {
    const response = await apiFetch("/api/branches", { method: "POST", body: { name, lat, lng } });
    if (!response.ok) return response.status === 403 ? "No tienes permiso para agregar sucursales." : "No se pudo guardar la sucursal.";
    await hydrateFromBackend();
    return `Listo, agregue la sucursal ${name}.`;
  }
  state.branches.push({ id: makeId(), companyId: state.selectedCompanyId, name, lat, lng });
  addAudit("Sucursal agregada desde Joule", name);
  saveState();
  render();
  return `Listo, agregue la sucursal ${name}.`;
}

function jouleAddBranchFromText(raw) {
  const nameMatch = raw.match(/sucursal\s+(?:llamada\s+)?([a-zA-ZÀ-ÿ0-9\s]+?)(?=\s+(?:en|con|lat|latitud)\b|$)/i);
  const coordsMatch = raw.match(/(-?\d+\.\d+)[,\s]+(-?\d+\.\d+)/);
  if (!nameMatch) return 'Dime el nombre asi: "agrega la sucursal Sur en 19.3, -99.2".';
  const name = nameMatch[1].trim();
  if (!coordsMatch) return `Necesito las coordenadas de ${name}. Ejemplo: "agrega la sucursal ${name} en 19.3, -99.2".`;
  return jouleApplyBranch(name, Number(coordsMatch[1]), Number(coordsMatch[2]));
}

function jouleViewPolicy() {
  const policy = state.policy;
  return [
    `Tolerancia: ${policy.tolerance} min.`,
    `Radio de geocerca: ${policy.geofenceRadius} m.`,
    `Horas extra despues de: ${policy.overtimeAfterHours} h.`,
    `Salida olvidada despues de: ${policy.forgottenExitHours} h.`,
    `GPS obligatorio: ${policy.requireGps ? "si" : "no"}.`,
    `Evidencia obligatoria: ${policy.requireSelfie ? "si" : "no"}.`
  ].join("\n");
}

async function jouleApplyPolicy(nextPolicy, label) {
  if (HAS_BACKEND) {
    const response = await apiFetch("/api/policy", { method: "POST", body: nextPolicy });
    if (!response.ok) return response.status === 403 ? "No tienes permiso para cambiar las politicas." : "No se pudo guardar la politica.";
    await hydrateFromBackend();
    return `Listo, actualice la ${label}.`;
  }
  state.policy = nextPolicy;
  addAudit("Politicas actualizadas desde Joule", label);
  saveState();
  render();
  return `Listo, actualice la ${label}.`;
}

function jouleUpdatePolicyFromText(raw) {
  const lower = raw.toLowerCase();
  const numberMatch = raw.match(/(\d+(\.\d+)?)/);
  const number = numberMatch ? Number(numberMatch[1]) : null;
  const patch = {};
  let label = "";
  if (/toleran/.test(lower) && number !== null) {
    patch.tolerance = number;
    label = `tolerancia a ${number} minutos`;
  } else if (/(geocerca|radio)/.test(lower) && number !== null) {
    patch.geofenceRadius = number;
    label = `radio de geocerca a ${number} metros`;
  } else if (/hora[s]?\s*extra/.test(lower) && number !== null) {
    patch.overtimeAfterHours = number;
    label = `horas extra despues de ${number}h`;
  } else if (/salida olvidada/.test(lower) && number !== null) {
    patch.forgottenExitHours = number;
    label = `salida olvidada a las ${number}h`;
  } else if (/gps/.test(lower)) {
    patch.requireGps = !/(desactiva|quita|sin|no requiere|no obligatorio)/.test(lower);
    label = patch.requireGps ? "GPS obligatorio activado" : "GPS obligatorio desactivado";
  } else if (/(selfie|evidencia)/.test(lower)) {
    patch.requireSelfie = !/(desactiva|quita|sin|no requiere|no obligatoria)/.test(lower);
    label = patch.requireSelfie ? "evidencia obligatoria activada" : "evidencia obligatoria desactivada";
  } else {
    return 'Dime que cambiar, por ejemplo: "cambia la tolerancia a 15 minutos", "desactiva el GPS obligatorio" o "cambia el radio de geocerca a 300 metros".';
  }
  return jouleApplyPolicy({ ...state.policy, ...patch }, label);
}

function jouleRecordsToday() {
  const today = dayKey(new Date());
  const todays = state.records.filter((record) => dayKey(record.timestamp) === today && record.branchId === state.selectedBranchId);
  if (!todays.length) return "No hay registros hoy en esta sucursal.";
  const late = todays.filter((record) => record.status === "Retardo").length;
  return `${todays.length} registro(s) hoy en esta sucursal, ${late} retardo(s).`;
}

function jouleLateToday() {
  const today = dayKey(new Date());
  const late = state.records.filter((record) => dayKey(record.timestamp) === today && record.status === "Retardo");
  if (!late.length) return "Nadie ha llegado tarde hoy.";
  return `Llegaron tarde hoy: ${late.map((record) => record.employeeName).join(", ")}.`;
}

function jouleListAlerts() {
  const open = state.alerts.filter((alertItem) => alertItem.status === "Abierta");
  if (!open.length) return "No hay alertas operativas abiertas.";
  const detail = open.slice(0, 6).map((alertItem) => `${alertItem.employeeName} - ${alertItem.type} (${formatTime(alertItem.timestamp)})`).join("\n");
  return `${open.length} alerta(s) abierta(s):\n${detail}`;
}

async function jouleCloseAlertFromText(raw) {
  const employee = findEmployeeForQuery(raw);
  const open = state.alerts.filter((alertItem) => alertItem.status === "Abierta" && (!employee || alertItem.employeeName === employee.name));
  if (!open.length) return employee ? `${employee.name} no tiene alertas abiertas.` : "No encontre alertas abiertas para cerrar. Dime el nombre del empleado.";
  await closeAlert(open[0].id);
  return `Listo, cerre la alerta de ${open[0].employeeName} (${open[0].type}).`;
}

function jouleListAllTickets() {
  const tickets = state.securityTickets || [];
  if (!tickets.length) return "No hay tickets de seguridad registrados.";
  const detail = tickets.slice(0, 8).map((ticket) => `${ticket.number} - ${ticket.employeeName}: ${ticket.type} (${ticket.status})`).join("\n");
  return `${tickets.length} ticket(s) en total:\n${detail}`;
}

async function jouleTicketActionFromText(raw, status) {
  const ticket = findTicketForQuery(raw);
  if (!ticket) return "Dime el numero del ticket (ej. DG-0001) o el nombre del empleado.";
  await updateSecurityTicketStatus(ticket.id, status);
  return `Listo, el ticket ${ticket.number} quedo en estado "${status}".`;
}

function jouleListCampaigns() {
  const campaigns = state.phishingCampaigns || [];
  if (!campaigns.length) return "Todavia no hay campanas de phishing simuladas.";
  const detail = campaigns.slice(0, 6).map((campaign) => `${campaign.name} - ${campaign.department} (${campaign.channel})`).join("\n");
  return `${campaigns.length} campana(s):\n${detail}`;
}

function jouleDepartmentScore(raw) {
  const departments = [...new Set(activeEmployees().map((employee) => employee.area))];
  const lower = raw.toLowerCase();
  const department = departments.find((item) => lower.includes(item.toLowerCase()));
  if (!department) return `Dime el departamento. Opciones: ${departments.join(", ") || "sin departamentos activos"}.`;
  const campaigns = (state.phishingCampaigns || []).filter((campaign) => campaign.department === department || campaign.department === "Todos");
  if (!campaigns.length) return `${department} no tiene campanas de phishing todavia.`;
  const sent = campaigns.reduce((sum, campaign) => sum + campaign.sent, 0);
  const clicked = campaigns.reduce((sum, campaign) => sum + campaign.clicked, 0);
  const reported = campaigns.reduce((sum, campaign) => sum + campaign.reported, 0);
  const score = sent ? Math.round(100 - (clicked / sent) * 100 + (reported / sent) * 35) : 86;
  return `Score de ${department}: ${Math.max(0, Math.min(100, score))}.`;
}

function jouleLaunchCampaignFromText(raw) {
  const lower = raw.toLowerCase();
  const template = state.phishingTemplates.find((item) => lower.includes(item.name.toLowerCase()));
  if (!template) return `Dime que plantilla usar. Opciones: ${state.phishingTemplates.map((item) => item.name).join(", ")}.`;
  const departments = ["Todos", ...new Set(activeEmployees().map((employee) => employee.area))];
  const department = departments.find((item) => item !== "Todos" && lower.includes(item.toLowerCase())) || "Todos";
  const channel = ["Correo", "WhatsApp", "SMS"].find((item) => lower.includes(item.toLowerCase())) || template.channel || "Correo";
  return jouleRequestConfirmation(
    `¿Lanzo la campana "${template.name}" por ${channel} para ${department === "Todos" ? "todos los departamentos" : department}?`,
    async () => {
      const name = `${template.name} - Joule ${todayIso()}`;
      const result = await performLaunchCampaign(name, channel, template.name, department);
      return result.ok ? `Campana lanzada a ${result.sent} objetivo(s).` : result.message;
    }
  );
}

function jouleRecentAudit() {
  const items = state.audit.slice(0, 6);
  if (!items.length) return "Sin movimientos de auditoria todavia.";
  return items.map((item) => `${item.action}: ${item.detail} - ${item.user} (${formatTime(item.timestamp)})`).join("\n");
}

function jouleSetReportRange(raw) {
  const lower = raw.toLowerCase();
  const today = new Date();
  let from;
  let to = todayIso();
  if (/hoy/.test(lower)) {
    from = todayIso();
  } else if (/semana/.test(lower)) {
    const monday = new Date(today);
    monday.setDate(today.getDate() - ((today.getDay() + 6) % 7));
    from = monday.toISOString().slice(0, 10);
  } else if (/mes/.test(lower)) {
    from = new Date(today.getFullYear(), today.getMonth(), 1).toISOString().slice(0, 10);
  } else {
    return 'Dime el rango: "reporte de hoy", "reporte de esta semana" o "reporte de este mes".';
  }
  state.report = { from, to, area: state.report.area };
  byId("reportFrom").value = from;
  byId("reportTo").value = to;
  saveState();
  render();
  return `Listo, el reporte ahora cubre del ${from} al ${to}.`;
}

const JOULE_VIEW_ALIASES = {
  tablero: ["tablero", "dashboard", "inicio", "resumen general"],
  whatsapp: ["whatsapp", "simulador de whatsapp"],
  empleados: ["empleados", "personal"],
  seguridad: ["seguridad", "security assistant"],
  phishing: ["phishing"],
  incidencias: ["incidencias", "solicitudes"],
  reportes: ["reportes", "reporte"],
  configuracion: ["configuracion", "politicas", "sucursales"],
  integraciones: ["integraciones"],
  auditoria: ["auditoria", "bitacora"]
};

function jouleNavigateFromText(raw) {
  const lower = raw.toLowerCase();
  const entry = Object.entries(JOULE_VIEW_ALIASES).find(([, aliases]) => aliases.some((alias) => lower.includes(alias)));
  if (!entry) return "Dime a donde quieres ir: tablero, empleados, seguridad, phishing, incidencias, reportes, configuracion, integraciones o auditoria.";
  location.hash = `#${entry[0]}`;
  return `Listo, te lleve a ${entry[0]}.`;
}

const JOULE_SKILLS = [
  { id: "saludo", test: (t) => /^(hola|buenas|hey|hi)\b/.test(t), run: () => jouleBriefing() },
  {
    id: "quien-trabaja",
    test: (t) => /(quien|quién).*(trabaj|turno)|trabajando ahora/.test(t),
    run: () => {
      const working = activeEmployees().filter((employee) => currentWorkState(employee.id) === "En turno");
      return working.length ? `En turno ahora mismo: ${working.map((employee) => employee.name).join(", ")}.` : "Nadie tiene una entrada activa registrada en este momento.";
    }
  },
  { id: "resumen-riesgo", test: (t) => /riesgo|resumen|salud operativa|c[oó]mo (vamos|va todo)/.test(t), run: () => jouleBriefing() },
  { id: "cerrar-ticket", test: (t) => /cierra.*ticket|cerrar.*ticket/.test(t), run: (raw) => jouleTicketActionFromText(raw, "Cerrado") },
  { id: "revisar-ticket", test: (t) => /(revisa|pon en revision).*ticket/.test(t), run: (raw) => jouleTicketActionFromText(raw, "En revision") },
  { id: "listar-todos-tickets", test: (t) => /todos los tickets|lista de tickets/.test(t), run: () => jouleListAllTickets() },
  {
    id: "tickets-seguridad",
    test: (t) => /ticket.*(seguridad|prioridad|abiert)/.test(t),
    run: () => {
      const tickets = (state.securityTickets || []).filter((ticket) => ticket.status !== "Cerrado");
      if (!tickets.length) return "No hay tickets de seguridad abiertos.";
      const high = tickets.filter((ticket) => ticket.severity === "Alta");
      const detail = tickets.slice(0, 5).map((ticket) => `${ticket.number} - ${ticket.employeeName}: ${ticket.type} (${ticket.severity})`).join("\n");
      return `${tickets.length} ticket(s) abierto(s), ${high.length} de prioridad alta.\n${detail}`;
    }
  },
  {
    id: "incidencias-pendientes",
    test: (t) => /incidencia.*pendient|pendiente.*aprobar|solicitudes pendientes/.test(t),
    run: () => {
      const pending = state.issues.filter((issue) => issue.status === "Pendiente");
      if (!pending.length) return "No hay incidencias pendientes de aprobacion.";
      const detail = pending.slice(0, 6).map((issue) => `${issue.employeeName} - ${issue.type} (${formatDate(issue.timestamp)})`).join("\n");
      return `${pending.length} pendiente(s):\n${detail}`;
    }
  },
  { id: "aprobar-incidencia", test: (t) => /(aprueba|aprobar|autoriza)/.test(t), run: (raw) => jouleResolveIssue(raw, "Aprobada") },
  { id: "rechazar-incidencia", test: (t) => /(rechaza|rechazar|niega|deniega)/.test(t), run: (raw) => jouleResolveIssue(raw, "Rechazada") },
  {
    id: "saldo-vacaciones",
    test: (t) => /(dias|días).*vacacion|saldo.*vacacion|(cuantos dias|cuántos días).*(tiene|le quedan)\b/.test(t) && !/ticket|alerta|sucursal/.test(t),
    run: (raw) => {
      const employee = findEmployeeForQuery(raw);
      return employee
        ? `${employee.name} tiene ${employee.vacationDays} dia(s) de vacaciones disponibles.`
        : "Dime el nombre del empleado, por ejemplo: 'cuantos dias de vacaciones tiene Ana Lopez'.";
    }
  },
  {
    id: "estado-empleado",
    test: (t) => /(estado|informacion|información|horas trabajadas) de\b|en qu[eé] estado (esta|est[aá]|se encuentra)|c[oó]mo esta\b.*(trabaj|hoy)/.test(t),
    run: (raw) => {
      const employee = findEmployeeForQuery(raw);
      if (!employee) return "No encontre a ese empleado. Verifica el nombre.";
      const worked = calculateWorkedHours(employee.id).toFixed(1);
      return `${employee.name} (${employee.area}) - estado: ${currentWorkState(employee.id)}. Horas trabajadas hoy: ${worked}h. Vacaciones disponibles: ${employee.vacationDays}.`;
    }
  },
  { id: "baja-empleado", test: (t) => /da de baja a\b|desactiva a\b|elimina a\b/.test(t), run: (raw) => jouleDeactivateEmployeeFromText(raw) },
  { id: "agregar-empleado", test: (t) => /(agrega|nuevo).*empleado|empleado.*llamado/.test(t), run: (raw) => jouleAddEmployeeFromText(raw) },
  { id: "listar-empleados", test: (t) => /cuantos empleados|lista de empleados|empleados activos|empleados de\b/.test(t), run: (raw) => jouleListEmployees(raw) },
  { id: "agregar-sucursal", test: (t) => /(agrega|nueva).*sucursal/.test(t), run: (raw) => jouleAddBranchFromText(raw) },
  { id: "cambiar-sucursal", test: (t) => /(cambia|selecciona|ve a|muestrame).*(la )?sucursal/.test(t), run: (raw) => jouleSwitchBranchFromText(raw) },
  { id: "listar-sucursales", test: (t) => /que sucursales|lista de sucursales|sucursales hay/.test(t), run: () => jouleListBranches() },
  {
    id: "cambiar-politica",
    test: (t) => /(cambia|pon|ajusta).*(toleran|geocerca|radio|hora[s]?\s*extra|salida olvidada|gps|selfie|evidencia)|(activa|desactiva).*(gps|selfie|evidencia)/.test(t),
    run: (raw) => jouleUpdatePolicyFromText(raw)
  },
  { id: "ver-politica", test: (t) => /(cual|cuál) es la (politica|política|tolerancia)|politica actual|política actual/.test(t), run: () => jouleViewPolicy() },
  { id: "registros-hoy", test: (t) => /cuantos registros|registros de hoy|registros hay hoy/.test(t), run: () => jouleRecordsToday() },
  { id: "retardos-hoy", test: (t) => /quien lleg[oó] tarde|retardos de hoy|quien tiene retardo/.test(t), run: () => jouleLateToday() },
  { id: "cerrar-alerta", test: (t) => /cierra.*alerta|cerrar.*alerta/.test(t), run: (raw) => jouleCloseAlertFromText(raw) },
  { id: "listar-alertas", test: (t) => /que alertas hay|alertas abiertas|alertas activas/.test(t), run: () => jouleListAlerts() },
  { id: "lanzar-campana", test: (t) => /(lanza|crea|inicia).*campan/.test(t), run: (raw) => jouleLaunchCampaignFromText(raw) },
  { id: "score-departamento", test: (t) => /score de\b|resiliencia de\b/.test(t), run: (raw) => jouleDepartmentScore(raw) },
  { id: "listar-campanas", test: (t) => /que campan|lista de campan|campanas hay/.test(t), run: () => jouleListCampaigns() },
  {
    id: "phishing-score",
    test: (t) => /phishing|campañ|campan/.test(t),
    run: () => {
      const metrics = getDashboardMetrics();
      if (!metrics.campaigns.length) return "Todavia no hay campanas de phishing simuladas.";
      return `Score de phishing: ${metrics.phishingScore}%. Clics ${metrics.clickRate}%, reportes ${metrics.reportRate}%, capacitados ${metrics.trainingRate}%.`;
    }
  },
  { id: "crear-ticket", test: (t) => /(crea|abre|genera).*ticket/.test(t), run: (raw) => jouleCreateTicketFromText(raw) },
  { id: "auditoria-reciente", test: (t) => /que ha pasado|ultimos movimientos|últimos movimientos|auditoria reciente|bitacora reciente/.test(t), run: () => jouleRecentAudit() },
  { id: "cambiar-reporte", test: (t) => /reporte de (hoy|esta semana|este mes)/.test(t), run: (raw) => jouleSetReportRange(raw) },
  {
    id: "exportar-reporte",
    test: (t) => /(exporta|descarga).*(reporte|csv|asistencia)/.test(t),
    run: () => {
      downloadCsv();
      return "Listo, descargue el CSV de asistencia del periodo seleccionado.";
    }
  },
  { id: "navegar", test: (t) => /llevame a|llévame a|ve al?\b|abre (la |el )?(secci[oó]n|m[oó]dulo)|muestrame la (secci[oó]n|vista)/.test(t), run: (raw) => jouleNavigateFromText(raw) },
  {
    id: "ayuda",
    test: (t) => /ayuda|que puedes hacer|qué puedes hacer|comandos/.test(t),
    run: () =>
      [
        "Puedo ayudarte con toda la plataforma:",
        "- Operacion: quien esta en turno, resumen de riesgo, registros y retardos de hoy.",
        "- Incidencias: listar, aprobar/rechazar ('aprueba las vacaciones de Ana').",
        "- Empleados: listar, agregar ('agrega un empleado llamado Luis con telefono +52...'), dar de baja.",
        "- Sucursales: listar, cambiar de vista, agregar nuevas.",
        "- Politicas: ver o cambiar tolerancia, geocerca, GPS y evidencia obligatoria.",
        "- Seguridad: tickets abiertos, crear/cerrar/revisar tickets, alertas.",
        "- Phishing: score, lanzar campanas, score por departamento.",
        "- Auditoria y reportes: ultimos movimientos, cambiar rango del reporte, exportar CSV.",
        "- Navegacion: 'llevame a incidencias', 've a seguridad', etc."
      ].join("\n")
  }
];

function resolveJouleSkill(text) {
  const normalized = text.toLowerCase().trim();
  const skill = JOULE_SKILLS.find((item) => item.test(normalized));
  return skill ? skill.run(text) : null;
}

async function jouleAnswer(text) {
  if (jouleConfirmAction) {
    const pending = jouleConfirmAction;
    jouleConfirmAction = null;
    if (JOULE_CONFIRM_WORDS.test(text.toLowerCase().trim())) return await pending.run();
    return "Cancelado. No hice ningun cambio.";
  }
  const local = await resolveJouleSkill(text);
  if (local) return local;
  if (HAS_BACKEND && integrationHealth?.jouleConfigured) {
    try {
      const response = await apiFetch("/api/joule/query", {
        method: "POST",
        body: { message: text, viewContext: currentJouleView() }
      });
      if (response.ok) {
        const payload = await response.json();
        if (payload.available && payload.reply) return payload.reply;
      }
    } catch (error) {
      console.warn("Joule IA no disponible", error);
    }
  }
  return `No estoy segura de haber entendido. Prueba con:\n${jouleQuickPrompts().map((prompt) => `- ${prompt}`).join("\n")}`;
}

function jouleSaveHistory() {
  jouleHistory = jouleHistory.slice(-40);
  sessionStorage.setItem(JOULE_HISTORY_KEY, JSON.stringify(jouleHistory));
}

function jouleRenderMessages() {
  const box = byId("jouleMessages");
  box.innerHTML = jouleHistory.length
    ? jouleHistory.map((msg) => `<div class="bubble joule-bubble ${msg.role === "user" ? "system" : ""}">${escapeHtml(msg.text).replaceAll("\n", "<br>")}</div>`).join("")
    : emptyState("Preguntame sobre asistencia, seguridad o phishing.");
  box.scrollTop = box.scrollHeight;
}

function jouleRenderQuickPrompts() {
  byId("jouleQuickPrompts").innerHTML = jouleQuickPrompts()
    .map((prompt) => `<button type="button" class="joule-chip" data-prompt="${escapeAttr(prompt)}">${escapeHtml(prompt)}</button>`)
    .join("");
}

function jouleOpenPanel() {
  jouleOpen = true;
  byId("joulePanel").classList.remove("hidden");
  jouleRenderQuickPrompts();
  if (!jouleHistory.length) {
    jouleHistory.push({ role: "assistant", text: jouleBriefing() });
    jouleSaveHistory();
  }
  jouleRenderMessages();
  jouleUpdateBadge();
  byId("jouleInput").focus();
}

function jouleClosePanel() {
  jouleOpen = false;
  byId("joulePanel")?.classList.add("hidden");
  jouleUpdateBadge();
}

async function jouleSubmit(rawText) {
  const clean = rawText.trim();
  if (!clean || jouleBusy) return;
  jouleBusy = true;
  jouleHistory.push({ role: "user", text: clean });
  jouleRenderMessages();
  byId("jouleInput").value = "";
  byId("jouleMessages").insertAdjacentHTML("beforeend", `<div class="bubble joule-bubble joule-thinking">Pensando...</div>`);
  byId("jouleMessages").scrollTop = byId("jouleMessages").scrollHeight;
  try {
    jouleHistory.push({ role: "assistant", text: await jouleAnswer(clean) });
  } catch (error) {
    jouleHistory.push({ role: "assistant", text: "Tuve un problema para responder. Intenta de nuevo." });
  }
  jouleSaveHistory();
  jouleRenderMessages();
  jouleBusy = false;
}

function setLoginError(message) {
  const errorBox = byId("loginError");
  if (!message) {
    errorBox.hidden = true;
    errorBox.textContent = "";
    return;
  }
  errorBox.hidden = false;
  errorBox.textContent = message;
}

byId("loginForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (HAS_BACKEND) {
    setLoginError(null);
    let response;
    try {
      response = await apiFetch("/api/login", {
        method: "POST",
        body: { email: byId("loginUser").value, password: byId("loginPassword").value }
      });
    } catch (error) {
      setLoginError("No se pudo contactar al servidor. Revisa tu conexion e intenta de nuevo.");
      return;
    }
    if (!response.ok) {
      setLoginError("Usuario o contrasena incorrectos.");
      return;
    }
    const payload = await response.json();
    session = { user: payload.user.email, role: payload.user.role, timestamp: now().toISOString() };
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
    await hydrateFromBackend();
    render();
    return;
  }
  setLoginError(null);
  session = { user: byId("loginUser").value, role: byId("loginRole").value, timestamp: now().toISOString() };
  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  addAudit("Inicio de sesion", session.user);
  saveState();
  render();
});

byId("logoutButton").addEventListener("click", async () => {
  if (HAS_BACKEND) {
    await apiFetch("/api/logout", { method: "POST" }).catch(() => {});
  }
  addAudit("Cierre de sesion", session?.user || "");
  session = null;
  localStorage.removeItem(SESSION_KEY);
  saveState();
  render();
});

byId("messageForm").addEventListener("submit", (event) => {
  event.preventDefault();
  const employeeId = byId("employeeSelect").value;
  const message = byId("messageText").value.trim();
  if (!employeeById(employeeId)) {
    alert("Agrega o selecciona un empleado activo antes de procesar mensajes.");
    return;
  }
  if (!message) {
    alert("Escribe un mensaje de WhatsApp para procesarlo.");
    return;
  }
  processMessage(
    employeeId,
    message,
    byId("locationText").value,
    readCoordinate("latInput"),
    readCoordinate("lngInput"),
    byId("selfieCheck").checked,
    byId("incomingPhone").value
  );
  byId("messageText").value = "";
});

document.querySelectorAll(".quick-actions button").forEach((button) => {
  button.addEventListener("click", () => {
    byId("messageText").value = button.dataset.message;
    byId("messageForm").requestSubmit();
  });
});

byId("employeeForm").addEventListener("submit", saveEmployee);
byId("securityReportForm").addEventListener("submit", createSecurityTicket);
byId("phishingCampaignForm").addEventListener("submit", launchPhishingCampaign);
byId("cancelEditEmployee").addEventListener("click", () => {
  byId("employeeForm").reset();
  resetEmployeeForm();
});

byId("policyForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const policy = {
    tolerance: readNumber("policyTolerance", defaultPolicy.tolerance, 0),
    forgottenExitHours: readNumber("policyForgottenExit", defaultPolicy.forgottenExitHours, 1),
    geofenceRadius: readNumber("policyRadius", defaultPolicy.geofenceRadius, 50),
    overtimeAfterHours: readNumber("policyOvertimeAfter", defaultPolicy.overtimeAfterHours, 1),
    requireGps: byId("policyRequireGps").checked,
    requireSelfie: byId("policyRequireSelfie").checked
  };

  if (HAS_BACKEND) {
    const response = await apiFetch("/api/policy", { method: "POST", body: policy });
    if (!response.ok) {
      alert(response.status === 403 ? "No tienes permiso para cambiar las politicas." : "No se pudo guardar la politica.");
      return;
    }
    await hydrateFromBackend();
    return;
  }

  state.policy = policy;
  addAudit("Politicas actualizadas", "Reglas de asistencia modificadas");
  saveState();
  render();
});

byId("branchForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const name = byId("branchName").value.trim();
  const lat = Number(byId("branchLat").value);
  const lng = Number(byId("branchLng").value);
  if (!name) {
    alert("Captura el nombre de la sucursal.");
    return;
  }
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    alert("Captura coordenadas validas para la sucursal.");
    return;
  }

  if (HAS_BACKEND) {
    const response = await apiFetch("/api/branches", { method: "POST", body: { name, lat, lng } });
    if (!response.ok) {
      alert(response.status === 403 ? "No tienes permiso para agregar sucursales." : "No se pudo guardar la sucursal.");
      return;
    }
    event.target.reset();
    await hydrateFromBackend();
    return;
  }

  state.branches.push({ id: makeId(), companyId: state.selectedCompanyId, name, lat, lng });
  addAudit("Sucursal agregada", name);
  event.target.reset();
  saveState();
  render();
});

byId("reportFilters").addEventListener("submit", (event) => {
  event.preventDefault();
  const from = byId("reportFrom").value || todayIso();
  const to = byId("reportTo").value || from;
  state.report = { from, to, area: byId("reportArea").value || "Todas" };
  saveState();
  render();
});

byId("companySelect").addEventListener("change", () => {
  state.selectedCompanyId = byId("companySelect").value;
  state.selectedBranchId = state.branches.find((branch) => branch.companyId === state.selectedCompanyId)?.id || state.branches[0]?.id || "";
  saveState();
  render();
});

byId("branchSelect").addEventListener("change", () => {
  state.selectedBranchId = byId("branchSelect").value;
  saveState();
  render();
});

document.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const id = button.dataset.id;
  const actions = {
    "edit-employee": () => editEmployee(id),
    "deactivate-employee": () => deactivateEmployee(id),
    "approve-issue": () => updateIssue(id, "Aprobada"),
    "reject-issue": () => updateIssue(id, "Rechazada"),
    "close-alert": () => closeAlert(id),
    "review-security": () => updateSecurityTicketStatus(id, "En revision"),
    "close-security": () => updateSecurityTicketStatus(id, "Cerrado")
  };
  actions[button.dataset.action]?.();
});

byId("exportCsv").addEventListener("click", downloadCsv);
byId("reportFrom").value = state.report.from;
byId("reportTo").value = state.report.to;

byId("jouleLauncher").addEventListener("click", () => (jouleOpen ? jouleClosePanel() : jouleOpenPanel()));
byId("jouleClose").addEventListener("click", jouleClosePanel);
byId("jouleForm").addEventListener("submit", (event) => {
  event.preventDefault();
  jouleSubmit(byId("jouleInput").value);
});
byId("jouleQuickPrompts").addEventListener("click", (event) => {
  const chip = event.target.closest(".joule-chip");
  if (chip) jouleSubmit(chip.dataset.prompt);
});
window.addEventListener("hashchange", () => {
  if (jouleOpen) jouleRenderQuickPrompts();
});

render();
hydrateFromBackend();
