# 0001 · Sin base de datos: un partido es una carpeta

**Estado:** aceptada

## Contexto

Un análisis se calcula una sola vez, offline, a partir de un clip corto, y después solo se lee: se abre, se
reproduce, se consulta. Cada partido produce un vídeo y un JSON de telemetría de unos cientos de KB, más una
miniatura, los colores de la pista y, si se usa, la conversación con el coach. No hay usuarios, ni relaciones entre
partidos, ni consultas que crucen varios análisis.

## Decisión

Cada partido es una carpeta con nombre UUID en `temp/matches/<id>/`: `telemetry_output.json` (esquema versionado,
v2), el vídeo, `meta.json`, `thumbnail.jpg`, `court_colors.json` y `coach_session.json`. La biblioteca se lista
leyendo esas carpetas (`library.py`), con una caché por fecha de modificación.

## Consecuencias

- **A favor:** nada que instalar ni migrar; un partido se copia, se borra o se publica moviendo una carpeta (así se
  construye la demo pública); el JSON es el contrato entre servicios y se inspecciona a simple vista.
- **En contra:** no escala a muchos usuarios ni permite búsquedas complejas; dos procesos escribiendo el mismo
  partido podrían pisarse (no ocurre: cada análisis crea su propia carpeta).
- **Cuándo revisarla:** al añadir usuarios y bibliotecas propias (está en la hoja de ruta): metadatos y sesiones a
  una base de datos, vídeos y telemetría a almacenamiento de objetos.
