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

## Wimbledon (Eala – Swiatek, 25 fps, hierba): caso límite sin oro

`Wimbledon.mp4` no tiene oro: el pipeline aún no lo resuelve entero y un oro solo puede recoger eventos
reales. Sirve para medir, con estos eventos revisados fotograma a fotograma sobre el vídeo:

| | Fotogramas reales | Pipeline |
|---|---|---|
| Golpes | 11 saque Eala · 38 · 74 · 106 · 147 · 177 · 208 · 266 · 294 · 308 volea Swiatek | los 10, a ±2 fotogramas y con su jugador |
| Botes | 26 · 66 · 100 · 135 · 167 · 202 · 246 · 290 · 328 | 26 · 135 · 167 · 246 · 328, ninguno falso |

Lo que lo hace difícil, y lo que se ajustó sin mover los tres oros:

- **25 fps:** la mitad de muestras que los otros clips. El lanzamiento del saque se tomaba por un bote:
  ahora se reconoce por dónde cae (en vertical, sobre el que saca) y adónde sale (al campo contrario).
- **Zapatillas al sol sobre hierba:** los detectores de color y movimiento las confundían con la bola y
  sus tramos ganaban a la bola real. Un tramo que pasa casi todo el tiempo a los pies de un jugador se
  descarta, y un punto suelto a sus pies al final de un tramo se recorta.
- **Bola perdida justo en el golpe:** muchos golpes ocurren sin verse la bola (tapada por el cuerpo o
  fuera de los detectores). Un golpe así se reconoce porque la bola se pierde junto a un jugador y
  reaparece alejándose de él; el instante es donde se cruzan sus trayectorias laterales antes y después.

Límites que quedan, medidos:

- **Botes 66 y 202:** la bola bota detrás del cuerpo de Eala y no aparece en ningún fotograma: no hay
  nada que medir. Se prefiere no inventarlos.
- **Botes 100 y 290:** se ven a medias (el último fotograma antes de perder la bola, o una subida lenta
  pegada a la jugadora que el filtro de jugador descarta).
- **Zurdos:** el tipo de golpe supone jugadores diestros, así que las derechas de Eala (zurda) salen como
  revés. `build_events` admite la mano de cada jugador (`handedness`); con `{"near": "left"}` los 10
  golpes salen con su tipo correcto.
