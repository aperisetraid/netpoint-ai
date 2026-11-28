# 0003 · El coach de IA no calcula: interpreta datos ya calculados

**Estado:** aceptada

## Contexto

El coach responde en lenguaje natural sobre un partido (`apps/vision-ai/src/coach/`, con Claude de Anthropic). Un
modelo de lenguaje puede redactar cifras plausibles que no salen de los datos, y en un análisis deportivo una
estadística inventada es peor que ninguna.

## Decisión

Toda cifra la calcula código determinista y probado (`coach/analysis.py`). El modelo recibe un resumen congelado
del partido y cuatro herramientas para consultar la telemetría; su papel es elegir qué consultar, interpretar y
explicar. Sus citas de tiempo (`[m:ss](#t=…)`) enlazan al vídeo para que cada afirmación se pueda comprobar.

## Consecuencias

- **A favor:** respuestas ancladas a datos y verificables; el cálculo tiene tests como el resto del proyecto; si
  cambia la telemetría, la sesión del coach se reinicia en lugar de mezclar datos.
- **En contra:** el coach solo sabe responder lo que las herramientas exponen; cada respuesta tiene un coste de API.
- **Relacionada:** por ese coste, la demo pública no incluye el coach ([0004](0004-demo-publica-de-solo-lectura.md)).
