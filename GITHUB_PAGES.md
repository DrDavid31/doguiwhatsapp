# Publicar en GitHub Pages

Este proyecto ya puede correr como demo estatica en GitHub Pages.

## Activar Pages

1. Entra a tu repositorio `doguiwhatsapp`.
2. Ve a `Settings`.
3. Abre `Pages`.
4. En `Build and deployment`, selecciona:
   - Source: `Deploy from a branch`
   - Branch: `main`
   - Folder: `/root`
5. Guarda.

GitHub te dara una URL parecida a:

```text
https://TU_USUARIO.github.io/doguiwhatsapp/
```

## Importante

GitHub Pages no ejecuta Python ni SQLite. En Pages se muestra la demo estatica con datos de presentacion y almacenamiento local del navegador.

Para usar backend real, WhatsApp Cloud API y base de datos, ejecuta:

```powershell
.\run-server.ps1
```

Y abre:

```text
http://127.0.0.1:8080
```
