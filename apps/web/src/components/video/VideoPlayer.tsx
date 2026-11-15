import { useRef, useState } from 'react'
import { Video } from 'lucide-react'

import type { MatchTelemetry } from '../../services/api'
import { MatchCanvasOverlay } from './MatchCanvasOverlay'

interface VideoPlayerProps {
  /** URL of the analysed video; empty while there is no analysis. */
  sourceUrl: string
  telemetry: MatchTelemetry | null
  onTimeChange: (time: number) => void
  onPlaybackChange: (playing: boolean) => void
}

export function VideoPlayer({ sourceUrl, telemetry, onTimeChange, onPlaybackChange }: VideoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [failedUrl, setFailedUrl] = useState<string | null>(null)

  return (
    <div className="video-player">
      <div className="video-player__screen">
        {sourceUrl ? (
          <>
            <video
              ref={videoRef}
              src={sourceUrl}
              controls
              playsInline
              onPlay={() => onPlaybackChange(true)}
              onPause={(event) => {
                onTimeChange(event.currentTarget.currentTime)
                onPlaybackChange(false)
              }}
              onEnded={() => onPlaybackChange(false)}
              onSeeked={(event) => onTimeChange(event.currentTarget.currentTime)}
              onTimeUpdate={(event) => onTimeChange(event.currentTarget.currentTime)}
              onError={() => setFailedUrl(sourceUrl)}
            />
            {telemetry ? <MatchCanvasOverlay videoRef={videoRef} telemetry={telemetry} /> : null}
          </>
        ) : (
          <div className="video-player__empty">
            <Video className="h-8 w-8 text-lime-300" />
            <span>El reproductor se habilita al procesar un video</span>
          </div>
        )}
        {sourceUrl && failedUrl === sourceUrl ? (
          <p className="video-player__error">
            No se pudo reproducir el video. Comprueba que el servicio de visión sigue activo y que el formato es compatible con el navegador.
          </p>
        ) : null}
      </div>
    </div>
  )
}
