import { useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  ChartNoAxesCombined,
  CheckCircle2,
  Gauge,
  ListOrdered,
  Moon,
  Radar,
  RefreshCw,
  Link2,
  Sun,
  Upload,
  Video,
  X,
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
import { detectBounces, getVisibleBounces, type Bounce } from './bounceDetection'
import { calculateMatchStatistics, type MatchStatistics } from './matchStatistics'
import { detectEstimatedHits } from './hitDetection'
import { calculateShotStatistics, type PlayerSide, type ShotType } from './matchStats'
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
  bounces: Bounce[]
  playerNames: { far: string; near: string }
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
const shotTypes = [
  ['serve', 'Saque'],
  ['volley', 'Volea'],
  ['forehand', 'Derecha'],
  ['backhand', 'Revés'],
] as const satisfies readonly (readonly [ShotType, string])[]
const shotTypeLabels: Record<ShotType, string> = Object.fromEntries(shotTypes) as Record<ShotType, string>
const playerSides: readonly PlayerSide[] = ['far', 'near']

function formatSpeed(value: number | null): string {
  return value === null ? '--' : `${Math.round(value)} km/h`
}

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
          {frame.detections.some((detection) => detection.carried_forward) ? <span>Posiciones previas en línea discontinua</span> : null}
        </div>
      ) : null}
    </section>
  )
}

function CourtVisualization({ frame, bounces, playerNames }: CourtVisualizationProps) {
  const positionedDetections = frame?.detections.filter(
    (detection) => detection.x_meters !== null && detection.y_meters !== null,
  ) ?? []

  return (
    <svg
      viewBox="-60 -80 1217 2537"
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

      {bounces.map((bounce, index) => {
        const pointX = (bounce.y / courtWidth) * 1097
        const pointY = (bounce.x / courtLength) * 2377
        const side = bounce.x < courtLength / 2 ? 'far' : 'near'
        return (
          <g key={`${bounce.timestamp}-${index}`} className={`court-bounce court-bounce--${side}`}>
            <circle cx={pointX} cy={pointY} r="62" className="court-bounce__marker" />
            <text x={pointX} y={pointY + 13} textAnchor="middle" className="court-bounce__label"
              style={{ fontSize: `${Math.min(54, 140 / String(index + 1).length)}px` }}>{index + 1}</text>
          </g>
        )
      })}

      {positionedDetections.filter((detection) => detection.class === 'player').map((detection, index) => {
        const playerX = Math.max(0, Math.min(courtLength, detection.x_meters ?? 0))
        const playerY = Math.max(0, Math.min(courtWidth, detection.y_meters ?? 0))
        const pointX = (playerY / courtWidth) * 1097
        const pointY = (playerX / courtLength) * 2377
        const playerName = playerX < courtLength / 2 ? playerNames.far : playerNames.near
        const markerLabel = Array.from(playerName.trim())[0]?.toLocaleUpperCase('es-ES') ?? '?'

        return (
          <g key={`${frame?.frame_index}-${detection.class}-${index}`}>
            <circle cx={pointX} cy={pointY} r="46" className="court-marker court-marker--player" />
            <text x={pointX} y={pointY + 7} textAnchor="middle" className="court-marker-label">
              {markerLabel}
            </text>
          </g>
        )
      })}
    </svg>
  )
}

function DetectionCoverageRow({ label, detectedFrames, totalFrames, kind }: {
  label: string
  detectedFrames: number
  totalFrames: number
  kind: 'player' | 'ball'
}) {
  const percentage = totalFrames ? Math.round((detectedFrames / totalFrames) * 100) : 0

  return (
    <div className="match-stats__coverage-row">
      <span className="match-stats__coverage-label" title={label}>{label}</span>
      <div
        className={`match-stats__bar match-stats__bar--${kind}`}
        role="progressbar"
        aria-label={`Cobertura de ${label}`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percentage}
      >
        <span style={{ width: `${percentage}%` }} />
      </div>
      <strong>{percentage}%</strong>
      <span className="match-stats__coverage-count">
        {detectedFrames.toLocaleString('es-ES')}/{totalFrames.toLocaleString('es-ES')}
      </span>
    </div>
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
  const [playerNames, setPlayerNames] = useState({ far: '', near: '' })
  const [isPlayerDialogOpen, setIsPlayerDialogOpen] = useState(false)
  const [playerDialogError, setPlayerDialogError] = useState('')
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
  const playerDialogRef = useRef<HTMLDialogElement>(null)
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

  useEffect(() => {
    const dialog = playerDialogRef.current
    if (!dialog) return
    if (isPlayerDialogOpen && !dialog.open) dialog.showModal()
    if (!isPlayerDialogOpen && dialog.open) dialog.close()
  }, [isPlayerDialogOpen])

  const frames = useMemo(() => analysis?.telemetry ?? [], [analysis])
  const bounces = useMemo(() => detectBounces(analysis?.telemetry ?? []), [analysis])
  const statistics: MatchStatistics = useMemo(
    () => calculateMatchStatistics(frames, bounces.length, bounces.map((bounce) => bounce.timestamp)),
    [frames, bounces],
  )
  const shotStatistics = useMemo(
    () => calculateShotStatistics(
      frames,
      bounces,
      detectEstimatedHits(frames, bounces.map((bounce) => bounce.timestamp)),
    ),
    [frames, bounces],
  )
  const playerLabel = (side: PlayerSide) => playerNames[side] || (side === 'far' ? 'Fondo' : 'Cámara')
  const currentFrame = frames.reduce<FrameTelemetry | undefined>(
    (selectedFrame, frame) =>
      frame.timestamp_seconds <= currentTime ? frame : selectedFrame,
    undefined,
  )
  const visibleBounces = currentFrame
    ? getVisibleBounces(bounces, currentFrame.timestamp_seconds)
    : []

  async function startAnalysis() {
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

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (isSubmitting) return
    setPlayerDialogError('')
    setIsPlayerDialogOpen(true)
  }

  function handlePlayerNamesSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const names = { far: playerNames.far.trim(), near: playerNames.near.trim() }
    if (!names.far || !names.near) {
      setPlayerDialogError('Escribe el nombre de ambos jugadores.')
      return
    }
    setPlayerNames(names)
    setPlayerDialogError('')
    setIsPlayerDialogOpen(false)
    void startAnalysis()
  }

  return (
    <main className="app-shell" data-theme={theme}>
      <dialog
        ref={playerDialogRef}
        className="player-dialog"
        aria-labelledby="player-dialog-title"
        onCancel={(event) => {
          event.preventDefault()
          setIsPlayerDialogOpen(false)
        }}
      >
        <form className="player-dialog__form" onSubmit={handlePlayerNamesSubmit}>
          <div className="player-dialog__header">
            <div className="player-dialog__mark" aria-hidden="true">NP</div>
            <button
              className="player-dialog__close"
              type="button"
              aria-label="Cerrar"
              title="Cerrar"
              onClick={() => setIsPlayerDialogOpen(false)}
            >
              <X size={18} />
            </button>
          </div>
          <span className="eyebrow">IDENTIFICACIÓN DE JUGADORES</span>
          <h2 id="player-dialog-title">¿Quién juega cada lado?</h2>
          <p className="player-dialog__description">Sus iniciales aparecerán en el mapa de pista.</p>
          <label className="player-dialog__field">
            <span><b>F</b> Fondo <small>Lado opuesto a la cámara</small></span>
            <input
              autoFocus
              required
              maxLength={80}
              type="text"
              autoComplete="name"
              placeholder="Nombre del jugador"
              value={playerNames.far}
              onChange={(event) => setPlayerNames({ ...playerNames, far: event.target.value })}
            />
          </label>
          <label className="player-dialog__field">
            <span><b>C</b> Cámara <small>Lado más cercano</small></span>
            <input
              required
              maxLength={80}
              type="text"
              autoComplete="name"
              placeholder="Nombre del jugador"
              value={playerNames.near}
              onChange={(event) => setPlayerNames({ ...playerNames, near: event.target.value })}
            />
          </label>
          {playerDialogError ? <p className="player-dialog__error" role="alert">{playerDialogError}</p> : null}
          <div className="player-dialog__actions">
            <button className="player-dialog__cancel" type="button" onClick={() => setIsPlayerDialogOpen(false)}>
              Ahora no
            </button>
            <button className="player-dialog__confirm" type="submit">
              Guardar y analizar <Video size={16} />
            </button>
          </div>
        </form>
      </dialog>
      <div className="app-layout">
        <header className="workspace-header">
          <div className="workspace-brand">
            <span>NETPOINT <strong>AI</strong></span>
          </div>
          <div className="workspace-title">
            <span className="eyebrow">ANÁLISIS DE PARTIDO</span>
            <h1>{analysis?.title ?? 'Centro de análisis'}</h1>
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
          <section className="workspace-panel court-panel analysis-panel--map">
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
                <CourtVisualization frame={currentFrame} bounces={visibleBounces} playerNames={playerNames} />
              ) : (
                <div className="court-map-empty">
                  <Radar size={22} />
                  <span>El mapa aparecerá al procesar un partido</span>
                </div>
              )}
            </div>
          </section>

          <section className="workspace-panel source-panel analysis-panel--video">
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

          <div className="analysis-panel--frames">
            <FrameInspector analysis={analysis} frame={currentFrame} isPlaying={isVideoPlaying} />
          </div>

          <section className="workspace-panel stats-panel analysis-panel--stats" aria-label="Estadísticas del partido">
            <div className="panel-heading">
              <div>
                <span className="eyebrow">PARTIDO</span>
                <h2>Estadísticas</h2>
              </div>
            </div>
            {analysis ? (
              <div className="match-stats">
                <div className="match-stats__summary">
                  <div className="match-stats__metric">
                    <span className="match-stats__metric-label">Duración</span>
                    <strong className="match-stats__metric-value">{formatTime(statistics.durationSeconds)}</strong>
                  </div>
                  <div className="match-stats__metric">
                    <span className="match-stats__metric-label">Botes</span>
                    <strong className="match-stats__metric-value">{statistics.bounceCount.toLocaleString('es-ES')}</strong>
                  </div>
                  <div className="match-stats__metric">
                    <span
                      className="match-stats__metric-label"
                      title="Estimación por cambios de trayectoria cerca de un jugador; no confirma el contacto con la raqueta."
                    >
                      Golpes estimados
                    </span>
                    <strong className="match-stats__metric-value">{shotStatistics.match.totalShots.toLocaleString('es-ES')}</strong>
                  </div>
                  <div className="match-stats__metric">
                    <span
                      className="match-stats__metric-label"
                      title="Estimada con la proyección de la pelota sobre la pista; puede sobrestimar golpes altos."
                    >
                      Vel. máxima
                    </span>
                    <strong className="match-stats__metric-value">{formatSpeed(shotStatistics.match.maxSpeedKmh)}</strong>
                  </div>
                </div>
                <div className="match-stats__coverage">
                  <div className="match-stats__coverage-heading">
                    <h3><Gauge size={16} /> Golpes por jugador</h3>
                    <span>{shotStatistics.match.pointCount.toLocaleString('es-ES')} puntos</span>
                  </div>
                  <div className="shot-table__wrapper">
                    <table className="shot-table">
                      <thead>
                        <tr>
                          <th scope="col">Jugador</th>
                          {shotTypes.map(([type, label]) => <th key={type} scope="col">{label}</th>)}
                          <th scope="col">Máx.</th>
                          <th scope="col">Media</th>
                        </tr>
                      </thead>
                      <tbody>
                        {playerSides.map((side) => {
                          const summary = shotStatistics.byPlayer[side]
                          return (
                            <tr key={side}>
                              <th scope="row" title={playerLabel(side)}>{playerLabel(side)}</th>
                              {shotTypes.map(([type]) => <td key={type}>{summary.byType[type]}</td>)}
                              <td>{formatSpeed(summary.maxSpeedKmh)}</td>
                              <td>{formatSpeed(summary.averageSpeedKmh)}</td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
                <div className="match-stats__coverage">
                  <div className="match-stats__coverage-heading">
                    <h3><ListOrdered size={16} /> Registro de golpes</h3>
                    <span>{shotStatistics.match.measuredShots}/{shotStatistics.match.totalShots} con velocidad</span>
                  </div>
                  {shotStatistics.shots.length ? (
                    <ol className="shot-log">
                      {shotStatistics.shots.map((shot) => (
                        <li key={`${shot.frameIndex}-${shot.player}`} className={shot.timestamp <= currentTime ? 'is-past' : undefined}>
                          <span className="shot-log__time">{formatTime(shot.timestamp)}</span>
                          <span className={`shot-log__type shot-log__type--${shot.type}`}>{shotTypeLabels[shot.type]}</span>
                          <span className="shot-log__player" title={playerLabel(shot.player)}>{playerLabel(shot.player)}</span>
                          <strong>{formatSpeed(shot.speedKmh)}</strong>
                        </li>
                      ))}
                    </ol>
                  ) : (
                    <p className="shot-log__empty">No se detectaron golpes en este video.</p>
                  )}
                </div>
                <div className="match-stats__coverage">
                  <div className="match-stats__coverage-heading">
                    <h3><ChartNoAxesCombined size={16} /> Cobertura</h3>
                    <span>frames detectados</span>
                  </div>
                  <DetectionCoverageRow
                    label={playerNames.far || 'Fondo'}
                    detectedFrames={statistics.farPlayerFrames}
                    totalFrames={statistics.frameCount}
                    kind="player"
                  />
                  <DetectionCoverageRow
                    label={playerNames.near || 'Cámara'}
                    detectedFrames={statistics.nearPlayerFrames}
                    totalFrames={statistics.frameCount}
                    kind="player"
                  />
                  <DetectionCoverageRow
                    label="Pelota"
                    detectedFrames={statistics.ballFrames}
                    totalFrames={statistics.frameCount}
                    kind="ball"
                  />
                </div>
              </div>
            ) : (
              <div className="match-stats__empty">
                <ChartNoAxesCombined size={24} strokeWidth={1.5} />
                <span>Analiza un partido para ver sus estadísticas</span>
              </div>
            )}
          </section>
        </section>
      </div>
    </main>
  )
}

export default App
