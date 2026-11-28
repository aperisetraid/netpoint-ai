# Decisiones de arquitectura (ADR)

Cada ficha recoge una decisión que condiciona el proyecto: el contexto en que se tomó, qué se decidió y qué
consecuencias tiene, buenas y malas. Sirven para responder al «¿por qué así?» sin reconstruirlo de memoria.

| N.º | Decisión | Estado |
|---|---|---|
| [0001](0001-sin-base-de-datos.md) | Sin base de datos: un partido es una carpeta | Aceptada |
| [0002](0002-precision-sobre-velocidad.md) | La precisión de los eventos manda sobre la velocidad | Aceptada |
| [0003](0003-el-coach-no-calcula.md) | El coach de IA no calcula: interpreta datos ya calculados | Aceptada |
| [0004](0004-demo-publica-de-solo-lectura.md) | Demo pública de solo lectura con una imagen Docker ligera | Aceptada |
| [0005](0005-no-inventar-lo-que-no-se-ve.md) | Lo que no se ve no se inventa | Aceptada |

Formato: contexto → decisión → consecuencias. Una decisión que cambie no se borra: se marca como sustituida y se
enlaza la nueva.
