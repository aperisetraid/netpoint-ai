# 0004 · Demo pública de solo lectura con una imagen Docker ligera

**Estado:** aceptada

## Contexto

El tutor del TFM debe poder probar la aplicación desde un navegador, sin instalar nada y sin coste. El servicio de
visión completo, con YOLO y PyTorch, ocupa unos 3 GB y necesita más memoria de la que dan los planes gratuitos
(512 MB). Los vídeos son clips de retransmisiones de TV: no deben acabar en un repositorio público. Y cada
respuesta del coach se paga.

## Decisión

Desplegar en Render tres servicios gratuitos: la web como sitio estático (`VITE_DEMO_MODE=1`), el API en Node y el
servicio de visión como imagen Docker ligera (`Dockerfile.serve`) sin YOLO, PyTorch ni el SDK de Anthropic. La
imagen lleva dentro los partidos ya analizados (`deploy-library/`, ignorado por Git), se publica en un registro
privado de GitHub y arranca en modo solo lectura: `/process-*` responde 503 y las rutas del coach no existen.

## Consecuencias

- **A favor:** demo en internet a coste cero; imagen de unos 560 MB que cabe en 512 MB de RAM; los vídeos nunca
  pasan por Git; nadie puede gastar la clave de Anthropic.
- **En contra:** no se analizan vídeos nuevos ni se usa el coach en la demo (sí en local); tras un rato sin visitas
  los servicios se duermen y la primera carga tarda alrededor de un minuto (la web lo explica y reintenta sola).
- **Detalle:** [DEPLOY.md](../../DEPLOY.md).
