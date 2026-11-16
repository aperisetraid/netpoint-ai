# NetPoint AI — Contexto del Proyecto (TFM)

## Descripción General
Plataforma SaaS de análisis táctico de tenis basada en visión por computador (clips cortos procesados de forma asíncrona/offline con exportación de telemetría estructurada en JSON), una interfaz web interactiva y un coach conversacional basado en LLM sobre la telemetría.

## Arquitectura (monorepo, 3 servicios)
```
apps/web          React + Vite (UI)  ──HTTP/SSE──▶  apps/api-backend (Fastify, :3000)  ──HTTP──▶  apps/vision-ai (FastAPI, :8000)
packages/openapi-spec/openapi.yaml  → contrato de la API pública (mantenerlo sincronizado al cambiar endpoints)
```
- **`apps/vision-ai/src`** (Python): pipeline de visión y biblioteca de partidos.
  - `tracker.py` (detección/tracking), `ball_tracking.py`, `trajectory.py`, `events.py` (botes y golpes), `court_detector.py`, `homography.py`, `camera.py`.
  - `main.py` orquesta el pipeline; `server.py` expone FastAPI (`/process-video`, `/process-upload`, `/matches`, `/library/matches`, `/coach`); `library.py` persiste partidos en `temp/matches/<matchId>/`.
  - `coach/` — agente LLM (Anthropic API) con herramientas sobre la telemetría. Configurable con `NETPOINT_COACH_MODEL`, `NETPOINT_COACH_EFFORT` y credenciales `ANTHROPIC_*`.
  - `benchmark.py` — harness de regresión/velocidad; `stage_timers.py` — profiling (`NETPOINT_PROFILE=1`).
- **`apps/api-backend/src`** (TypeScript, Fastify): arquitectura por capas `controllers/` → `use-cases/` → `domain/` + `infrastructure/`. Hace de proxy hacia `vision-ai` (URLs `http://localhost:8000` definidas en cada use-case). Usa `undici` (`long-running-fetch.ts`) para peticiones largas.
- **`apps/web/src`** (React 19, Tailwind 4): `components/` por feature (landing, ingest, library, video, stats, coach, court, inspector, loader), `hooks/` (`useMatchAnalysis`, `useCoachChat`), `lib/` (lógica pura testeable), `services/` (clientes API).
- Los directorios `src/` y `test/` de la raíz son residuales; el código vive en `apps/`.

## Stack Tecnológico
- **Backend / Visión:** Python 3.15 (`.venv`), FastAPI, Ultralytics YOLO, OpenCV, NumPy.
  - *Nota:* Existe un entorno secundario `.venv312` (Python 3.12) exclusivamente para pruebas con OpenVINO; el pipeline principal corre en `.venv`.
- **API:** Node + TypeScript, Fastify (con swagger), `tsx`.
- **Frontend:** React, TypeScript, Vite, Tailwind CSS.
  - **Restricción estricta:** NO usar Material-UI (MUI). Mantener una interfaz limpia, minimalista y cinemática con Tailwind CSS.

## Comandos
Desde la carpeta de cada app (shell principal: PowerShell en Windows):
| Servicio | Arrancar | Tests |
|---|---|---|
| vision-ai (`apps/vision-ai`) | `uvicorn server:app --app-dir src --port 8000` (con `.venv` activo) | `python -m unittest discover -s src -p "*_test.py"` |
| api-backend | `npm run dev` / `npm run build` | `npm test` |
| web | `npm run dev` / `npm run build` / `npm run lint` | `npm test` |

Benchmark del pipeline:
```
python src/benchmark.py run VIDEO OUT.json
python src/benchmark.py compare GOLD.json NEW.json   # exit 1 si queda fuera de tolerancia
```

## Reglas de Oro del Pipeline de Visión (`tracker.py`)
1. **La precisión manda sobre la velocidad:** El procesamiento es offline sobre clips cortos; nunca comprometer la detección de eventos discretos (botes y golpes) por ganar FPS.
2. **Validación obligatoria:** Cualquier cambio en el pipeline de visión debe pasar `benchmark.py compare` contra el JSON de referencia ("oro") manteniendo los botes (±1 frame) y golpes (tolerancia vigente en `benchmark.py`: `HIT_FRAME_TOLERANCE`). Las tolerancias viven en `benchmark.py`: no relajarlas para que un cambio pase.
3. **Configuración consolidada:**
   - Mantener `FrameFeatures` (caché compartida de HSV y *top-hat* entre fotogramas).
   - Mantener el pase completo de YOLO con las clases `[0, 32]` (persona + pelota) a `640 px` y `yolo_court` activo en todos los frames.
   - Mantener `pytorch` como backend por defecto (`NETPOINT_BACKEND=pytorch`). Los flags experimentales (`NETPOINT_PLAYER_STRIDE`, `NETPOINT_COURT_STRIDE`, `NETPOINT_PLAYER_ONLY`, `NETPOINT_FULL_IMGSZ` y `openvino`) quedan documentados como fuera de tolerancia y desactivados por defecto.

## Convenciones de Desarrollo
- **Idioma:** Código, variables, commits y comentarios técnicos en inglés (o siguiendo la convención existente en cada archivo); respuestas y explicaciones al usuario en español. Los textos de UI y errores de la API están en español.
- **Arquitectura de datos:** El frontend consume los JSON de telemetría (`telemetry_output.json`: botes, golpes, trayectorias, *timestamps*, posiciones de jugadores) generados por el backend desde la biblioteca de partidos persistente. Si cambias el esquema de telemetría, actualiza a la vez `vision-ai`, `api-backend`, `web` y `openapi.yaml`.
- **Tests:** Python `*_test.py` junto al código (unittest); web con `node --test` en `apps/web/test`; API en `server.test.ts`. Añade/ajusta tests al tocar lógica; mantén la lógica del frontend en `lib/` como funciones puras.
- **Datos generados:** `temp/`, vídeos y pesos (`*.pt`, `yolov8n_openvino_model`) no son código; no los edites a mano ni los borres sin confirmar.
- **Secretos:** nunca commitear `.env` ni claves `ANTHROPIC_*`.
- **Control de versiones:** No hacer `git commit` automático sin confirmación explícita.
