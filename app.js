const STORAGE_KEY = "checador-wa-state-v3";
const SESSION_KEY = "checador-wa-session";
const oldKeys = ["checador-wa-state-v1", "checador-wa-state-v2"];
const BACKEND_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const API_BASE = BACKEND_HOSTS.has(location.hostname) && (location.protocol === "http:" || location.protocol === "https:") ? "" : null;
const DEMO_MODE = !API_BASE;
const now = () => new Date();
const makeId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
let syncingState = false;

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
  report: { from: todayIso(), to: todayIso(), area: "Todas" }
};

let state = API_BASE ? seed : migrateState(loadState());
let session = JSON.parse(localStorage.getItem(SESSION_KEY) || "null");
document.body.dataset.mode = DEMO_MODE ? "demo" : "server";
if (DEMO_MODE) seedPresentationData();

function employeeSeed(name, phone, area, branchId, mode, role, start, end, vacationDays) {
  return { id: makeId(), name, phone, area, branchId, mode, role, start, end, vacationDays, active: true };
}

function loadState() {
  const saved = localStorage.getItem(STORAGE_KEY) || oldKeys.map((key) => localStorage.getItem(key)).find(Boolean);
  return saved ? JSON.parse(saved) : seed;
}

function migrateState(raw) {
  const merged = { ...seed, ...raw };
  merged.companies = raw.companies || seed.companies;
  merged.branches = raw.branches || seed.branches;
  merged.policy = { ...defaultPolicy, ...(raw.policy || {}) };
  merged.selectedCompanyId = raw.selectedCompanyId || "co-demo";
  merged.selectedBranchId = raw.selectedBranchId || merged.branches[0].id;
  merged.report = { from: todayIso(), to: todayIso(), area: "Todas", ...(raw.report || {}) };
  merged.alerts = raw.alerts || [];
  merged.audit = raw.audit || [];
  merged.issues = raw.issues || [];
  merged.chat = raw.chat || [];
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

function saveState(next = state) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  if (API_BASE && !syncingState) {
    fetch(`${API_BASE}/api/state`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(next)
    }).catch((error) => console.warn("No se pudo guardar en backend", error));
  }
}

function demoTimestamp(hoursAgo) {
  const date = new Date();
  date.setHours(date.getHours() - hoursAgo);
  return date.toISOString();
}

function seedPresentationData() {
  if (state.records.length || !state.employees.length) return;
  const first = state.employees[0];
  const second = state.employees[1] || first;
  const third = state.employees[2] || first;
  const branch = state.branches[0];
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
  saveState();
}

async function hydrateFromBackend() {
  if (!API_BASE) return;
  try {
    syncingState = true;
    const sessionResponse = await fetch(`${API_BASE}/api/me`);
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
    const response = await fetch(`${API_BASE}/api/state`);
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
  return document.getElementById(id);
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function formatDate(dateValue) {
  return new Intl.DateTimeFormat("es-MX", { day: "2-digit", month: "2-digit", year: "numeric" }).format(new Date(dateValue));
}

function formatTime(dateValue) {
  return new Intl.DateTimeFormat("es-MX", { hour: "2-digit", minute: "2-digit" }).format(new Date(dateValue));
}

function minutesFromTime(value) {
  const [hours, minutes] = value.split(":").map(Number);
  return hours * 60 + minutes;
}

function minutesFromDate(dateValue) {
  const date = new Date(dateValue);
  return date.getHours() * 60 + date.getMinutes();
}

function readCoordinate(id) {
  const value = byId(id).value.trim();
  return value === "" ? NaN : Number(value);
}

function normalizePhone(value) {
  return String(value || "").replace(/\D/g, "");
}

function branchById(id) {
  return state.branches.find((branch) => branch.id === id) || state.branches[0];
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
  const day = date.toDateString();
  return state.records.filter((record) => record.employeeId === employeeId && new Date(record.timestamp).toDateString() === day);
}

function recordsForReport() {
  const from = new Date(`${state.report.from}T00:00:00`);
  const to = new Date(`${state.report.to}T23:59:59`);
  return state.records.filter((record) => {
    const employee = employeeById(record.employeeId);
    const stamp = new Date(record.timestamp);
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
  const last = recordsForDay(employeeId).sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))[0];
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
    if (record.event === "entrada" || record.event === "regreso") openEntry = new Date(record.timestamp);
    if ((record.event === "salida" || record.event === "descanso") && openEntry) {
      totalMs += new Date(record.timestamp) - openEntry;
      openEntry = null;
    }
  });
  if (openEntry && new Date().toDateString() === date.toDateString()) totalMs += now() - openEntry;
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
  const distance = hasGps ? distanceMeters(lat, lng, branch.lat, branch.lng) : null;
  const duplicate = recordsForDay(employee.id).some((record) => record.event === event && Math.abs(new Date(timestamp) - new Date(record.timestamp)) < 2 * 60 * 1000);
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
    const last = records.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))[0];
    if (workState === "En turno" && last) {
      const hoursOpen = (now() - new Date(last.timestamp)) / 1000 / 60 / 60;
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
    employee.vacationDays = Math.max(0, employee.vacationDays - 1);
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

function saveEmployee(event) {
  event.preventDefault();
  const id = byId("employeeId").value;
  const payload = {
    name: byId("employeeName").value,
    phone: byId("employeePhone").value,
    area: byId("employeeArea").value,
    branchId: byId("employeeBranch").value,
    mode: byId("employeeMode").value,
    role: byId("employeeRole").value,
    start: byId("employeeStart").value,
    end: byId("employeeEnd").value,
    vacationDays: Number(byId("employeeVacation").value || 0),
    active: true
  };

  if (id) {
    Object.assign(employeeById(id), payload);
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

function renderSelectors() {
  byId("companySelect").innerHTML = state.companies.map((company) => `<option value="${company.id}">${company.name}</option>`).join("");
  byId("companySelect").value = state.selectedCompanyId;
  const branchOptions = state.branches.filter((branch) => branch.companyId === state.selectedCompanyId).map((branch) => `<option value="${branch.id}">${branch.name}</option>`).join("");
  byId("branchSelect").innerHTML = branchOptions;
  byId("branchSelect").value = state.selectedBranchId;
  byId("employeeBranch").innerHTML = branchOptions;
  byId("employeeBranch").value = state.selectedBranchId;
  byId("employeeSelect").innerHTML = activeEmployees().map((employee) => `<option value="${employee.id}">${employee.name} - ${employee.phone}</option>`).join("");
  const areas = ["Todas", ...new Set(state.employees.filter((employee) => employee.active).map((employee) => employee.area))];
  byId("reportArea").innerHTML = areas.map((area) => `<option>${area}</option>`).join("");
  byId("reportArea").value = state.report.area;
}

function renderEmployees() {
  byId("employeeList").innerHTML = state.employees
    .filter((employee) => employee.branchId === state.selectedBranchId)
    .map((employee) => {
      const hours = calculateWorkedHours(employee.id).toFixed(1);
      const active = employee.active ? "Activo" : "Baja";
      return `
        <div class="row-card">
          <div>
            <strong>${employee.name}</strong>
            <span>${employee.phone} - ${employee.area} - ${employee.role} - ${employee.mode} - ${employee.start}-${employee.end}</span>
          </div>
          <div class="row-actions">
            <span class="pill ${statusClass(active)}">${active}</span>
            <span class="pill ok">${hours} h hoy</span>
            <button data-action="edit-employee" data-id="${employee.id}">Editar</button>
            <button data-action="deactivate-employee" data-id="${employee.id}">Baja</button>
          </div>
        </div>
      `;
    })
    .join("");
}

function renderRecords() {
  byId("recordsTable").innerHTML = state.records
    .filter((record) => record.branchId === state.selectedBranchId)
    .slice(0, 60)
    .map((record) => `
      <tr>
        <td>${formatDate(record.timestamp)}</td>
        <td>${record.employeeName}</td>
        <td>${record.event}${record.evidence ? " + evidencia" : ""}</td>
        <td>${formatTime(record.timestamp)}</td>
        <td>${branchById(record.branchId).name}</td>
        <td>${record.location}${record.distance ? ` (${Math.round(record.distance)} m)` : ""}</td>
        <td><span class="pill ${statusClass(record.status)}">${record.status}</span></td>
      </tr>
    `)
    .join("");
}

function renderIssues() {
  byId("issuesList").innerHTML = state.issues.length
    ? state.issues.map((issue) => `
      <div class="row-card">
        <div>
          <strong>${issue.employeeName} - ${issue.type}</strong>
          <span>${issue.detail} - ${formatDate(issue.timestamp)} ${formatTime(issue.timestamp)}</span>
        </div>
        <div class="row-actions">
          <span class="pill ${statusClass(issue.status)}">${issue.status}</span>
          <button data-action="approve-issue" data-id="${issue.id}">Aprobar</button>
          <button data-action="reject-issue" data-id="${issue.id}">Rechazar</button>
        </div>
      </div>
    `).join("")
    : `<p>Sin incidencias por revisar.</p>`;
}

function renderBalances() {
  byId("balancesList").innerHTML = activeEmployees().map((employee) => `
    <div class="row-card">
      <div><strong>${employee.name}</strong><span>${employee.area} - ${employee.phone}</span></div>
      <span class="pill ok">${employee.vacationDays} dias disponibles</span>
    </div>
  `).join("");
}

function renderChat() {
  byId("chatLog").innerHTML = state.chat.slice(0, 10).flatMap((item) => [
    `<div class="bubble"><strong>${item.employeeName}</strong><br>${item.message}<small>${formatTime(item.timestamp)}</small></div>`,
    `<div class="bubble system">${item.response}<small>Bot RRHH</small></div>`
  ]).join("");
}

function renderWorkingNow() {
  byId("workingNowList").innerHTML = activeEmployees().map((employee) => {
    const workState = currentWorkState(employee.id);
    return `<div class="row-card"><div><strong>${employee.name}</strong><span>${employee.area} - ${employee.start}-${employee.end}</span></div><span class="pill ${statusClass(workState)}">${workState}</span></div>`;
  }).join("");
}

function renderAlerts() {
  refreshAlerts();
  const open = state.alerts.filter((alert) => alert.status === "Abierta").slice(0, 12);
  byId("alertsList").innerHTML = open.length
    ? open.map((alert) => `
      <div class="row-card">
        <div><strong>${alert.employeeName} - ${alert.type}</strong><span>${alert.detail} - ${formatTime(alert.timestamp)}</span></div>
        <div class="row-actions"><span class="pill ${alert.severity === "danger" ? "danger" : "warn"}">${alert.status}</span><button data-action="close-alert" data-id="${alert.id}">Cerrar</button></div>
      </div>
    `).join("")
    : `<p>Sin alertas activas.</p>`;
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
  byId("summaryList").innerHTML = rows.map((row) => `
    <div class="row-card">
      <div><strong>${row.employee.name}</strong><span>${row.records} registros - ${row.late} retardos - ${row.worked.toFixed(1)} h trabajadas - ${row.overtime.toFixed(1)} h extra</span></div>
      <span class="pill ${row.late ? "warn" : "ok"}">${row.employee.area}</span>
    </div>
  `).join("");
  byId("metricWorking").textContent = rows.filter((row) => currentWorkState(row.employee.id) === "En turno").length;
  byId("metricLate").textContent = state.records.filter((record) => record.status === "Retardo" && new Date(record.timestamp).toDateString() === new Date().toDateString()).length;
  byId("metricOvertime").textContent = rows.reduce((total, row) => total + row.overtime, 0).toFixed(1);
  byId("metricOpenIssues").textContent = state.issues.filter((issue) => issue.status === "Pendiente").length;
  byId("metricAlerts").textContent = state.alerts.filter((alert) => alert.status === "Abierta").length;
}

function renderCalendar() {
  const date = new Date(`${state.report.from}T12:00:00`);
  const days = Array.from({ length: 30 }, (_, index) => {
    const day = new Date(date);
    day.setDate(date.getDate() + index);
    const dayRecords = state.records.filter((record) => new Date(record.timestamp).toDateString() === day.toDateString() && record.branchId === state.selectedBranchId);
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
  byId("branchList").innerHTML = state.branches.filter((branch) => branch.companyId === state.selectedCompanyId).map((branch) => `
    <div class="row-card"><div><strong>${branch.name}</strong><span>${branch.lat}, ${branch.lng} - radio ${state.policy.geofenceRadius} m</span></div><span class="pill ${branch.id === state.selectedBranchId ? "ok" : "warn"}">${branch.id === state.selectedBranchId ? "Actual" : "Disponible"}</span></div>
  `).join("");
}

function renderIntegrations() {
  byId("integrationStatus").innerHTML = `
    <div class="row-card"><div><strong>Webhook HTTPS</strong><span>Necesario para conectar mensajes reales de WhatsApp.</span></div><span class="pill warn">Simulado</span></div>
    <div class="row-card"><div><strong>Validacion de telefono</strong><span>El empleado solo puede checar desde su numero registrado.</span></div><span class="pill ok">Incluido</span></div>
    <div class="row-card"><div><strong>Plantillas de respuesta</strong><span>Confirmacion de entrada, salida, saldo e incidencias.</span></div><span class="pill ok">Incluido</span></div>
  `;
}

function renderAudit() {
  byId("auditList").innerHTML = state.audit.slice(0, 30).map((item) => `
    <div class="row-card"><div><strong>${item.action}</strong><span>${item.detail} - ${item.user} (${item.role})</span></div><span>${formatDate(item.timestamp)} ${formatTime(item.timestamp)}</span></div>
  `).join("") || `<p>Sin movimientos de auditoria.</p>`;
}

function renderSession() {
  byId("loginScreen").classList.toggle("hidden", Boolean(session));
  const mode = DEMO_MODE ? "Demo GitHub Pages" : "Backend conectado";
  byId("sessionLabel").textContent = session ? `${state.companies[0].name} - ${session.user} - ${session.role} - ${mode}` : `${state.companies[0].name} - ${mode}`;
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
  renderSummary();
  renderCalendar();
  renderPolicy();
  renderBranches();
  renderIntegrations();
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
  link.download = `nomina-checador-wa-${state.report.from}-${state.report.to}.csv`;
  link.click();
  URL.revokeObjectURL(link.href);
}

byId("loginForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (API_BASE) {
    const response = await fetch(`${API_BASE}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: byId("loginUser").value, password: byId("loginPassword").value })
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
  if (API_BASE) {
    await fetch(`${API_BASE}/api/logout`, { method: "POST" }).catch(() => {});
  }
  addAudit("Cierre de sesion", session?.user || "");
  session = null;
  localStorage.removeItem(SESSION_KEY);
  saveState();
  render();
});

byId("messageForm").addEventListener("submit", (event) => {
  event.preventDefault();
  processMessage(
    byId("employeeSelect").value,
    byId("messageText").value,
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
byId("cancelEditEmployee").addEventListener("click", () => {
  byId("employeeForm").reset();
  resetEmployeeForm();
});

byId("policyForm").addEventListener("submit", (event) => {
  event.preventDefault();
  state.policy = {
    tolerance: Number(byId("policyTolerance").value),
    forgottenExitHours: Number(byId("policyForgottenExit").value),
    geofenceRadius: Number(byId("policyRadius").value),
    overtimeAfterHours: Number(byId("policyOvertimeAfter").value),
    requireGps: byId("policyRequireGps").checked,
    requireSelfie: byId("policyRequireSelfie").checked
  };
  addAudit("Politicas actualizadas", "Reglas de asistencia modificadas");
  saveState();
  render();
});

byId("branchForm").addEventListener("submit", (event) => {
  event.preventDefault();
  state.branches.push({ id: makeId(), companyId: state.selectedCompanyId, name: byId("branchName").value, lat: Number(byId("branchLat").value), lng: Number(byId("branchLng").value) });
  addAudit("Sucursal agregada", byId("branchName").value);
  event.target.reset();
  saveState();
  render();
});

byId("reportFilters").addEventListener("submit", (event) => {
  event.preventDefault();
  state.report = { from: byId("reportFrom").value, to: byId("reportTo").value, area: byId("reportArea").value };
  saveState();
  render();
});

byId("companySelect").addEventListener("change", () => {
  state.selectedCompanyId = byId("companySelect").value;
  state.selectedBranchId = state.branches.find((branch) => branch.companyId === state.selectedCompanyId).id;
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
    "close-alert": () => closeAlert(id)
  };
  actions[button.dataset.action]?.();
});

byId("exportCsv").addEventListener("click", downloadCsv);
byId("reportFrom").value = state.report.from;
byId("reportTo").value = state.report.to;

render();
hydrateFromBackend();
