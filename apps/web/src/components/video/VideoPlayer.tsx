import { type Ref, useImperativeHandle, useRef, useState } from 'react'
import { Video } from 'lucide-react'

import { formatTime } from '../../lib/format.ts'
import type { MatchTelemetry } from '../../services/api'
import { MatchCanvasOverlay } from './MatchCanvasOverlay'

/** Lets other panels move the video to an exact moment, or read it more often than `timeupdate` fires. */
export interface VideoPlayerHandle {
  seekTo: (seconds: number) => void
  /** Current playback time, or null while there is no video. */
  getTime: () => number | null
}

interface VideoPlayerProps {
  ref?: Ref<VideoPlayerHandle>
  /** URL of the analysed video; empty while there is no analysis. */
  sourceUrl: string
  telemetry: MatchTelemetry | null
  onTimeChange: (time: number) => void
  onPlaybackChange: (playing: boolean) => void
  /** Shown in the empty state to open the source menu. */
  onRequestSource?: () => void
}

export function VideoPlayer({ ref, sourceUrl, telemetry, onTimeChange, onPlaybackChange, onRequestSource }: VideoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [failedUrl, setFailedUrl] = useState<string | null>(null)
  // Brief on-screen cue after a programmatic jump, so the user sees where the video landed.
  const [jump, setJump] = useState<{ seconds: number; key: number } | null>(null)

  useImperativeHandle(ref, () => ({
    seekTo(seconds: number) {
      const video = videoRef.current
      if (!video) return
      const target = Math.max(0, Number.isFinite(video.duration) ? Math.min(seconds, video.duration) : seconds)
      video.currentTime = target
      onTimeChange(target)
      setJump({ seconds: target, key: Date.now() })
    },
    getTime() {
      return videoRef.current?.currentTime ?? null
    },
  }), [onTimeChange])

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
            {jump ? (
              <span key={jump.key} className="video-player__jump" aria-live="polite" onAnimationEnd={() => setJump(null)}>
                {formatTime(jump.seconds)}
              </span>
            ) : null}
          </>
        ) : (
          <div className="video-player__empty">
            <Video size={28} strokeWidth={1.4} aria-hidden="true" />
            <span>Aquí verás el partido con la trayectoria, los botes y los golpes encima.</span>
            {onRequestSource ? (
              <button type="button" className="video-player__cta" onClick={onRequestSource}>
                Cargar un vídeo
              </button>
            ) : null}
          </div>
        )}
        {sourceUrl && failedUrl === sourceUrl ? (
          <p className="video-player__error">
            No se pudo reproducir el vídeo. Comprueba que el servicio de visión sigue activo y que el navegador admite el formato.
          </p>
        ) : null}
      </div>
    </div>
  )
}
