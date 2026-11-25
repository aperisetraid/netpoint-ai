# Telemetría de referencia ("oro")

Salida de referencia del pipeline de visión para validar cambios con `benchmark.py compare`
(regla de oro 2 de `CLAUDE.md`). Los vídeos no se versionan (`*.mp4` está en `.gitignore`):
cada oro solo es comparable con el vídeo del que salió, colocado en `apps/assets/`.

| Oro | Vídeo (`apps/assets/`) | Frames | Botes | Golpes |
|---|---|---|---|---|
| `sinner_zverev.gold.json` | `sinenr vs zverev.mp4` | 369 | 115, 198, 255, 324 | 98, 136, 218, 279, 341 |
| `test_trim.gold.json` | `Test - Trim.mp4` | 728 | 122, 258, 408, 634, 709 | 95, 164, 208, 281, 329, 674 |
| `test_corto.gold.json` | `Test corto.mp4` | 329 | 121, 256 | 94, 163, 208, 281 |

Los eventos de estos oros se han revisado a mano sobre el vídeo.

Velocidades de saque de referencia:

| Vídeo | Saque | Referencia | Pipeline |
|---|---|---|---|
| Sinner – Zverev | Zverev, frame 98 | sin radar en el clip; tiempo contacto→bote compatible con 220–235 km/h | 223 km/h |
| Shelton – Alcaraz (`Test - Trim` / `Test corto`) | Shelton, 2º saque, frame 95 / 94 | radar del estadio: 101 mph = 162,5 km/h | 158 km/h |

`Test corto` es un recorte de `Test - Trim` (el mismo punto, desfasado 1 frame), así que sus
eventos comunes deben coincidir.

## Uso

Desde `apps/vision-ai`, con `.venv` activo:

```
python src/benchmark.py run "../assets/sinenr vs zverev.mp4" new.json
python src/benchmark.py compare benchmarks/sinner_zverev.gold.json new.json
```

`compare` sale con código 1 si el resultado queda fuera de tolerancia (botes ±1 frame, golpes
según `HIT_FRAME_TOLERANCE`).

## Regenerar un oro

Solo cuando un cambio añade o corrige eventos **y** se ha comprobado en el vídeo que son reales.
Se sube en el mismo commit que el código que lo cambia, explicando la diferencia.

```
python src/benchmark.py run "../assets/sinenr vs zverev.mp4" benchmarks/sinner_zverev.gold.json
```

Los `*.timing.json` que genera `run` dependen de la máquina y no se versionan.
