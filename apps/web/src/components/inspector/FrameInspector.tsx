import { useState } from 'react'
import { Radar, Video } from 'lucide-react'

import type { AnalysisResult } from '../../hooks/useMatchAnalysis'
import { formatTime } from '../../lib/format.ts'
import type { FrameTelemetry } from '../../services/api'
import { AnnotatedFrame, type InspectionLayer } from './AnnotatedFrame'

interface FrameInspectorProps {
  analysis: AnalysisResult | null
  frame?: FrameTelemetry
  isPlaying: boolean
}

/** Shows the raw detections of the current frame whenever the video is paused. */
export function FrameInspector({ analysis, frame, isPlaying }: FrameInspectorProps) {
  const [layers, setLayers] = useState<Record<InspectionLayer, boolean>>({ court: true, player: true, ball: true })
  const video = analysis?.telemetry.video
  const hasImageSize = Boolean(video?.width && video?.height)
  const playerCount = frame?.detections.filter((detection) => detection.class === 'player').length ?? 0
  const ballCount = frame?.detections.filter((detection) => detection.class === 'ball').length ?? 0

  return (
    <section className="frame-inspector" aria-label="Inspección del fotograma">
      <div className="frame-inspector__heading">
        <h3><Radar size={18} /> Fotograma actual</h3>
        <span>{frame ? `#${frame.frame_index} · ${formatTime(frame.timestamp_seconds)}` : 'Sin fotograma'}</span>
      </div>
      <div className="frame-inspector__layers" role="group" aria-label="Capas de detección">
        {([
          ['court', 'Pista'], ['player', `Jugadores (${playerCount})`], ['ball', `Pelota (${ballCount})`],
        ] as const).map(([layer, label]) => (
          <label key={layer} className={`frame-inspector__layer frame-inspector__layer--${layer}`}>
            <input type="checkbox" checked={layers[layer]} onChange={(event) => setLayers({ ...layers, [layer]: event.target.checked })} />
            {label}
          </label>
        ))}
      </div>
      {analysis && video && frame && hasImageSize && !isPlaying ? (
        <AnnotatedFrame
          key={`${analysis.matchId}-${frame.frame_index}`}
          matchId={analysis.matchId}
          frame={frame}
          imageWidth={video.width}
          imageHeight={video.height}
          layers={layers}
        />
      ) : (
        <div className="frame-inspector__empty" role="status">
          <Video size={24} />
          <span>{!analysis ? 'Sin video analizado' : isPlaying ? 'Video en reproducción' : !frame ? 'Sin fotograma analizado en esta posición' : 'Este análisis no incluye imágenes. Vuelve a analizar el video.'}</span>
        </div>
      )}
      {analysis && frame && !isPlaying ? (
        <div className="frame-inspector__status">
          {frame.detections.some((detection) => detection.carried_forward || detection.interpolated) ? <span>Posiciones previas o estimadas en línea discontinua</span> : null}
        </div>
      ) : null}
    </section>
  )
}
