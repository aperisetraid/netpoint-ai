# Despliegue de la demo pública (Render, capa gratuita)

Demo de solo lectura para que el tutor del TFM explore partidos ya analizados y use el coach. No analiza
vídeos nuevos: el servicio de visión se publica sin YOLO/PyTorch (no caben en 512 MB) y responde 503 a
`/process-*`.

```
web (Static Site) ──REST──▶ api-backend (Node) ──HTTP──▶ vision-ai (imagen Docker con los partidos)
        └────────── vídeo, frames y miniaturas ────────────────▲          └──▶ Anthropic API
```

## 1. Preparar la biblioteca

Los partidos van dentro de la imagen de visión; los vídeos **nunca** pasan por Git
(`apps/vision-ai/deploy-library/` está en `.gitignore`). Cada partido es una carpeta con nombre UUID:

```
apps/vision-ai/deploy-library/<uuid>/
  telemetry_output.json   # telemetría v2 generada por el pipeline actual
  <vídeo>.mp4
  meta.json               # {"title": "...", "source": "upload", "createdAt": "..."}
```

Ya hay dos preparados (Zverev vs Sinner y Shelton vs Alcaraz, con la telemetría de `benchmarks/`). Para añadir
otro, copia su carpeta desde `apps/vision-ai/temp/matches/`, después de volver a analizarlo con el código actual
si es antiguo.

## 2. Construir y publicar la imagen de visión (en local)

Desde `apps/vision-ai`, con Docker y un token de GitHub con `write:packages`:

```
docker build -f Dockerfile.serve -t ghcr.io/<usuario>/netpoint-vision:demo .
docker login ghcr.io -u <usuario>
docker push ghcr.io/<usuario>/netpoint-vision:demo
```

El paquete queda **privado** en GHCR. Prueba previa en local con el límite de memoria de Render:

```
docker run --rm -m 512m -p 8001:8000 -e NETPOINT_COACH_ACCESS_CODE=prueba ghcr.io/<usuario>/netpoint-vision:demo
curl http://localhost:8001/library/matches
```

## 3. Crear los servicios en Render (en este orden)

| Servicio | Cómo | Configuración |
|---|---|---|
| **vision-ai** | New → Web Service → *Existing image* `ghcr.io/<usuario>/netpoint-vision:demo`, con una credencial de registro (token de GitHub con `read:packages`). Instancia *Free*. | `ANTHROPIC_API_KEY` (secreta), `NETPOINT_COACH_ACCESS_CODE` (el código que darás al tutor), `NETPOINT_COACH_DAILY_LIMIT` (p. ej. `40`). Opcionales: `NETPOINT_COACH_MODEL`, `NETPOINT_COACH_EFFORT`. Health check: `/library/matches`. |
| **api-backend** | New → Web Service → este repositorio. Root Directory `apps/api-backend`. Build `npm ci && npm run build`. Start `npm start`. Instancia *Free*. | `VISION_BASE_URL=https://<vision>.onrender.com`, `NODE_VERSION=26`. Health check: `/health`. |
| **web** | New → Static Site → este repositorio. Root Directory `apps/web`. Build `npm ci && npm run build`. Publish directory `dist`. | `VITE_DEMO_MODE=1`, `VITE_API_BASE_URL=https://<api>.onrender.com`, `VITE_VISION_BASE_URL=https://<vision>.onrender.com`, `NODE_VERSION=26`. |

`NETPOINT_READ_ONLY=1` y `NETPOINT_LIBRARY_DIR=/data/matches` ya vienen en la imagen. Las variables `VITE_*` se
fijan al compilar: si cambias una URL, vuelve a desplegar la web.

## 4. Proteger el saldo de Anthropic

- Usa una **clave dedicada** a la demo, para poder revocarla al terminar.
- En la consola de Anthropic, fija un **límite de gasto mensual** al workspace de esa clave.
- `NETPOINT_COACH_DAILY_LIMIT` corta a los N mensajes por día (en memoria: se reinicia si el servicio se reinicia).
- Sin el código (`X-Access-Code`), el coach responde 401; la web lo pide una vez y lo recuerda en el navegador.

## 5. Qué enviar al tutor

- La URL de la web y el código de acceso del coach.
- Aviso: tras un rato sin uso, la primera carga tarda ~1 minuto (Render despierta la API y la visión).

## 6. Actualizar

- Código de web/API: push a la rama conectada y Render redepliega solo.
- Partidos o código de visión: vuelve a construir y publicar la imagen (paso 2) y en Render
  *Manual Deploy → Deploy latest reference*.

## Limitaciones asumidas

- Cualquiera con la URL puede explorar los partidos; solo el coach lleva código. Los clips son de emisiones de
  TV: comparte el enlace, no lo publiques.
- Las conversaciones del coach se guardan en el disco efímero del contenedor y se pierden al reiniciarse.
- Sin análisis de vídeos nuevos (necesitaría CPU/GPU y una imagen de ~3 GB).
