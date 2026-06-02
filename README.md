# Checador de tiempo por WhatsApp

Prototipo avanzado de reloj checador empresarial por WhatsApp. Funciona como app estatica: abre `index.html` en el navegador y los datos se guardan en `localStorage`.

Tambien esta listo para GitHub Pages como demo de presentacion. En Pages se muestra un modo demo con datos precargados; el backend real se usa cuando corres `run-server.ps1`.

## Modulos incluidos

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
- Exportacion CSV para nomina.
- Auditoria de acciones administrativas.
- Panel de preparacion para WhatsApp Cloud API y API de nomina.

## Como probar sin backend

1. Abre `index.html`.
2. Entra con el usuario precargado.
3. Selecciona un empleado y envia `entrar`.
4. Prueba con GPS cerca de Sucursal Centro: `19.432608`, `-99.133209`.
5. Prueba otra entrada sin GPS para ver alertas.
6. Envia `vacaciones 10/06 al 12/06` y aprueba la incidencia.
7. Exporta el CSV de nomina.

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
- `GET /api/employees` y `POST /api/employees`: empleados.
- `DELETE /api/employees/:id`: baja logica.
- `GET /api/records`: registros.
- `GET /api/issues`: incidencias.
- `POST /api/issues/:id/status`: aprobar/rechazar.
- `GET /api/media`: evidencias recibidas por WhatsApp.
- `GET /api/state` y `PUT /api/state`: estado consolidado para el panel.

La base ya no depende de un solo JSON: `server.py` crea tablas normalizadas para empresas, sucursales, politicas, usuarios, sesiones, empleados, registros, incidencias, alertas, auditoria, chat, webhooks y media.

## WhatsApp Cloud API real

El backend incluye el webhook:

```text
GET/POST /webhooks/whatsapp
```

Variables de entorno:

- `WHATSAPP_VERIFY_TOKEN`: token que capturas en Meta para verificar el webhook.
- `WHATSAPP_TOKEN`: token de acceso de WhatsApp Cloud API.
- `WHATSAPP_PHONE_NUMBER_ID`: ID del numero de WhatsApp en Meta.
- `META_APP_SECRET`: opcional, valida la firma `X-Hub-Signature-256`.
- `GRAPH_API_VERSION`: version de Graph API usada para mensajes/media.

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

## Que faltaria para produccion completa

- Autenticacion real con contrasenas, sesiones y permisos.
- Integracion con plantillas de WhatsApp aprobadas por Meta.
- Carga real de fotos/evidencias y documentos de incapacidad.
- Control legal de consentimiento y aviso de privacidad.
- Integracion directa con sistema de nomina.

## Modelo de backend recomendado

- `POST /webhooks/whatsapp`: recibe mensajes de WhatsApp.
- `POST /records`: crea registros de asistencia.
- `GET /reports/payroll`: genera reporte para nomina.
- `POST /issues/:id/approve`: aprueba permisos, vacaciones e incapacidades.
- `GET /audit`: consulta historial de cambios.

La app actual ya deja modelados los datos y reglas para convertirla despues en una aplicacion con backend real.
