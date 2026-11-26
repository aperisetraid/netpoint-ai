# Despliegue de la demo pública (Render, capa gratuita)

Demo de solo lectura para que el tutor del TFM explore partidos ya analizados: vídeo con overlay, mapa de botes,
estadísticas e inspector de fotogramas. **Sin coach ni análisis de vídeos nuevos**: el servicio de visión se
publica sin YOLO/PyTorch (no caben en 512 MB) ni el SDK de Anthropic, responde 503 a `/process-*` y no monta las
rutas `/coach`. La web, compilada con `VITE_DEMO_MODE=1`, oculta la subida de vídeos y el botón del coach. Coste: 0 €.

```
web (Static Site) ──REST──▶ api-backend (Node) ──HTTP──▶ vision-ai (imagen Docker con los partidos)
        └────────── vídeo, frames y miniaturas ────────────────▲
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

Desde `apps/vision-ai`, con Docker y un token de GitHub (classic) con `write:packages` y `read:packages`:

```
docker build -f Dockerfile.serve -t ghcr.io/<usuario>/netpoint-vision:demo .
docker login ghcr.io -u <usuario>
docker push ghcr.io/<usuario>/netpoint-vision:demo
```

El paquete queda **privado** en GHCR. Prueba previa en local con el límite de memoria de Render:

```
docker run --rm -m 512m -p 8001:8000 ghcr.io/<usuario>/netpoint-vision:demo
curl http://localhost:8001/library/matches
```

## 3. Crear los servicios en Render (en este orden)

Antes, en *Workspace Settings → Container Registry Credentials*, añade una credencial de GitHub con tu usuario y
el token anterior.

| Servicio | Cómo | Configuración |
|---|---|---|
| **vision-ai** | New → Web Service → *Existing image* `ghcr.io/<usuario>/netpoint-vision:demo`, con la credencial de registro. Instancia *Free*. | Sin variables: `NETPOINT_READ_ONLY=1` y `NETPOINT_LIBRARY_DIR=/data/matches` ya vienen en la imagen. Health check: `/library/matches`. |
| **api-backend** | New → Web Service → este repositorio. Root Directory `apps/api-backend`. Build `npm ci && npm run build`. Start `npm start`. Instancia *Free*. | `VISION_BASE_URL=https://<vision>.onrender.com`, `NODE_VERSION=26`. Health check: `/health`. |
| **web** | New → Static Site → este repositorio. Root Directory `apps/web`. Build `npm ci && npm run build`. Publish directory `dist`. | `VITE_DEMO_MODE=1`, `VITE_API_BASE_URL=https://<api>.onrender.com`, `VITE_VISION_BASE_URL=https://<vision>.onrender.com`, `NODE_VERSION=26`. |

Las variables `VITE_*` se fijan al compilar: si cambias una URL, vuelve a desplegar la web
(*Manual Deploy → Clear build cache & deploy*).

## 4. Qué enviar al tutor

- La URL de la web.
- Aviso: tras un rato sin uso, la primera carga tarda ~1 minuto (Render despierta la API y la visión).
- El coach se muestra en local (por ejemplo, en la defensa o en un vídeo grabado): necesita una clave de la API
  de Anthropic, que se factura aparte de la suscripción a Claude.

## 5. Actualizar

- Código de web/API: push a la rama conectada y Render redepliega solo.
- Partidos o código de visión: vuelve a construir y publicar la imagen (paso 2) y en Render
  *Manual Deploy → Deploy latest reference*.

## Limitaciones asumidas

- Cualquiera con la URL puede explorar los partidos. Los clips son de emisiones de TV: comparte el enlace, no lo
  publiques.
- Sin coach ni análisis de vídeos nuevos (necesitarían una clave de Anthropic de pago y CPU/GPU con una imagen
  de ~3 GB, respectivamente).
