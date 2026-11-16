import { useState } from 'react'
import { Video } from 'lucide-react'

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
        <h3>Fotograma actual</h3>
        <span>
          {frame ? (
            <>N.º <span className="mono">{frame.frame_index}</span>, <span className="mono">{formatTime(frame.timestamp_seconds)}</span></>
          ) : 'Sin fotograma'}
        </span>
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
          <Video size={22} strokeWidth={1.5} aria-hidden="true" />
          <span>
            {!analysis
              ? 'Sin vídeo analizado.'
              : isPlaying
                ? 'Pausa el vídeo para inspeccionar el fotograma.'
                : !frame
                  ? 'No hay fotograma analizado en esta posición.'
                  : 'Este análisis no incluye imágenes. Vuelve a analizar el vídeo.'}
          </span>
        </div>
      )}
      {analysis && frame && !isPlaying && frame.detections.some((detection) => detection.carried_forward || detection.interpolated) ? (
        <p className="frame-inspector__status">Las posiciones previas o estimadas van en línea discontinua.</p>
      ) : null}
    </section>
  )
}
