import { useEffect, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, Maximize2, Minimize2, Video } from 'lucide-react'

import { useFullscreen } from '../../hooks/useFullscreen'
import type { AnalysisResult } from '../../hooks/useMatchAnalysis'
import { formatTime } from '../../lib/format.ts'
import { frameStepTime } from '../../lib/frameLookup.ts'
import type { FrameTelemetry } from '../../services/api'
import type { PlayerNames } from '../ingest/PlayerNamesDialog'
import { AnnotatedFrame, type InspectionLayer } from './AnnotatedFrame'

interface FrameInspectorProps {
  analysis: AnalysisResult | null
  frame?: FrameTelemetry
  isPlaying: boolean
  /** Moves the video, and with it every panel, to a time; used to step frame by frame. */
  onSeek?: (seconds: number) => void
  playerNames?: PlayerNames
}

/** Shows the raw detections of the current frame whenever the video is paused. */
export function FrameInspector({ analysis, frame, isPlaying, onSeek, playerNames }: FrameInspectorProps) {
  const [layers, setLayers] = useState<Record<InspectionLayer, boolean>>({ court: true, player: true, ball: true })
  const video = analysis?.telemetry.video
  const hasImageSize = Boolean(video?.width && video?.height)
  const playerCount = frame?.detections.filter((detection) => detection.class === 'player').length ?? 0
  const ballCount = frame?.detections.filter((detection) => detection.class === 'ball').length ?? 0
  // The layers and the image go full screen together, so the layers can still be toggled there.
  const viewerRef = useRef<HTMLDivElement>(null)
  const { enlarged, expanded, toggle } = useFullscreen(viewerRef)
  const showsFrame = Boolean(analysis && video && frame && hasImageSize && !isPlaying)

  // Stepping moves the video itself, so the court map, the 3D view and the stats follow along.
  const frames = analysis?.telemetry.frames
  const stepTime = (step: number) => (frames && frame && onSeek ? frameStepTime(frames, frame.frame_index, step) : null)
  const previousTime = stepTime(-1)
  const nextTime = stepTime(1)
  const canStep = enlarged && showsFrame && Boolean(onSeek)
  const stepRef = useRef({ previousTime, nextTime, canStep, onSeek })
  useEffect(() => {
    stepRef.current = { previousTime, nextTime, canStep, onSeek }
  })

  useEffect(() => {
    if (!enlarged) return
    const onKey = (event: KeyboardEvent) => {
      const { previousTime: previous, nextTime: next, canStep: active, onSeek: seek } = stepRef.current
      if (!active || !seek || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) return
      const target = event.key === 'ArrowLeft' ? previous : next
      if (target === null) return
      event.preventDefault()
      seek(target)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [enlarged])

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
      <div
        ref={viewerRef}
        className={`frame-inspector__viewer${expanded ? ' is-expanded' : ''}`}
        style={video?.width && video?.height ? { '--frame-ratio': video.width / video.height } as React.CSSProperties : undefined}
      >
      <div className="frame-inspector__toolbar">
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
      {enlarged && frame ? (
        <span className="frame-inspector__position">
          N.º <span className="mono">{frame.frame_index}</span> · <span className="mono">{formatTime(frame.timestamp_seconds)}</span>
        </span>
      ) : null}
      {showsFrame || enlarged ? (
        <button
          type="button"
          className="icon-button frame-inspector__size"
          onClick={() => void toggle()}
          aria-label={enlarged ? 'Salir de pantalla completa' : 'Ver el fotograma a pantalla completa'}
          title={enlarged ? 'Salir de pantalla completa (Esc)' : 'Pantalla completa'}
        >
          {enlarged ? <Minimize2 size={15} aria-hidden="true" /> : <Maximize2 size={15} aria-hidden="true" />}
        </button>
      ) : null}
      </div>
      {canStep ? (
        <>
          <button
            type="button"
            className="frame-inspector__step frame-inspector__step--previous"
            onClick={() => previousTime !== null && onSeek?.(previousTime)}
            disabled={previousTime === null}
            aria-label="Fotograma anterior"
            title="Fotograma anterior (←)"
          >
            <ChevronLeft size={28} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="frame-inspector__step frame-inspector__step--next"
            onClick={() => nextTime !== null && onSeek?.(nextTime)}
            disabled={nextTime === null}
            aria-label="Fotograma siguiente"
            title="Fotograma siguiente (→)"
          >
            <ChevronRight size={28} aria-hidden="true" />
          </button>
        </>
      ) : null}
      {showsFrame && analysis && video && frame ? (
        <AnnotatedFrame
          key={`${analysis.matchId}-${frame.frame_index}`}
          matchId={analysis.matchId}
          frame={frame}
          imageWidth={video.width}
          imageHeight={video.height}
          layers={layers}
          playerNames={playerNames}
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
      </div>
      {analysis && frame && !isPlaying && frame.detections.some((detection) => detection.carried_forward || detection.interpolated) ? (
        <p className="frame-inspector__status">Las posiciones previas o estimadas van en línea discontinua.</p>
      ) : null}
    </section>
  )
}
