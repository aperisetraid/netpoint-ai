# 0002 · La precisión de los eventos manda sobre la velocidad

**Estado:** aceptada

## Contexto

El valor del producto está en los eventos discretos: dónde y cuándo bota la bola, quién golpea, a qué velocidad.
El análisis es offline sobre clips de segundos, así que tardar un minuto más no perjudica a nadie, pero un bote
desplazado dos fotogramas o un golpe perdido sí. Varias optimizaciones probadas aceleraban el pipeline
(OpenVINO, saltarse fotogramas en la detección de jugadores o de pista, analizar a otra resolución).

## Decisión

Ningún cambio en el pipeline de visión entra si mueve los eventos. Cada cambio se valida con `benchmark.py compare`
contra partidos de referencia («oros», en `apps/vision-ai/benchmarks/`) revisados a mano: botes a ±1 fotograma y
golpes según `HIT_FRAME_TOLERANCE`. Las tolerancias no se relajan para que un cambio pase.

## Consecuencias

- **A favor:** cualquier ajuste se puede hacer con confianza; las regresiones se ven como un diff, no como una
  impresión («parece que va mejor»).
- **En contra:** el pipeline va a unos 4–5 fotogramas por segundo en CPU. Las optimizaciones descartadas quedan
  documentadas como flags experimentales, desactivados por defecto.
- **Evidencia:** las mejoras para Wimbledon (25 fps, hierba) se aceptaron solo tras comprobar que los tres oros
  seguían dentro de tolerancia con el pipeline completo.
