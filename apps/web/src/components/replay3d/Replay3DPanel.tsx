import { useEffect, useMemo, useRef, useState } from 'react'
import { Box, Maximize2, Minimize2 } from 'lucide-react'

import { courtFill } from '../../lib/courtColors.ts'
import { buildFlightSegments, currentShotIndex, describeShots, NET_X, type ShotFlight } from '../../lib/flightPath.ts'
import { formatSpeed, formatTime } from '../../lib/format.ts'
import { findFrameAt } from '../../lib/frameLookup.ts'
import { shotTypeLabels } from '../../lib/shotSummary.ts'
import type { MatchTelemetry, PlayerSide } from '../../services/api'
import type { PlayerNames } from '../ingest/PlayerNamesDialog'
import { type CameraView, CourtReplayScene, type ReplayPlayer } from './courtScene'
import './Replay3D.css'

export interface Replay3DPanelProps {
  telemetry: MatchTelemetry
  currentTime: number
  isPlaying: boolean
  /** Exact playback time read from the video each frame, so the ball moves smoothly. */
  getVideoTime: () => number | null
  playerNames: PlayerNames
  onSeek: (seconds: number) => void
}

const viewLabels: Record<CameraView, string> = { tv: 'TV', side: 'Lateral', top: 'Cenital' }

function formatMeters(value: number | null): string {
  return value === null ? '--' : `${value.toFixed(2).replace('.', ',')} m`
}

function formatClearance(value: number | null): string {
  if (value === null) return '--'
  const centimetres = Math.round(value * 100)
  return centimetres < 0 ? `${centimetres} cm (red)` : `+${centimetres} cm`
}

/** One player per half, the most confident detection, from a frame's detections. */
function playersIn(telemetry: MatchTelemetry, time: number): ReplayPlayer[] {
  const frame = findFrameAt(telemetry.frames, time)
  const best = new Map<PlayerSide, { player: ReplayPlayer; confidence: number }>()
  for (const detection of frame?.detections ?? []) {
    if (detection.class !== 'player' || detection.x_meters === null || detection.y_meters === null) continue
    const side: PlayerSide = detection.x_meters < NET_X ? 'far' : 'near'
    const current = best.get(side)
    if (!current || detection.confidence > current.confidence) {
      best.set(side, { player: { side, x: detection.x_meters, y: detection.y_meters }, confidence: detection.confidence })
    }
  }
  return [...best.values()].map((entry) => entry.player)
}

/** 3D replay of the rally: the court in perspective, the reconstructed flights and each shot's figures. */
export default function Replay3DPanel({
  telemetry, currentTime, isPlaying, getVideoTime, playerNames, onSeek,
}: Replay3DPanelProps) {
  const stageRef = useRef<HTMLDivElement>(null)
  const sceneRef = useRef<CourtReplayScene | null>(null)
  const playback = useRef({ currentTime, isPlaying, getVideoTime })
  const [view, setView] = useState<CameraView>('tv')
  const [webglFailed, setWebglFailed] = useState(false)
  // Browser fullscreen when it is available; otherwise (iPhone) the stage covers the window.
  const [fullscreen, setFullscreen] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const enlarged = fullscreen || expanded

  useEffect(() => {
    const sync = () => setFullscreen(document.fullscreenElement !== null && document.fullscreenElement === stageRef.current)
    document.addEventListener('fullscreenchange', sync)
    return () => document.removeEventListener('fullscreenchange', sync)
  }, [])

  useEffect(() => {
    if (!expanded) return
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setExpanded(false)
    }
    window.addEventListener('keydown', close)
    return () => window.removeEventListener('keydown', close)
  }, [expanded])

  useEffect(() => {
    playback.current = { currentTime, isPlaying, getVideoTime }
  })

  const { hits, bounces } = telemetry.events
  const segments = useMemo(() => buildFlightSegments(hits, bounces), [hits, bounces])
  const shots = useMemo(() => describeShots(hits, segments), [hits, segments])
  const shotIndex = currentShotIndex(hits, currentTime)
  const shot: ShotFlight | undefined = shots[shotIndex]
  const playerLabel = (side: PlayerSide) => playerNames[side] || (side === 'far' ? 'Fondo' : 'Cámara')

  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    let scene: CourtReplayScene
    try {
      scene = new CourtReplayScene(stage, segments, hits, bounces, courtFill(telemetry.court.colors))
    } catch {
      // Defer the state change: the effect runs during the commit.
      queueMicrotask(() => setWebglFailed(true))
      return
    }
    sceneRef.current = scene
    let frame = 0
    const loop = () => {
      const { currentTime: fallback, isPlaying: playing, getVideoTime: read } = playback.current
      const time = (playing ? read() : null) ?? fallback
      scene.render({ time, players: playersIn(telemetry, time) })
      frame = requestAnimationFrame(loop)
    }
    frame = requestAnimationFrame(loop)
    return () => {
      cancelAnimationFrame(frame)
      scene.dispose()
      sceneRef.current = null
    }
  }, [telemetry, segments, hits, bounces])

  async function toggleSize() {
    const stage = stageRef.current
    if (!stage) return
    if (enlarged) {
      if (document.fullscreenElement) await document.exitFullscreen().catch(() => undefined)
      setExpanded(false)
      return
    }
    if (document.fullscreenEnabled && stage.requestFullscreen) {
      try {
        await stage.requestFullscreen()
        return
      } catch {
        // Refused (iframe, policy): fall back to covering the window.
      }
    }
    setExpanded(true)
  }

  function changeView(next: CameraView) {
    setView(next)
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    sceneRef.current?.setView(next, !reduceMotion)
  }

  return (
    <div className="replay3d">
      <div className={`replay3d__stage${expanded ? ' is-expanded' : ''}`} ref={stageRef}>
        {webglFailed ? (
          <p className="replay3d__fallback">
            <Box size={22} strokeWidth={1.4} aria-hidden="true" />
            Este navegador no puede mostrar gráficos 3D (WebGL desactivado).
          </p>
        ) : (
          <>
            <div className="replay3d__views" role="group" aria-label="Cámara">
              {(Object.keys(viewLabels) as CameraView[]).map((key) => (
                <button key={key} type="button" aria-pressed={view === key} onClick={() => changeView(key)}>
                  {viewLabels[key]}
                </button>
              ))}
            </div>
            <button
              type="button"
              className="replay3d__size"
              onClick={() => void toggleSize()}
              aria-label={enlarged ? 'Salir de pantalla completa' : 'Pantalla completa'}
              title={enlarged ? 'Salir de pantalla completa (Esc)' : 'Pantalla completa'}
            >
              {enlarged ? <Minimize2 size={15} aria-hidden="true" /> : <Maximize2 size={15} aria-hidden="true" />}
            </button>
            <span className="replay3d__hint" aria-hidden="true">Arrastra para girar · rueda para acercar</span>
          </>
        )}
      </div>

      {shot ? (
        <section className="replay3d__shot" aria-live="polite" aria-label="Golpe actual">
          <header>
            <i className={`swatch swatch--${shot.hit.player}`} aria-hidden="true" />
            <strong>{shotTypeLabels[shot.hit.type]}</strong>
            <span>{playerLabel(shot.hit.player)}</span>
            <span className="replay3d__shot-time">{formatTime(shot.hit.timestamp_seconds)}</span>
          </header>
          <dl>
            <div><dt>Velocidad</dt><dd>{formatSpeed(shot.hit.speed_kmh)}</dd></div>
            <div><dt>Impacto</dt><dd>{formatMeters(shot.contactHeight)}</dd></div>
            <div><dt>Sobre la red</dt><dd>{formatClearance(shot.netClearance)}</dd></div>
            <div><dt>Altura máx.</dt><dd>{formatMeters(shot.apexHeight)}</dd></div>
          </dl>
        </section>
      ) : (
        <p className="replay3d__idle">Reproduce el vídeo o elige un golpe para verlo en 3D.</p>
      )}

      {shots.length ? (
        <ol className="replay3d__list" aria-label="Golpes del punto">
          {shots.map(({ hit, hitIndex }) => (
            <li key={`${hit.frame_index}-${hit.player}`}>
              <button
                type="button"
                aria-current={hitIndex === shotIndex ? 'step' : undefined}
                onClick={() => onSeek(hit.timestamp_seconds)}
              >
                <span className="replay3d__list-index">{hitIndex + 1}</span>
                <i className={`swatch swatch--${hit.player}`} aria-hidden="true" />
                <span className="replay3d__list-type">{shotTypeLabels[hit.type]}</span>
                <strong>{formatSpeed(hit.speed_kmh)}</strong>
              </button>
            </li>
          ))}
        </ol>
      ) : null}

      <p className="replay3d__note">
        Trayectorias reconstruidas con física balística entre los golpes y botes detectados; el paso por la red es
        una estimación. La posición de los jugadores sale del vídeo; su gesto es ilustrativo.
      </p>
    </div>
  )
}
