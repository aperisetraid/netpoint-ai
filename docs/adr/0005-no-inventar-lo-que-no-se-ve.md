# 0005 · Lo que no se ve no se inventa

**Estado:** aceptada

## Contexto

Con una sola cámara hay momentos en que la bola no aparece en ningún fotograma: bota detrás del cuerpo de un
jugador, o va tan rápida que ningún detector la capta. Siempre se podría «rellenar» el hueco con una estimación,
pero un bote mal colocado en el mapa o en la repetición 3D es más engañoso que uno que falta.

## Decisión

Un evento solo se publica si hay evidencia en el vídeo que lo respalde: una inversión del movimiento de la bola
confirmada por la física del vuelo, o una bola que se pierde junto a un jugador y reaparece alejándose de él. Toda
posición estimada va marcada (`interpolated`, `carried_forward`) y cada evento lleva su `confidence` y su
`method`, para que la interfaz y el usuario sepan cuánto fiarse.

## Consecuencias

- **A favor:** cero eventos falsos en los partidos de referencia; la interfaz distingue lo medido de lo estimado
  (línea discontinua en el inspector, nota en la vista 3D).
- **En contra:** algunos eventos reales se quedan sin detectar. En Wimbledon (25 fps) hay dos botes que ocurren
  detrás de la jugadora y no aparecen en ningún fotograma; se intentó deducirlos con un ajuste 3D y se descartó
  porque los colocaba con varios fotogramas de error. Medido en `apps/vision-ai/benchmarks/README.md`.
