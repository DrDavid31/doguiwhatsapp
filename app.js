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
  if (HAS_BACKEND && !syncingState) {
    pendingBackendPayload = JSON.stringify(next);
    window.clearTimeout(backendSaveTimer);
    backendSaveTimer = window.setTimeout(() => {
      apiFetch("/api/state", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: pendingBackendPayload
      }).catch((error) => console.warn("No se pudo guardar en backend", error));
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

async function launchPhishingCampaign(event) {
  event.preventDefault();
  const department = byId("campaignDepartment").value;
  const template = byId("campaignTemplate").value;
  const campaignName = byId("campaignName").value.trim() || `Campana DOGUI ${todayIso()}`;
  const selectedTargets = activeEmployees().filter((employee) => department === "Todos" || employee.area === department);
  if (!selectedTargets.length) {
    alert("No hay empleados activos para esta campana.");
    return;
  }
  if (HAS_BACKEND) {
    const response = await apiFetch("/api/phishing/campaigns", {
      method: "POST",
      body: {
        name: campaignName,
        channel: byId("campaignChannel").value,
        template,
        department,
        launchNow: true
      }
    });
    if (!response.ok) {
      alert("No se pudo lanzar la campana en el backend.");
      return;
    }
    await hydrateFromBackend();
    return;
  }
  const sent = Math.max(8, selectedTargets.length * 12);
  const riskBoost = template.toLowerCase().includes("sat") || template.toLowerCase().includes("banco") ? 0.34 : 0.24;
  const clicked = Math.max(1, Math.round(sent * riskBoost));
  const reported = Math.max(1, Math.round(sent * 0.42));
  const trained = Math.max(reported, Math.round(sent * 0.78));
  state.phishingCampaigns.unshift(
    phishingCampaignSeed(campaignName, byId("campaignChannel").value, template, department, sent, clicked, reported, trained)
  );
  addAudit("Campana phishing simulada", `${campaignName} - ${department}`);
  saveState();
  render();
}

async function hydrateFromBackend() {
  if (!HAS_BACKEND) return;
  try {
    syncingState = true;
    const healthResponse = await apiFetch("/api/health");
    if (healthResponse.ok) integrationHealth = await healthResponse.json();
    const sessionResponse = await apiFetch("/api/me");
    if (sessionResponse.ok) {
      const sessionPayload = await sessionResponse.json();
      if (sessionPayload.user) {
        session = { user: sessionPayload.user.email, role: sessionPayload.user.role, timestamp: now().toISOString() };
        localStorage.setItem(SESSION_KEY, JSON.stringify(session));
      } else if (session) {
        session = null;
        localStorage.removeItem(SESSION_KEY);
      }
    }
    const response = await apiFetch("/api/state");
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    state = migrateState(await response.json());
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    render();
  } catch (error) {
    console.warn("No se pudo cargar /api/state; usando localStorage", error);
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

function updateIssue(id, status) {
  const issue = state.issues.find((item) => item.id === id);
  if (!issue) return;
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

function closeAlert(id) {
  const alert = state.alerts.find((item) => item.id === id);
  if (!alert) return;
  alert.status = "Cerrada";
  addAudit("Alerta cerrada", `${alert.employeeName}: ${alert.type}`);
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

function saveEmployee(event) {
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

  if (id) {
    const existing = employeeById(id);
    if (existing) Object.assign(existing, payload);
    else state.employees.push({ id, ...payload });
    addAudit("Empleado editado", payload.name);
  } else {
    state.employees.push({ id: makeId(), ...payload });
    addAudit("Empleado agregado", payload.name);
  }
  event.target.reset();
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

function deactivateEmployee(id) {
  const employee = employeeById(id);
  if (!employee) return;
  employee.active = false;
  addAudit("Empleado dado de baja", employee.name);
  saveState();
  render();
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

function renderSession() {
  byId("loginScreen").classList.toggle("hidden", Boolean(session));
  const mode = DEMO_MODE ? "Demo GitHub Pages" : "Backend conectado";
  const company = state.companies.find((item) => item.id === state.selectedCompanyId) || state.companies[0] || { name: "DOGUI" };
  byId("sessionLabel").textContent = session ? `${company.name} - ${session.user} - ${session.role} - ${mode}` : `${company.name} - ${mode}`;
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

byId("loginForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (HAS_BACKEND) {
    const response = await apiFetch("/api/login", {
      method: "POST",
      body: { email: byId("loginUser").value, password: byId("loginPassword").value }
    });
    if (!response.ok) {
      alert("Usuario o contrasena incorrectos.");
      return;
    }
    const payload = await response.json();
    session = { user: payload.user.email, role: payload.user.role, timestamp: now().toISOString() };
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
    await hydrateFromBackend();
    render();
    return;
  }
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

byId("policyForm").addEventListener("submit", (event) => {
  event.preventDefault();
  state.policy = {
    tolerance: readNumber("policyTolerance", defaultPolicy.tolerance, 0),
    forgottenExitHours: readNumber("policyForgottenExit", defaultPolicy.forgottenExitHours, 1),
    geofenceRadius: readNumber("policyRadius", defaultPolicy.geofenceRadius, 50),
    overtimeAfterHours: readNumber("policyOvertimeAfter", defaultPolicy.overtimeAfterHours, 1),
    requireGps: byId("policyRequireGps").checked,
    requireSelfie: byId("policyRequireSelfie").checked
  };
  addAudit("Politicas actualizadas", "Reglas de asistencia modificadas");
  saveState();
  render();
});

byId("branchForm").addEventListener("submit", (event) => {
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

render();
hydrateFromBackend();
