import { useEffect, useRef, useState } from 'react'
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Clock3,
  Pause,
  Play,
  Radar,
  RefreshCw,
  Video,
} from 'lucide-react'

import {
  ApiError,
  type DetectionTelemetry,
  type FrameTelemetry,
  processMatch,
} from './services/api'
import './App.css'

interface YouTubePlayer {
  destroy(): void
  getCurrentTime(): number
  pauseVideo(): void
  playVideo(): void
  seekTo(seconds: number, allowSeekAhead: boolean): void
}

interface YouTubeApi {
  Player: new (
    element: HTMLElement,
    options: {
      videoId: string
      playerVars: { playsinline: number }
      events: {
        onReady: (event: { target: YouTubePlayer }) => void
        onStateChange: (event: { data: number }) => void
      }
    },
  ) => YouTubePlayer
}

declare global {
  interface Window {
    YT?: YouTubeApi
    onYouTubeIframeAPIReady?: () => void
  }
}

interface AnalysisResult {
  matchId: string
  status: 'completed'
  sourceUrl: string
  title?: string
  telemetry: FrameTelemetry[]
}

interface CourtVisualizationProps {
  frame?: FrameTelemetry
}

interface VideoPlayerProps {
  sourceUrl: string
  currentTime: number
  maxTime: number
  onTimeChange: (time: number) => void
}

const courtLength = 23.77
const courtWidth = 10.97
// Must match PLAYER_BASELINE_MARGIN_METERS in apps/vision-ai/src/tracker.py
const playerBaselineMarginMeters = 2
const viewUnitsPerMeter = 100
const viewMargin = playerBaselineMarginMeters * viewUnitsPerMeter
let youtubeApiPromise: Promise<YouTubeApi> | null = null

function formatPercent(value: number): string {
  return `${Math.round(value)}%`
}

function formatTime(value: number): string {
  const minutes = Math.floor(value / 60)
  const seconds = Math.floor(value % 60)
  const centiseconds = Math.floor((value % 1) * 100)
  return `${minutes}:${String(seconds).padStart(2, '0')}.${String(centiseconds).padStart(2, '0')}`
}

function formatDecimal(value: number): string {
  return value.toFixed(1)
}

function getYouTubeVideoId(sourceUrl: string): string | null {
  try {
    const url = new URL(sourceUrl)
    if (url.hostname === 'youtu.be') {
      return url.pathname.slice(1) || null
    }
    if (url.hostname.endsWith('youtube.com')) {
      return url.searchParams.get('v') ?? url.pathname.split('/').filter(Boolean).at(-1) ?? null
    }
  } catch {
    return null
  }
  return null
}

function loadYouTubeApi(): Promise<YouTubeApi> {
  if (window.YT?.Player) {
    return Promise.resolve(window.YT)
  }
  if (youtubeApiPromise) {
    return youtubeApiPromise
  }

  youtubeApiPromise = new Promise((resolve, reject) => {
    const previousReadyHandler = window.onYouTubeIframeAPIReady
    window.onYouTubeIframeAPIReady = () => {
      previousReadyHandler?.()
      if (window.YT?.Player) {
        resolve(window.YT)
      } else {
        reject(new Error('No se pudo inicializar el reproductor de YouTube.'))
      }
    }

    const script = document.createElement('script')
    script.src = 'https://www.youtube.com/iframe_api'
    script.onerror = () => reject(new Error('No se pudo cargar la API de YouTube.'))
    document.head.append(script)
  })
  return youtubeApiPromise
}

function VideoPlayer({ sourceUrl, currentTime, maxTime, onTimeChange }: VideoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const youTubeMountRef = useRef<HTMLDivElement>(null)
  const youTubePlayerRef = useRef<YouTubePlayer | null>(null)
  const [youTubeReady, setYouTubeReady] = useState(false)
  const [isPlaying, setIsPlaying] = useState(false)
  const [playerError, setPlayerError] = useState<string | null>(null)
  const youTubeVideoId = getYouTubeVideoId(sourceUrl)

  useEffect(() => {
    if (!youTubeVideoId) {
      return
    }

    let isActive = true
    let player: YouTubePlayer | null = null
    loadYouTubeApi()
      .then((youTubeApi) => {
        if (!isActive || !youTubeMountRef.current) {
          return
        }
        player = new youTubeApi.Player(youTubeMountRef.current, {
          videoId: youTubeVideoId,
          playerVars: { playsinline: 1 },
          events: {
            onReady: (event) => {
              if (!isActive) {
                return
              }
              youTubePlayerRef.current = event.target
              setYouTubeReady(true)
            },
            onStateChange: (event) => {
              if (isActive) {
                setIsPlaying(event.data === 1)
              }
            },
          },
        })
      })
      .catch((error: unknown) => {
        if (isActive) {
          setPlayerError(error instanceof Error ? error.message : 'No se pudo cargar el video.')
        }
      })

    return () => {
      isActive = false
      player?.destroy()
      youTubePlayerRef.current = null
      setYouTubeReady(false)
    }
  }, [youTubeVideoId])

  useEffect(() => {
    if (!youTubeReady || !youTubeVideoId) {
      return
    }
    const intervalId = window.setInterval(() => {
      const player = youTubePlayerRef.current
      if (player) {
        onTimeChange(player.getCurrentTime())
      }
    }, 200)
    return () => window.clearInterval(intervalId)
  }, [onTimeChange, youTubeReady, youTubeVideoId])

  function seekTo(time: number) {
    onTimeChange(time)
    if (youTubeVideoId) {
      youTubePlayerRef.current?.seekTo(time, true)
    } else if (videoRef.current) {
      videoRef.current.currentTime = time
    }
  }

  function togglePlayback() {
    if (youTubeVideoId) {
      const player = youTubePlayerRef.current
      if (isPlaying) {
        player?.pauseVideo()
      } else {
        player?.playVideo()
      }
      return
    }
    const video = videoRef.current
    if (!video) {
      return
    }
    if (video.paused) {
      void video.play()
    } else {
      video.pause()
    }
  }

  return (
    <div className="video-player">
      <div className="video-player__screen">
        {sourceUrl ? (
          youTubeVideoId ? (
            <div className="video-player__youtube" ref={youTubeMountRef} />
          ) : (
            <video
              ref={videoRef}
              src={sourceUrl}
              controls
              playsInline
              onPlay={() => setIsPlaying(true)}
              onPause={() => setIsPlaying(false)}
              onTimeUpdate={(event) => onTimeChange(event.currentTarget.currentTime)}
            />
          )
        ) : (
          <div className="video-player__empty">
            <Video className="h-8 w-8 text-lime-300" />
            <span>El reproductor se habilita al procesar un video</span>
          </div>
        )}
        {playerError ? <p className="video-player__error">{playerError}</p> : null}
      </div>
      <div className="video-player__controls">
        <button
          className="icon-button"
          type="button"
          title={isPlaying ? 'Pausar video' : 'Reproducir video'}
          aria-label={isPlaying ? 'Pausar video' : 'Reproducir video'}
          disabled={!sourceUrl || (youTubeVideoId !== null && !youTubeReady)}
          onClick={togglePlayback}
        >
          {isPlaying ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
        </button>
        <span className="video-player__time">{formatTime(currentTime)}</span>
        <input
          aria-label="Posición del video"
          type="range"
          min={0}
          max={maxTime || 0.04}
          step={0.04}
          value={Math.min(currentTime, maxTime || 0)}
          disabled={!sourceUrl || maxTime === 0}
          onChange={(event) => seekTo(Number(event.target.value))}
        />
        <span className="video-player__time">{formatTime(maxTime)}</span>
      </div>
    </div>
  )
}

function CourtVisualization({ frame }: CourtVisualizationProps) {
  const positionedDetections = frame?.detections.filter(
    (detection) => detection.x_meters !== null && detection.y_meters !== null,
  ) ?? []

  return (
    <svg
      viewBox={`-${viewMargin} 0 ${2377 + viewMargin * 2} 1097`}
      className="h-full w-full"
      role="img"
      aria-label={`Posiciones del frame ${frame?.frame_index ?? 0} sobre una pista de tenis`}
    >
      <rect x="8" y="8" width="2361" height="1081" rx="36" className="court-frame" />
      <rect x="32" y="32" width="2313" height="1033" rx="20" className="court-surface" />
      <line x1="1188.5" y1="32" x2="1188.5" y2="1065" className="court-line court-line--net" />
      <line x1="32" y1="32" x2="2345" y2="32" className="court-line" />
      <line x1="32" y1="1065" x2="2345" y2="1065" className="court-line" />
      <line x1="32" y1="169" x2="2345" y2="169" className="court-line court-line--soft" />
      <line x1="32" y1="928" x2="2345" y2="928" className="court-line court-line--soft" />
      <line x1="672" y1="169" x2="672" y2="928" className="court-line court-line--soft" />
      <line x1="1705" y1="169" x2="1705" y2="928" className="court-line court-line--soft" />
      <line x1="672" y1="548.5" x2="1705" y2="548.5" className="court-line court-line--soft" />

      {positionedDetections.map((detection, index) => {
        const pointX = ((detection.x_meters ?? 0) / courtLength) * 2377
        const pointY = ((detection.y_meters ?? 0) / courtWidth) * 1097
        const className = detection.class === 'player' ? 'player' : 'ball'
        const markerLabel = className === 'player'
          ? `P${positionedDetections.slice(0, index + 1).filter((item) => item.class === 'player').length}`
          : 'B'

        return (
          <g key={`${frame?.frame_index}-${detection.class}-${index}`}>
            <circle cx={pointX} cy={pointY} r={className === 'player' ? 28 : 19} className={`court-marker court-marker--${className}`} />
            <text x={pointX} y={pointY + 7} textAnchor="middle" className="court-marker-label">
              {markerLabel}
            </text>
          </g>
        )
      })}
    </svg>
  )
}

function DetectionRow({ detection }: { detection: DetectionTelemetry }) {
  const hasPosition = detection.x_meters !== null && detection.y_meters !== null

  return (
    <article className="detection-row">
      <div className="detection-row__identity">
        <span className={`detection-dot detection-dot--${detection.class}`} />
        <span>{detection.class === 'player' ? 'Jugador' : 'Pelota'}</span>
      </div>
      <span className="detection-row__confidence">{formatPercent(detection.confidence * 100)}</span>
      <span className="detection-row__position">
        {hasPosition && detection.x_meters !== null && detection.y_meters !== null
          ? `${formatDecimal(detection.x_meters)} m · ${formatDecimal(detection.y_meters)} m`
          : 'Sin calibración'}
      </span>
    </article>
  )
}

function App() {
  const [sourceUrl, setSourceUrl] = useState('')
  const [title, setTitle] = useState('')
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const requestSequenceRef = useRef(0)

  const frames = analysis?.telemetry ?? []
  const maxTime = frames.at(-1)?.timestamp_seconds ?? 0
  const currentFrame = frames.reduce<FrameTelemetry | undefined>(
    (selectedFrame, frame) =>
      frame.timestamp_seconds <= currentTime ? frame : selectedFrame,
    undefined,
  )
  const currentDetections = currentFrame?.detections ?? []
  const playerCount = currentDetections.filter((detection) => detection.class === 'player').length
  const ballCount = currentDetections.filter((detection) => detection.class === 'ball').length

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()

    if (isSubmitting) {
      return
    }

    const trimmedSourceUrl = sourceUrl.trim()
    const trimmedTitle = title.trim()
    const requestSequence = requestSequenceRef.current + 1

    requestSequenceRef.current = requestSequence
    setIsSubmitting(true)
    setErrorMessage(null)
    setAnalysis(null)
    setCurrentTime(0)

    try {
      const processResponse = await processMatch({
        sourceUrl: trimmedSourceUrl,
        title: trimmedTitle || undefined,
      })

      if (requestSequence !== requestSequenceRef.current) {
        return
      }

      setAnalysis({
        matchId: processResponse.matchId,
        status: processResponse.status,
        sourceUrl: trimmedSourceUrl,
        title: trimmedTitle || undefined,
        telemetry: processResponse.telemetry,
      })
      setCurrentTime(processResponse.telemetry[0]?.timestamp_seconds ?? 0)
    } catch (error) {
      if (requestSequence !== requestSequenceRef.current) {
        return
      }

      if (error instanceof ApiError) {
        setErrorMessage(error.message)
      } else {
        setErrorMessage('Ocurrió un error inesperado durante el análisis.')
      }
    } finally {
      if (requestSequence === requestSequenceRef.current) {
        setIsSubmitting(false)
      }
    }
  }

  return (
    <main className="app-shell min-h-screen bg-(--color-bg) text-(--color-foreground)">
      <div className="mx-auto flex min-h-screen max-w-7xl flex-col gap-6 px-4 py-5 sm:px-6 lg:px-8">
        <header className="panel-surface grid gap-4 rounded-[28px] border border-white/10 px-5 py-5 shadow-2xl shadow-black/30 sm:px-8 sm:py-7 lg:grid-cols-[1.4fr_0.9fr]">
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-3 text-[0.72rem] font-semibold uppercase tracking-[0.28em] text-lime-300/85">
              <span className="rounded-full border border-lime-400/30 bg-lime-400/10 px-3 py-1">NetPoint AI</span>
              <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-white/60">
                Tracking por fotograma
              </span>
            </div>

            <div className="space-y-3">
              <h1 className="max-w-3xl text-3xl font-semibold tracking-[-0.04em] text-white sm:text-4xl lg:text-[3.1rem]">
                Panel operativo para procesar partidos y revisar posiciones en pista.
              </h1>
              <p className="max-w-2xl text-sm leading-6 text-white/70 sm:text-base">
                Reproduce el video y sigue la posición de jugadores y pelota en coordenadas métricas.
              </p>
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-1">
            <article className="rounded-3xl border border-white/8 bg-black/20 p-4">
              <div className="flex items-center gap-2 text-xs uppercase tracking-[0.22em] text-white/45">
                <Activity className="h-4 w-4 text-lime-300" />
                Estado
              </div>
              <p className="mt-3 text-2xl font-semibold text-white">
                {analysis ? 'Procesado' : isSubmitting ? 'Ejecutando' : 'En espera'}
              </p>
            </article>
            <article className="rounded-3xl border border-white/8 bg-black/20 p-4">
              <div className="flex items-center gap-2 text-xs uppercase tracking-[0.22em] text-white/45">
                <Radar className="h-4 w-4 text-lime-300" />
                Fotogramas
              </div>
              <p className="mt-3 text-2xl font-semibold text-white">
                {analysis ? frames.length : '00'}
              </p>
            </article>
            <article className="rounded-3xl border border-white/8 bg-black/20 p-4">
              <div className="flex items-center gap-2 text-xs uppercase tracking-[0.22em] text-white/45">
                <Activity className="h-4 w-4 text-lime-300" />
                Detecciones actuales
              </div>
              <p className="mt-3 text-2xl font-semibold text-white">
                {analysis ? currentDetections.length : '--'}
              </p>
            </article>
          </div>
        </header>

        <section className="grid gap-6 lg:grid-cols-[0.95fr_1.05fr]">
          <section className="panel-surface rounded-[28px] border border-white/10 p-5 shadow-xl shadow-black/25 sm:p-6">
            <div className="mb-5 flex items-center justify-between gap-3">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.24em] text-white/45">
                  Ingesta
                </p>
                <h2 className="mt-2 text-xl font-semibold text-white">Analizar Partido</h2>
              </div>
              <div className="rounded-full border border-lime-400/25 bg-lime-400/10 px-3 py-1 text-xs font-medium text-lime-200">
                Entorno local
              </div>
            </div>

            <form className="space-y-4" onSubmit={handleSubmit} noValidate>
              <label className="block">
                <span className="mb-2 block text-sm font-medium text-white/78">URL del video</span>
                <input
                  type="url"
                  required
                  value={sourceUrl}
                  onChange={(event) => setSourceUrl(event.target.value)}
                  placeholder="https://..."
                  className="w-full rounded-2xl border border-white/10 bg-black/25 px-4 py-3 text-sm text-white outline-none transition focus:border-lime-400/60 focus:ring-2 focus:ring-lime-400/20"
                />
              </label>

              <label className="block">
                <span className="mb-2 block text-sm font-medium text-white/78">Título operativo</span>
                <input
                  type="text"
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  placeholder="Final ATP - Set 1"
                  className="w-full rounded-2xl border border-white/10 bg-black/25 px-4 py-3 text-sm text-white outline-none transition focus:border-lime-400/60 focus:ring-2 focus:ring-lime-400/20"
                />
              </label>

              <button
                type="submit"
                disabled={isSubmitting || sourceUrl.trim().length === 0}
                className="inline-flex w-full items-center justify-center gap-2 rounded-2xl bg-lime-300 px-4 py-3 text-sm font-semibold text-zinc-950 transition hover:bg-lime-200 disabled:cursor-not-allowed disabled:bg-lime-100/50"
              >
                {isSubmitting ? (
                  <>
                    <RefreshCw className="h-4 w-4 animate-spin" />
                    Analizando...
                  </>
                ) : (
                  <>
                    <Video className="h-4 w-4" />
                    Analizar Partido
                  </>
                )}
              </button>
            </form>

            <div className="mt-5 rounded-3xl border border-dashed border-white/10 bg-black/20 p-4 text-sm text-white/60">
              El servicio procesa el video y devuelve detecciones sincronizadas por fotograma.
            </div>

            {errorMessage ? (
              <div
                className="mt-5 flex items-start gap-3 rounded-3xl border border-rose-400/25 bg-rose-500/10 p-4 text-sm text-rose-100"
                role="alert"
              >
                <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-rose-300" />
                <div>
                  <p className="font-semibold">No se pudo completar el análisis</p>
                  <p className="mt-1 text-rose-100/85">{errorMessage}</p>
                </div>
              </div>
            ) : null}

            {analysis ? (
              <div className="mt-5 rounded-3xl border border-lime-400/20 bg-lime-400/8 p-4 text-sm text-lime-100">
                <div className="flex items-start gap-3">
                  <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-lime-300" />
                  <div>
                    <p className="font-semibold">Procesamiento completado</p>
                    <p className="mt-1 break-all text-lime-100/80">Match ID: {analysis.matchId}</p>
                    <p className="mt-1 text-lime-100/75">Estado: {analysis.status}</p>
                  </div>
                </div>
              </div>
            ) : null}
          </section>

          <section className="grid gap-6">
            <section className="panel-surface rounded-[28px] border border-white/10 p-5 shadow-xl shadow-black/25 sm:p-6">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.24em] text-white/45">
                    Resumen
                  </p>
                  <h2 className="mt-2 text-xl font-semibold text-white">Métricas del partido</h2>
                </div>
                <div className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-white/55">
                  Frame {currentFrame?.frame_index ?? '--'}
                </div>
              </div>

              <div className="mt-5 grid gap-3 sm:grid-cols-3">
                <article className="rounded-3xl border border-white/8 bg-black/25 p-4">
                  <p className="text-xs uppercase tracking-[0.22em] text-white/45">Fotogramas</p>
                  <p className="mt-3 text-3xl font-semibold text-white">{analysis ? frames.length : '--'}</p>
                </article>
                <article className="rounded-3xl border border-white/8 bg-black/25 p-4">
                  <p className="text-xs uppercase tracking-[0.22em] text-white/45">Jugadores en frame</p>
                  <p className="mt-3 text-3xl font-semibold text-white">
                    {analysis ? playerCount : '--'}
                  </p>
                </article>
                <article className="rounded-3xl border border-white/8 bg-black/25 p-4">
                  <p className="text-xs uppercase tracking-[0.22em] text-white/45">Pelotas en frame</p>
                  <p className="mt-3 text-3xl font-semibold text-white">
                    {analysis ? ballCount : '--'}
                  </p>
                </article>
              </div>

              {!analysis && !isSubmitting && !errorMessage ? (
                <div className="mt-5 rounded-3xl border border-dashed border-white/10 bg-white/4 p-5 text-sm text-white/55">
                  Carga una URL y ejecuta el análisis para explorar sus detecciones por fotograma.
                </div>
              ) : null}

              {isSubmitting ? (
                <div className="mt-5 flex items-center gap-3 rounded-3xl border border-white/10 bg-black/20 p-5 text-sm text-white/70">
                  <RefreshCw className="h-5 w-5 animate-spin text-lime-300" />
                  Procesando video y generando frames...
                </div>
              ) : null}
            </section>

            <section className="grid gap-6 xl:grid-cols-[1.1fr_0.9fr]">
              <section className="panel-surface overflow-hidden rounded-[28px] border border-white/10 p-5 shadow-xl shadow-black/25 sm:p-6">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-[0.24em] text-white/45">
                      Coordenadas métricas
                    </p>
                    <h2 className="mt-2 text-xl font-semibold text-white">Posiciones en pista</h2>
                  </div>
                  <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-white/55">
                    {currentFrame ? `${formatTime(currentFrame.timestamp_seconds)} · frame ${currentFrame.frame_index}` : 'Sin frame'}
                  </span>
                </div>

                <div className="mt-5 aspect-video rounded-[26px] border border-white/8 bg-[linear-gradient(180deg,rgba(34,197,94,0.08),rgba(0,0,0,0))] p-3">
                  {analysis ? (
                    <CourtVisualization frame={currentFrame} />
                  ) : (
                    <div className="court-placeholder flex h-full items-center justify-center rounded-[22px] border border-dashed border-white/10 text-center text-sm text-white/45">
                      La pista y las detecciones aparecerán al procesar un video.
                    </div>
                  )}
                </div>
              </section>

              <section className="panel-surface rounded-[28px] border border-white/10 p-5 shadow-xl shadow-black/25 sm:p-6">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-[0.24em] text-white/45">
                      Frame activo
                    </p>
                    <h2 className="mt-2 text-xl font-semibold text-white">Detecciones</h2>
                  </div>
                  {analysis ? (
                    <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-white/55">
                      {currentFrame ? formatTime(currentFrame.timestamp_seconds) : 'Sin frame'}
                    </span>
                  ) : null}
                </div>

                <div className="mt-5 grid gap-2">
                  {currentDetections.length ? (
                    currentDetections.map((detection, index) => (
                      <DetectionRow key={`${currentFrame?.frame_index}-${detection.class}-${index}`} detection={detection} />
                    ))
                  ) : (
                    <div className="rounded-3xl border border-dashed border-white/10 bg-white/4 p-5 text-sm text-white/55">
                      {currentFrame ? 'No hay detecciones en este fotograma.' : 'Las detecciones aparecerán al procesar un video.'}
                    </div>
                  )}
                </div>
              </section>
            </section>

            <section className="panel-surface rounded-[28px] border border-white/10 p-5 shadow-xl shadow-black/25 sm:p-6">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.24em] text-white/45">
                    Reproducción sincronizada
                  </p>
                  <h2 className="mt-2 text-xl font-semibold text-white">Video del partido</h2>
                </div>
                <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-white/55">
                  {analysis?.title ?? 'Esperando análisis'}
                </span>
              </div>

              <div className="mt-5 grid gap-5 xl:grid-cols-[1.45fr_0.55fr]">
                <VideoPlayer
                  sourceUrl={analysis?.sourceUrl ?? ''}
                  currentTime={currentTime}
                  maxTime={maxTime}
                  onTimeChange={setCurrentTime}
                />

                <div className="grid content-start gap-3">
                  <div className="playback-stat">
                    <Clock3 className="h-4 w-4 text-lime-300" />
                    <div>
                      <p className="playback-stat__label">Timestamp activo</p>
                      <p className="playback-stat__value">{formatTime(currentTime)}</p>
                    </div>
                  </div>
                  <div className="playback-stat">
                    <Radar className="h-4 w-4 text-lime-300" />
                    <div>
                      <p className="playback-stat__label">Frame seleccionado</p>
                      <p className="playback-stat__value">{currentFrame?.frame_index ?? '--'}</p>
                    </div>
                  </div>
                  <div className="playback-stat">
                    <Activity className="h-4 w-4 text-lime-300" />
                    <div>
                      <p className="playback-stat__label">Detecciones en el frame</p>
                      <p className="playback-stat__value">{currentDetections.length}</p>
                    </div>
                  </div>
                  <p className="break-all px-1 text-xs text-white/40">Match ID: {analysis?.matchId ?? '--'}</p>
                </div>
              </div>
            </section>
          </section>
        </section>
      </div>
    </main>
  )
}

export default App
