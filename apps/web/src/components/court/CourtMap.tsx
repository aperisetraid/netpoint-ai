import { Radar } from 'lucide-react'

import { formatTime } from '../../lib/format.ts'
import type { BounceEvent, FrameTelemetry } from '../../services/api'
import type { PlayerNames } from '../ingest/PlayerNamesDialog'

interface CourtMapProps {
  hasAnalysis: boolean
  frame?: FrameTelemetry
  /** Bounces that have already happened at the current playback time. */
  bounces: BounceEvent[]
  playerNames: PlayerNames
}

const courtLength = 23.77
const courtWidth = 10.97
/** Balls that land out are still drawn, just beyond the lines. */
const outMarginMeters = 0.6

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value))
}

function CourtVisualization({ frame, bounces, playerNames }: Omit<CourtMapProps, 'hasAnalysis'>) {
  const players = frame?.detections.filter(
    (detection) => detection.class === 'player' && detection.x_meters !== null && detection.y_meters !== null,
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
        const pointX = (clamp(bounce.y_meters, -outMarginMeters, courtWidth + outMarginMeters) / courtWidth) * 1097
        const pointY = (clamp(bounce.x_meters, -outMarginMeters, courtLength + outMarginMeters) / courtLength) * 2377
        return (
          <g key={`${bounce.timestamp_seconds}-${index}`} className={`court-bounce court-bounce--${bounce.side}`}>
            <circle cx={pointX} cy={pointY} r="62" className="court-bounce__marker" />
            <text x={pointX} y={pointY + 13} textAnchor="middle" className="court-bounce__label"
              style={{ fontSize: `${Math.min(54, 140 / String(index + 1).length)}px` }}>{index + 1}</text>
          </g>
        )
      })}

      {players.map((detection, index) => {
        const playerX = clamp(detection.x_meters ?? 0, 0, courtLength)
        const playerY = clamp(detection.y_meters ?? 0, 0, courtWidth)
        const pointX = (playerY / courtWidth) * 1097
        const pointY = (playerX / courtLength) * 2377
        const playerName = playerX < courtLength / 2 ? playerNames.far : playerNames.near
        const markerLabel = Array.from(playerName.trim())[0]?.toLocaleUpperCase('es-ES') ?? '?'

        return (
          <g key={`${frame?.frame_index}-${index}`}>
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

/** Top-down court with the players of the current frame and the bounces played so far. */
export function CourtMap({ hasAnalysis, frame, bounces, playerNames }: CourtMapProps) {
  return (
    <section className="workspace-panel court-panel analysis-panel--map">
      <div className="panel-heading">
        <div>
          <span className="eyebrow">COORDENADAS MÉTRICAS</span>
          <h2>Mapa de pista</h2>
        </div>
        <span className="panel-timestamp">
          {frame ? `#${frame.frame_index} · ${formatTime(frame.timestamp_seconds)}` : '--'}
        </span>
      </div>
      <div className="court-map-stage">
        {hasAnalysis ? (
          <CourtVisualization frame={frame} bounces={bounces} playerNames={playerNames} />
        ) : (
          <div className="court-map-empty">
            <Radar size={22} />
            <span>El mapa aparecerá al procesar un partido</span>
          </div>
        )}
      </div>
    </section>
  )
}
