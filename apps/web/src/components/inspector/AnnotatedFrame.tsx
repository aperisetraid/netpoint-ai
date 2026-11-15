import { useState } from 'react'
import { AlertTriangle, RefreshCw } from 'lucide-react'

import { formatPercent } from '../../lib/format.ts'
import { type FrameTelemetry, getMatchFrameUrl } from '../../services/api'

export type InspectionLayer = 'court' | 'player' | 'ball'

interface AnnotatedFrameProps {
  matchId: string
  frame: FrameTelemetry
  imageWidth: number
  imageHeight: number
  layers: Record<InspectionLayer, boolean>
}

/** Still image of one analysed frame with its calibration and detections drawn on top. */
export function AnnotatedFrame({ matchId, frame, imageWidth, imageHeight, layers }: AnnotatedFrameProps) {
  const [imageState, setImageState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [retry, setRetry] = useState(0)
  const labelSize = imageWidth / 45
  const imageUrl = `${getMatchFrameUrl(matchId, frame.frame_index)}?retry=${retry}`

  return (
    <div className="frame-inspector__image" style={{ aspectRatio: `${imageWidth} / ${imageHeight}` }}>
      <img
        key={imageUrl}
        src={imageUrl}
        alt={`Fotograma ${frame.frame_index} del video analizado`}
        onLoad={() => setImageState('ready')}
        onError={() => setImageState('error')}
        style={{ visibility: imageState === 'ready' ? 'visible' : 'hidden' }}
      />
      {imageState === 'ready' ? (
        <svg viewBox={`0 0 ${imageWidth} ${imageHeight}`} aria-label="Detecciones y calibración del fotograma" role="img">
          {layers.court && frame.court_corners?.length === 4 ? (
            <g className="frame-overlay__court">
              <polygon points={frame.court_corners.map((point) => point.join(',')).join(' ')} />
              {frame.court_corners.map(([pointX, pointY], index) => (
                <circle key={index} cx={pointX} cy={pointY} r={imageWidth / 180} />
              ))}
            </g>
          ) : null}
          {frame.detections.filter((detection) => layers[detection.class]).map((detection, index) => {
            const [left, top, right, bottom] = detection.bbox
            const height = typeof detection.z_meters === 'number' ? ` · ${detection.z_meters.toFixed(1)} m` : ''
            const label = `${detection.class === 'player' ? 'Jugador' : 'Pelota'} ${formatPercent(detection.confidence * 100)}${height}${detection.carried_forward ? ' (previo)' : ''}`
            const labelY = Math.max(labelSize * 1.3, top)
            const labelWidth = label.length * labelSize * 0.6
            const labelX = Math.max(0, Math.min(left, imageWidth - labelWidth))
            return (
              <g key={`${detection.class}-${index}`} className={`frame-overlay__${detection.class}`}>
                <rect x={left} y={top} width={Math.max(0, right - left)} height={Math.max(0, bottom - top)}
                  className={detection.carried_forward ? 'frame-overlay__carried' : undefined} />
                <rect className="frame-overlay__label-bg" x={labelX} y={labelY - labelSize * 1.3} width={labelWidth} height={labelSize * 1.3} />
                <text x={labelX + labelSize * 0.2} y={labelY - labelSize * 0.25} fontSize={labelSize}>{label}</text>
              </g>
            )
          })}
        </svg>
      ) : (
        <div className="frame-inspector__placeholder" role="status">
          {imageState === 'loading' ? <RefreshCw size={20} className="animate-spin" /> : <AlertTriangle size={20} />}
          <span>{imageState === 'loading' ? 'Cargando fotograma...' : 'Fotograma no disponible. Vuelve a analizar el video si reiniciaste el servicio.'}</span>
          {imageState === 'error' ? (
            <button className="icon-button" type="button" title="Reintentar carga" aria-label="Reintentar carga"
              onClick={() => { setImageState('loading'); setRetry(retry + 1) }}>
              <RefreshCw size={16} />
            </button>
          ) : null}
        </div>
      )}
    </div>
  )
}
