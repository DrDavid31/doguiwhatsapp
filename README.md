# DOGUI WhatsApp

Prototipo avanzado de control de asistencia empresarial por WhatsApp. Funciona como app estatica: abre `index.html` en el navegador y los datos se guardan en `localStorage`.

Tambien esta listo para GitHub Pages como demo de presentacion. En Pages se muestra un modo demo con datos precargados; el backend real se usa cuando corres `run-server.ps1`.

## Modulos incluidos

- DOGUI Joule: copiloto de IA inspirado en SAP Joule, con skills de consulta y accion sobre asistencia, seguridad y phishing, mas una capa opcional de lenguaje libre con Claude.
- Vista ejecutiva para presentacion comercial en GitHub Pages.
- Login visual con resumen de valor y simulacion de conversacion WhatsApp.
- Panel de salud operativa con barras de cobertura, evidencia y riesgo.
- Mapa visual de checadas por sucursal y estado.
- DOGUI WhatsApp Security Assistant para reportar links sospechosos, correos falsos, archivos raros e intentos de fraude.
- Creacion automatica de tickets, alertas internas y respuestas tipo "No abras el archivo".
- DOGUI Phishing Simulator con campanas por correo, WhatsApp y SMS.
- Plantillas de fraude: factura, banco, proveedor, RH, paqueteria y SAT.
- Metricas de clics, reportes, capacitacion, score por departamento y reporte mensual.
- Login simulado con roles: Dueno, RRHH, Supervisor y Empleado.
- Multiempresa preparado y selector de sucursal.
- Empleados con alta, edicion, baja logica, telefono, area, rol, modalidad, turno y saldo de vacaciones.
- Simulador de WhatsApp con comandos: `entrar`, `salir`, `descanso`, `regreso`, `permiso`, `vacaciones`, `incapacidad` y `saldo`.
- Validacion por GPS, geocerca, evidencia/selfie y duplicados.
- Politicas configurables: tolerancia, radio de geocerca, evidencia obligatoria, GPS obligatorio, horas extra y salida olvidada.
- Incidencias aprobables/rechazables para permisos, vacaciones e incapacidades.
- Alertas automaticas: ausencia, salida olvidada, GPS faltante, evidencia faltante, geocerca y duplicados.
- Vista de quien esta trabajando ahora.
- Reportes por periodo, area y sucursal.
- Calendario de asistencia.
- Exportacion CSV de asistencia para revision interna.
- Auditoria de acciones administrativas.
- Panel de preparacion para WhatsApp Cloud API y API operativa.

## Como probar sin backend

1. Abre `index.html`.
2. Entra con el usuario precargado.
3. Selecciona un empleado y envia `entrar`.
4. Prueba con GPS cerca de Sucursal Centro: `19.432608`, `-99.133209`.
5. Prueba otra entrada sin GPS para ver alertas.
6. Envia `vacaciones 10/06 al 12/06` y aprueba la incidencia.
7. Exporta el CSV de asistencia.

## Publicar en GitHub Pages

1. Sube estos archivos al repositorio `doguiwhatsapp`.
2. En GitHub ve a `Settings` > `Pages`.
3. Elige `Deploy from a branch`.
4. Selecciona branch `main` y folder `/root`.
5. Guarda y abre la URL que GitHub genere.

La guia corta esta en `GITHUB_PAGES.md`.

## Como probar con backend y base de datos

1. Abre PowerShell en esta carpeta.
2. Ejecuta:

```powershell
.\run-server.ps1
```

3. Abre:

```text
http://127.0.0.1:8080
```

El servidor crea `checador.db` automaticamente. Cuando usas la app desde `http://127.0.0.1:8080`, el frontend sincroniza datos con `/api/state`.

Si necesitas variables de Meta, copia `.env.example` a `.env`; `run-server.ps1` lo carga automaticamente.

Usuario inicial:

```text
admin@empresa.mx
admin123
```

## API empresarial agregada

- `POST /api/login`: login con contrasena y cookie de sesion.
- `POST /api/logout`: cierre de sesion.
- `GET /api/me`: usuario actual.
- `GET /api/health`: estado de base de datos, WhatsApp, SendGrid, Twilio y URL publica.
- `GET /api/employees` y `POST /api/employees`: empleados.
- `DELETE /api/employees/:id`: baja logica.
- `GET /api/records`: registros.
- `GET /api/issues`: incidencias.
- `POST /api/issues/:id/status`: aprobar/rechazar.
- `GET /api/media`: evidencias recibidas por WhatsApp.
- `GET/POST /api/security/tickets`: tickets reales del Security Assistant.
- `POST /api/security/tickets/:id/status`: cambio de estado de tickets.
- `GET /api/security/alerts`: alertas internas de ciberseguridad.
- `GET /api/phishing/templates`: plantillas de phishing.
- `GET/POST /api/phishing/campaigns`: campanas de phishing.
- `POST /api/phishing/campaigns/:id/launch`: lanzamiento y medicion inicial.
- `GET /api/phishing/reports/monthly`: reporte mensual agregado.
- `GET /t/:campaignId/:targetId`: tracking de clics.
- `GET /r/:campaignId/:targetId`: tracking de reportes.
- `GET /training/:campaignId/:targetId`: capacitacion y cierre.
- `POST /api/alerts/:id/status`: cerrar/actualizar una alerta.
- `POST /api/policy`: actualizar politicas de asistencia.
- `POST /api/branches`: alta/edicion de sucursales.
- `GET /api/state`, `PUT /api/state` y `POST /api/state`: estado consolidado para el panel, con concurrencia optimista por `version` (ver seccion Seguridad).

La base ya no depende de un solo JSON: `server.py` crea tablas normalizadas para empresas, sucursales, politicas, usuarios, sesiones, empleados, registros, incidencias, alertas, auditoria, chat, webhooks, media, tickets de seguridad, evidencia, plantillas, campanas, targets, eventos de phishing y capacitaciones.

## WhatsApp Cloud API real

El backend incluye el webhook:

```text
GET/POST /webhooks/whatsapp
```

Variables de entorno:

- `PUBLIC_BASE_URL`: dominio HTTPS publico usado para ligas de tracking de phishing.
- `CORS_ORIGIN`: opcional, origen permitido si el frontend de GitHub Pages consume un backend externo.
- `WHATSAPP_VERIFY_TOKEN`: token que capturas en Meta para verificar el webhook.
- `WHATSAPP_TOKEN`: token de acceso de WhatsApp Cloud API.
- `WHATSAPP_PHONE_NUMBER_ID`: ID del numero de WhatsApp en Meta.
- `META_APP_SECRET`: obligatorio para recibir mensajes reales. Valida la firma `X-Hub-Signature-256`; si no esta configurado, el servidor rechaza todo el trafico entrante del webhook (fail-closed) en lugar de aceptarlo sin verificar.
- `GRAPH_API_VERSION`: version de Graph API usada para mensajes/media.
- `SENDGRID_API_KEY` y `EMAIL_FROM`: envio de campanas por correo.
- `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` y `TWILIO_FROM`: envio de campanas por SMS.

Para exponerlo a Meta necesitas un dominio HTTPS o un tunel como ngrok/cloudflared apuntando a `http://127.0.0.1:8080`.

URL de callback:

```text
https://tu-dominio.com/webhooks/whatsapp
```

Verify token:

```text
el valor de WHATSAPP_VERIFY_TOKEN
```

Tambien puedes simular un mensaje entrante:

```powershell
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:8080/api/simulate-whatsapp -ContentType 'application/json' -Body '{"from":"+525512340001","text":"entrar"}'
```

El webhook soporta mensajes de texto, ubicacion, imagen, documento, video y audio. Los mensajes duplicados por `wa_message_id` se ignoran para evitar dobles checadas. Si `WHATSAPP_TOKEN` esta configurado, las evidencias multimedia se descargan en la carpeta `media`.

Si el mensaje contiene terminos como `link sospechoso`, `correo falso`, `archivo raro`, `fraude`, `SAT`, `banco`, `proveedor`, o llega como documento sospechoso, DOGUI crea automaticamente un ticket en `security_tickets`, genera una alerta interna y responde por WhatsApp con una instruccion segura.

## Security Assistant y Phishing Simulator reales

El panel funciona en dos modos:

- GitHub Pages: demo visual con datos en `localStorage`.
- Backend local/publico: SQLite, sesiones, webhook, tickets, campanas y tracking real.

Para que GitHub Pages apunte a un backend publicado, configura en la consola del navegador o en un script previo:

```js
localStorage.setItem("dogui-api-base", "https://tu-dominio.com");
```

Tambien puedes declarar `window.DOGUI_API_BASE = "https://tu-dominio.com"` antes de cargar `app.js`.

El simulador puede enviar por:

- WhatsApp Cloud API si `WHATSAPP_TOKEN` y `WHATSAPP_PHONE_NUMBER_ID` existen.
- SMS con Twilio si `TWILIO_*` existe.
- Correo con SendGrid si `SENDGRID_API_KEY` existe y los targets tienen email.

Si un proveedor no esta configurado, la campana corre en modo simulado: marca objetivos como enviados, crea URLs de tracking y conserva las metricas para presentacion.

## DOGUI Joule (copiloto de IA)

Inspirado en SAP Joule: un copiloto conversacional embebido, con "skills" que consultan y accionan sobre los datos reales del panel (no un chatbot generico). Se abre con el boton flotante (esquina inferior derecha) desde cualquier vista.

- Al abrirlo, Joule da un briefing con lo importante del momento: gente en turno, incidencias pendientes, tickets de prioridad alta y alertas activas.
- Las skills funcionan siempre, sin backend ni API key, igual que el resto de la demo (GitHub Pages incluido). Cubren toda la plataforma, no solo asistencia:
  - **Operacion**: "Quien esta trabajando ahora", "Resume el riesgo de hoy", "Cuantos registros hay hoy", "Quien llego tarde hoy".
  - **Incidencias**: "Que incidencias estan pendientes", "Aprueba las vacaciones de Ana Lopez", "Rechaza el permiso de Carlos Mendez".
  - **Empleados**: "Cuantos empleados activos hay", "Empleados de Operaciones", "Agrega un empleado llamado Luis Perez con telefono +52 55 0000 0000 area Ventas", "Da de baja a Carlos Mendez" (pide confirmacion antes de ejecutar).
  - **Sucursales**: "Que sucursales hay", "Cambia a la sucursal Planta Norte", "Agrega la sucursal Sur en 19.3, -99.2".
  - **Politicas**: "Cual es la politica actual", "Cambia la tolerancia a 15 minutos", "Desactiva el GPS obligatorio", "Activa la evidencia obligatoria".
  - **Seguridad**: "Cuantos tickets de prioridad alta hay abiertos", "Todos los tickets", "Crea un ticket por link sospechoso para Carlos Mendez", "Cierra el ticket DG-0001", "Pon en revision el ticket DG-0002", "Que alertas hay", "Cierra la alerta de Ana Lopez".
  - **Phishing**: "Como va el score de phishing", "Que campanas hay", "Lanza una campana de phishing con la plantilla Aviso SAT para Ventas" (pide confirmacion), "Score de Ventas".
  - **Auditoria y reportes**: "Que ha pasado hoy", "Reporte de esta semana", "Exporta el reporte de asistencia".
  - **Navegacion**: "Llevame a incidencias", "Ve a seguridad", "Abre la seccion de auditoria".
- Las acciones potencialmente destructivas (dar de baja empleados, lanzar campanas de phishing) piden confirmacion conversacional: Joule pregunta y solo ejecuta si la siguiente respuesta es "si"/"confirmar"/"dale"/"ok"; cualquier otra cosa cancela sin hacer cambios.
- Todas las acciones usan las mismas funciones que los botones del panel (o sus mismos endpoints dedicados), asi que quedan registradas en auditoria y sincronizadas con el backend igual que cualquier otra accion.
- Capa opcional de lenguaje libre: si la skill local no entiende la pregunta y el backend tiene `ANTHROPIC_API_KEY` configurada, la pregunta se manda a `/api/joule/query`, que arma un snapshot de los datos reales (incidencias, tickets, alertas, campanas) y se lo pasa a un modelo de Claude para responder en espanol, con instruccion explicita de no inventar datos fuera del snapshot. Sin la API key configurada, Joule sigue funcionando por completo con las skills deterministas.
- Variables relevantes en `.env`: `ANTHROPIC_API_KEY` (vacio = capa generativa desactivada) y `JOULE_MODEL` (modelo a usar, por defecto `claude-sonnet-5`).

## Pruebas automatizadas

```powershell
python -m unittest discover -s tests -v
```

Sin dependencias externas (solo `unittest` de la libreria estandar, igual que el resto del proyecto). Levanta el servidor real sobre un puerto y una base de datos temporales, e incluye la lista blanca de estaticos, autenticacion (incluyendo los endpoints de lectura), verificacion de firma del webhook, permisos por rol y un flujo completo de login -> incidencia -> aprobacion. Corre en cada push/PR via GitHub Actions (`.github/workflows/tests.yml`).

## Seguridad

- El servidor solo sirve `index.html`, `app.js` y `styles.css` como archivos estaticos; cualquier otra ruta (`.env`, `checador.db`, `server.py`, etc.) responde 404 en lugar de exponerse por el fallback de archivos estaticos.
- Todos los endpoints `GET` que devuelven datos de la empresa (`/api/state`, `/api/employees`, `/api/records`, `/api/issues`, `/api/media`, tickets, alertas, campanas de phishing) requieren sesion iniciada. Solo quedan publicos `/api/health`, `/api/me` y el catalogo generico `/api/phishing/templates`.
- `/api/simulate-whatsapp` requiere sesion iniciada; ya no acepta eventos anonimos.
- `/webhooks/whatsapp` rechaza (fail-closed) cualquier mensaje si `META_APP_SECRET` no esta configurado o la firma no coincide, en vez de aceptarlo sin verificar.
- Acciones administrativas (dar de baja empleados, aprobar/rechazar incidencias, cerrar tickets, lanzar campanas de phishing) requieren un rol distinto de `Empleado` (`require_role`). Hoy solo existe la cuenta admin sembrada (`Dueno`), asi que esto es proteccion a futuro para cuando se creen mas cuentas.
- La cookie de sesion se marca `Secure` automaticamente cuando `PUBLIC_BASE_URL` apunta a `https://`.
- El servidor imprime avisos al arrancar si `META_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN` o `PUBLIC_BASE_URL` siguen en valores inseguros/por defecto.
- El panel ya usa endpoints por recurso para sus acciones administrativas en vez de depender solo del guardado de estado completo: alta/edicion/baja de empleados (`POST`/`DELETE /api/employees`), aprobar/rechazar incidencias (`POST /api/issues/:id/status`), cerrar alertas (`POST /api/alerts/:id/status`), politicas (`POST /api/policy`) y sucursales (`POST /api/branches`). Esto hace que los permisos por rol arriba mencionados realmente se apliquen desde la interfaz, no solo si alguien llama a la API directamente.
- `PUT/POST /api/state` (usado para lo que aun no tiene endpoint dedicado: filtros de reporte, seleccion de sucursal/empresa, chat y registros en modo demo) ahora usa concurrencia optimista: cada snapshot trae un numero de `version`, y el guardado se rechaza con 409 si otro usuario ya guardo cambios primero, en vez de sobreescribirlos en silencio. El cliente detecta el 409 y recarga el estado real del servidor automaticamente.

## Que faltaria para produccion completa

- Hospedar `server.py` detras de HTTPS con dominio propio.
- Configurar plantillas de WhatsApp aprobadas por Meta para mensajes proactivos.
- Agregar email real al catalogo de empleados para campanas por correo.
- Agregar aviso de privacidad, consentimiento y politicas internas.
- Integracion directa con SIEM/ticketing externo.

## Modelo de backend recomendado

- `POST /webhooks/whatsapp`: recibe mensajes de WhatsApp.
- `POST /records`: crea registros de asistencia.
- `GET /reports/attendance`: genera reporte de asistencia.
- `POST /issues/:id/approve`: aprueba permisos, vacaciones e incapacidades.
- `GET /audit`: consulta historial de cambios.

La app actual ya deja modelados los datos y reglas para convertirla despues en una aplicacion con backend real.
