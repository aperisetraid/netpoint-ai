import { useEffect, useRef, useState } from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  Moon,
  Radar,
  RefreshCw,
  Link2,
  Sun,
  Upload,
  Video,
} from 'lucide-react'

import {
  ApiError,
  type FrameTelemetry,
  type MatchProgressResponse,
  getMatchProgress,
  getMatchFrameUrl,
  processMatch,
  uploadMatchVideo,
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
  onTimeChange: (time: number) => void
  onPlaybackChange: (playing: boolean) => void
}

const courtLength = 23.77
const courtWidth = 10.97
const maximumVideoSizeBytes = 1024 * 1024 * 1024
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

function VideoPlayer({ sourceUrl, onTimeChange, onPlaybackChange }: VideoPlayerProps) {
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
                onPlaybackChange(event.data === 1)
                const activePlayer = youTubePlayerRef.current
                if (activePlayer) {
                  onTimeChange(activePlayer.getCurrentTime())
                }
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
  }, [youTubeVideoId, onPlaybackChange, onTimeChange])

  useEffect(() => {
    if (!youTubeReady || !youTubeVideoId || !isPlaying) {
      return
    }
    const intervalId = window.setInterval(() => {
      const player = youTubePlayerRef.current
      if (player) {
        onTimeChange(player.getCurrentTime())
      }
    }, 200)
    return () => window.clearInterval(intervalId)
  }, [onTimeChange, youTubeReady, youTubeVideoId, isPlaying])

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
              onPlay={() => {
                setIsPlaying(true)
                onPlaybackChange(true)
              }}
              onPause={(event) => {
                setIsPlaying(false)
                onTimeChange(event.currentTarget.currentTime)
                onPlaybackChange(false)
              }}
              onEnded={() => {
                setIsPlaying(false)
                onPlaybackChange(false)
              }}
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
      {/* <div className="video-player__controls">
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
      </div> */}
    </div>
  )
}

type InspectionLayer = 'court' | 'player' | 'ball'

function AnnotatedFrame({ matchId, frame, layers }: {
  matchId: string
  frame: FrameTelemetry
  layers: Record<InspectionLayer, boolean>
}) {
  const [imageState, setImageState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [retry, setRetry] = useState(0)
  const width = frame.image_width ?? 1
  const height = frame.image_height ?? 1
  const labelSize = width / 45
  const imageUrl = `${getMatchFrameUrl(matchId, frame.frame_index)}?retry=${retry}`

  return (
    <div className="frame-inspector__image" style={{ aspectRatio: `${width} / ${height}` }}>
      <img
        key={imageUrl}
        src={imageUrl}
        alt={`Fotograma ${frame.frame_index} del video analizado`}
        onLoad={() => setImageState('ready')}
        onError={() => setImageState('error')}
        style={{ visibility: imageState === 'ready' ? 'visible' : 'hidden' }}
      />
      {imageState === 'ready' ? (
        <svg viewBox={`0 0 ${width} ${height}`} aria-label="Detecciones y calibración del fotograma" role="img">
          {layers.court && frame.court_corners?.length === 4 ? (
            <g className="frame-overlay__court">
              <polygon points={frame.court_corners.map((point) => point.join(',')).join(' ')} />
              {frame.court_corners.map(([pointX, pointY], index) => (
                <circle key={index} cx={pointX} cy={pointY} r={width / 180} />
              ))}
            </g>
          ) : null}
          {frame.detections.filter((detection) => layers[detection.class]).map((detection, index) => {
            const [left, top, right, bottom] = detection.bbox
            const label = `${detection.class === 'player' ? 'Jugador' : 'Pelota'} ${formatPercent(detection.confidence * 100)}${detection.carried_forward ? ' (previo)' : ''}`
            const labelY = Math.max(labelSize * 1.3, top)
            const labelWidth = label.length * labelSize * 0.6
            const labelX = Math.max(0, Math.min(left, width - labelWidth))
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

function FrameInspector({ analysis, frame, isPlaying }: {
  analysis: AnalysisResult | null
  frame?: FrameTelemetry
  isPlaying: boolean
}) {
  const [layers, setLayers] = useState<Record<InspectionLayer, boolean>>({ court: true, player: true, ball: true })
  const hasImageMetadata = Boolean(frame?.image_width && frame?.image_height)
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
      {analysis && frame && hasImageMetadata && !isPlaying ? (
        <AnnotatedFrame key={`${analysis.matchId}-${frame.frame_index}`} matchId={analysis.matchId} frame={frame} layers={layers} />
      ) : (
        <div className="frame-inspector__empty" role="status">
          <Video size={24} />
          <span>{!analysis ? 'Sin video analizado' : isPlaying ? 'Video en reproducción' : !frame ? 'Sin fotograma analizado en esta posición' : 'Este análisis no incluye imágenes. Vuelve a analizar el video.'}</span>
        </div>
      )}
      {analysis && frame && !isPlaying ? (
        <div className="frame-inspector__status">
          <span>{frame.court_corners?.length === 4 ? 'Pista calibrada' : 'Pista sin calibrar'}</span>
          <span>{frame.detections.length ? `${frame.detections.length} detecciones` : 'Sin detecciones'}</span>
          {frame.detections.some((detection) => detection.carried_forward) ? <span>Posiciones previas en línea discontinua</span> : null}
        </div>
      ) : null}
    </section>
  )
}

function CourtVisualization({ frame }: CourtVisualizationProps) {
  const positionedDetections = frame?.detections.filter(
    (detection) => detection.x_meters !== null && detection.y_meters !== null,
  ) ?? []
  const pointXs = positionedDetections.map(
    (detection) => ((detection.y_meters ?? 0) / courtWidth) * 1097,
  )
  const viewLeft = Math.min(0, ...pointXs.map((pointX) => pointX - 80))
  const viewRight = Math.max(1097, ...pointXs.map((pointX) => pointX + 80))
  const pointYs = positionedDetections.map(
    (detection) => ((detection.x_meters ?? 0) / courtLength) * 2377,
  )
  const viewTop = Math.min(-50, ...pointYs.map((pointY) => pointY - 80))
  const viewBottom = Math.max(2427, ...pointYs.map((pointY) => pointY + 80))

  return (
    <svg
      viewBox={`${viewLeft} ${viewTop} ${viewRight - viewLeft} ${viewBottom - viewTop}`}
      className="court-map__svg"
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label={`Mapa vertical de la pista y posiciones del frame ${frame?.frame_index ?? 0}`}
    >
      <rect x="8" y="8" width="1081" height="2361" rx="26" className="court-frame" />
      <rect x="32" y="32" width="1033" height="2313" rx="14" className="court-surface" />
      <line x1="32" y1="1188.5" x2="1065" y2="1188.5" className="court-line court-line--net" />
      <line x1="32" y1="32" x2="1065" y2="32" className="court-line" />
      <line x1="32" y1="2345" x2="1065" y2="2345" className="court-line" />
      <line x1="32" y1="655" x2="1065" y2="655" className="court-line court-line--soft" />
      <line x1="32" y1="1722" x2="1065" y2="1722" className="court-line court-line--soft" />
      <line x1="161" y1="32" x2="161" y2="2345" className="court-line court-line--soft" />
      <line x1="936" y1="32" x2="936" y2="2345" className="court-line court-line--soft" />
      <line x1="161" y1="655" x2="936" y2="655" className="court-line court-line--soft" />
      <line x1="161" y1="1722" x2="936" y2="1722" className="court-line court-line--soft" />
      <line x1="548.5" y1="655" x2="548.5" y2="1722" className="court-line court-line--soft" />
      <text x="548.5" y="-6" textAnchor="middle" className="court-orientation-label">FONDO</text>
      <text x="548.5" y="2398" textAnchor="middle" className="court-orientation-label">CÁMARA</text>

      {positionedDetections.map((detection, index) => {
        const pointX = ((detection.y_meters ?? 0) / courtWidth) * 1097
        const pointY = ((detection.x_meters ?? 0) / courtLength) * 2377
        const className = detection.class === 'player' ? 'player' : 'ball'
        const markerLabel = className === 'player'
          ? `P${positionedDetections.slice(0, index + 1).filter((item) => item.class === 'player').length}`
          : 'B'

        return (
          <g key={`${frame?.frame_index}-${detection.class}-${index}`}>
            <circle cx={pointX} cy={pointY} r={className === 'player' ? 34 : 24} className={`court-marker court-marker--${className}`} />
            <text x={pointX} y={pointY + 7} textAnchor="middle" className="court-marker-label">
              {markerLabel}
            </text>
          </g>
        )
      })}
    </svg>
  )
}

function App() {
  const [theme, setTheme] = useState<'light' | 'dark'>(() =>
    window.localStorage.getItem('netpoint-theme') === 'light' ? 'light' : 'dark',
  )
  const [sourceUrl, setSourceUrl] = useState('')
  const [inputMode, setInputMode] = useState<'url' | 'file'>('url')
  const [selectedVideo, setSelectedVideo] = useState<File | null>(null)
  const [localPreviewUrl, setLocalPreviewUrl] = useState('')
  const [title, setTitle] = useState('')
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [processingProgress, setProcessingProgress] = useState<MatchProgressResponse>({
    processedFrames: 0,
    totalFrames: null,
  })
  const [currentTime, setCurrentTime] = useState(0)
  const [isVideoPlaying, setIsVideoPlaying] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const previewUrlRef = useRef('')
  const requestSequenceRef = useRef(0)

  useEffect(() => () => {
    if (previewUrlRef.current) {
      URL.revokeObjectURL(previewUrlRef.current)
    }
  }, [])

  useEffect(() => {
    window.localStorage.setItem('netpoint-theme', theme)
  }, [theme])

  const frames = analysis?.telemetry ?? []
  const currentFrame = frames.reduce<FrameTelemetry | undefined>(
    (selectedFrame, frame) =>
      frame.timestamp_seconds <= currentTime ? frame : selectedFrame,
    undefined,
  )
  const currentDetections = currentFrame?.detections ?? []

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()

    if (isSubmitting) {
      return
    }

    const trimmedSourceUrl = sourceUrl.trim()
    const trimmedTitle = title.trim()
    const uploadFile = inputMode === 'file' ? selectedVideo : null
    if (!uploadFile && !trimmedSourceUrl) {
      return
    }
    const matchId = window.crypto.randomUUID()
    const requestSequence = requestSequenceRef.current + 1

    requestSequenceRef.current = requestSequence
    setIsSubmitting(true)
    setProcessingProgress({ processedFrames: 0, totalFrames: null })
    setErrorMessage(null)
    setAnalysis(null)
    setCurrentTime(0)
    setIsVideoPlaying(false)

    let processingFinished = false
    const progressPolling = (async () => {
      while (!processingFinished) {
        try {
          const progress = await getMatchProgress(matchId)
          if (!processingFinished && requestSequenceRef.current === requestSequence) {
            setProcessingProgress(progress)
          }
        } catch {
          // Progress may not be available until the video reaches the vision service.
        }
        if (!processingFinished) {
          await new Promise((resolve) => window.setTimeout(resolve, 500))
        }
      }
    })()

    try {
      const processResponse = uploadFile
        ? await uploadMatchVideo(uploadFile, trimmedTitle || undefined, matchId)
        : await processMatch({ sourceUrl: trimmedSourceUrl, title: trimmedTitle || undefined, matchId })

      if (requestSequence !== requestSequenceRef.current) {
        return
      }

      setAnalysis({
        matchId: processResponse.matchId,
        status: processResponse.status,
        sourceUrl: uploadFile ? localPreviewUrl : trimmedSourceUrl,
        title: trimmedTitle || (uploadFile ? uploadFile.name : undefined),
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
      processingFinished = true
      await progressPolling
      if (requestSequence === requestSequenceRef.current) {
        setIsSubmitting(false)
      }
    }
  }

  return (
    <main className="app-shell" data-theme={theme}>
      <div className="app-layout">
        <header className="workspace-header">
          <div className="workspace-brand">
            <span className="workspace-brand__mark">NP</span>
            <span>NETPOINT <strong>AI</strong></span>
          </div>
          <div className="workspace-title">
            <span className="eyebrow">ANÁLISIS DE PARTIDO</span>
            <h1>{analysis?.title ?? 'Centro de análisis'}</h1>
          </div>
          <div className="theme-toggle" role="group" aria-label="Tema de la interfaz">
            <button
              type="button"
              aria-label="Modo claro"
              aria-pressed={theme === 'light'}
              title="Modo claro"
              onClick={() => setTheme('light')}
            >
              <Sun size={17} />
            </button>
            <button
              type="button"
              aria-label="Modo oscuro"
              aria-pressed={theme === 'dark'}
              title="Modo oscuro"
              onClick={() => setTheme('dark')}
            >
              <Moon size={17} />
            </button>
          </div>
          <div className="workspace-stats">
            <div className="workspace-stat">
              <span className="workspace-stat__label">Estado</span>
              <strong className={isSubmitting ? 'is-live' : ''}>
                {analysis ? 'Procesado' : isSubmitting ? 'En curso' : 'En espera'}
              </strong>
            </div>
            <div className="workspace-stat">
              <span className="workspace-stat__label">Frames</span>
              <strong>{analysis ? frames.length.toLocaleString('es-ES') : '--'}</strong>
            </div>
            <div className="workspace-stat">
              <span className="workspace-stat__label">En pantalla</span>
              <strong>{analysis ? currentDetections.length : '--'}</strong>
            </div>
          </div>
        </header>

        <section className="ingest-panel" aria-label="Iniciar análisis">
          <div className="ingest-panel__heading">
            <div>
              <span className="eyebrow">FUENTE</span>
              <h2>Nuevo análisis</h2>
            </div>
            <div className="source-toggle" role="group" aria-label="Origen del video">
              <button type="button" aria-pressed={inputMode === 'url'} onClick={() => setInputMode('url')}>
                <Link2 size={16} /> URL
              </button>
              <button type="button" aria-pressed={inputMode === 'file'} onClick={() => setInputMode('file')}>
                <Upload size={16} /> Archivo
              </button>
            </div>
          </div>

          <form className={`ingest-form ingest-form--${inputMode}`} onSubmit={handleSubmit} noValidate>
            {inputMode === 'url' ? (
              <label className="field">
                <span>URL del video</span>
                <input
                  type="url"
                  required
                  value={sourceUrl}
                  onChange={(event) => setSourceUrl(event.target.value)}
                  placeholder="https://..."
                />
              </label>
            ) : (
              <div className="file-field">
                <input
                  ref={fileInputRef}
                  className="sr-only"
                  type="file"
                  accept="video/mp4,video/webm,video/quicktime,video/x-msvideo,video/x-matroska,.m4v,.mkv"
                  aria-label="Seleccionar archivo de video"
                  onChange={(event) => {
                    const file = event.currentTarget.files?.[0]
                    event.currentTarget.value = ''
                    if (!file) return
                    const extension = file.name.split('.').at(-1)?.toLowerCase()
                    if (!['mp4', 'm4v', 'mov', 'avi', 'mkv', 'webm'].includes(extension ?? '')) {
                      setErrorMessage('Formato no compatible. Selecciona MP4, M4V, MOV, AVI, MKV o WebM.')
                      return
                    }
                    if (file.size > maximumVideoSizeBytes) {
                      setErrorMessage('El archivo supera el límite de 1 GB.')
                      return
                    }
                    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current)
                    const previewUrl = URL.createObjectURL(file)
                    previewUrlRef.current = previewUrl
                    setLocalPreviewUrl(previewUrl)
                    setSelectedVideo(file)
                    setErrorMessage(null)
                  }}
                />
                <span className="field-label">Archivo de video</span>
                <button className="file-picker" type="button" onClick={() => fileInputRef.current?.click()}>
                  <Upload size={17} />
                  {selectedVideo ? 'Cambiar archivo' : 'Seleccionar video'}
                </button>
                <span className="file-meta">
                  {selectedVideo
                    ? `${selectedVideo.name} · ${(selectedVideo.size / (1024 * 1024)).toFixed(1)} MB`
                    : 'MP4, M4V, MOV, AVI, MKV o WebM · máx. 1 GB'}
                </span>
              </div>
            )}

            <label className="field field--title">
              <span>Título</span>
              <input
                type="text"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                placeholder="Final ATP · Set 1"
              />
            </label>

            <button
              className="analyze-button"
              type="submit"
              disabled={isSubmitting || (inputMode === 'url' ? sourceUrl.trim().length === 0 : !selectedVideo)}
            >
              {isSubmitting ? <RefreshCw size={17} className="animate-spin" /> : <Video size={17} />}
              {isSubmitting ? 'Analizando' : 'Analizar'}
            </button>
          </form>

          {isSubmitting ? (
            <div className="processing-status" role="status" aria-live="polite">
              <span>Fotogramas procesados</span>
              <strong>
                {processingProgress.processedFrames.toLocaleString('es-ES')}
                {processingProgress.totalFrames !== null
                  ? ` / ${processingProgress.totalFrames.toLocaleString('es-ES')}`
                  : ''}
              </strong>
            </div>
          ) : null}

          {errorMessage ? (
            <div className="notice notice--error" role="alert">
              <AlertTriangle size={18} />
              <div>
                <strong>No se pudo completar el análisis</strong>
                <span>{errorMessage}</span>
              </div>
            </div>
          ) : null}

          {analysis ? (
            <div className="notice notice--success" role="status">
              <CheckCircle2 size={18} />
              <strong>Procesamiento completado</strong>
            </div>
          ) : null}
        </section>

        <section className="analysis-grid" aria-label="Revisión del partido">
          <div className="analysis-primary">
            <FrameInspector analysis={analysis} frame={currentFrame} isPlaying={isVideoPlaying} />
          </div>

          <aside className="analysis-rail">
            <section className="workspace-panel court-panel">
              <div className="panel-heading">
                <div>
                  <span className="eyebrow">COORDENADAS MÉTRICAS</span>
                  <h2>Mapa de pista</h2>
                </div>
                <span className="panel-timestamp">
                  {currentFrame ? `#${currentFrame.frame_index} · ${formatTime(currentFrame.timestamp_seconds)}` : '--'}
                </span>
              </div>
              <div className="court-map-stage">
                {analysis ? (
                  <CourtVisualization frame={currentFrame} />
                ) : (
                  <div className="court-map-empty">
                    <Radar size={22} />
                    <span>El mapa aparecerá al procesar un partido</span>
                  </div>
                )}
              </div>
              <div className="map-legend" aria-label="Leyenda del mapa">
                <span><i className="map-legend__dot map-legend__dot--player" /> Jugadores</span>
                <span><i className="map-legend__dot map-legend__dot--ball" /> Pelota</span>
                <span className="map-legend__orientation">Fondo arriba · cámara abajo</span>
              </div>
            </section>

            <section className="workspace-panel source-panel">
              <div className="panel-heading">
                <div>
                  <span className="eyebrow">REPRODUCCIÓN</span>
                  <h2>Video fuente</h2>
                </div>
                {analysis?.title ? <span className="source-title">{analysis.title}</span> : null}
              </div>
              <VideoPlayer
                sourceUrl={analysis?.sourceUrl ?? ''}
                onTimeChange={setCurrentTime}
                onPlaybackChange={setIsVideoPlaying}
              />
            </section>
          </aside>
        </section>
      </div>
    </main>
  )
}

export default App
