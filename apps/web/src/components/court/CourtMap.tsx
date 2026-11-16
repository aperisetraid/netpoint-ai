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
            <circle cx={pointX} cy={pointY} r="88" className="court-bounce__marker" />
            <text x={pointX} y={pointY} dy="0.35em" textAnchor="middle" className="court-bounce__label"
              style={{ fontSize: `${Math.min(96, 170 / String(index + 1).length)}px` }}>{index + 1}</text>
          </g>
        )
      })}

      {players.map((detection, index) => {
        const playerX = clamp(detection.x_meters ?? 0, 0, courtLength)
        const playerY = clamp(detection.y_meters ?? 0, 0, courtWidth)
        const pointX = (playerY / courtWidth) * 1097
        const pointY = (playerX / courtLength) * 2377
        const side = playerX < courtLength / 2 ? 'far' : 'near'
        const markerLabel = Array.from(playerNames[side].trim())[0]?.toLocaleUpperCase('es-ES') ?? (side === 'far' ? 'F' : 'C')

        return (
          <g key={`${frame?.frame_index}-${index}`}>
            <circle cx={pointX} cy={pointY} r="84" className={`court-marker court-marker--${side}`} />
            <text x={pointX} y={pointY} dy="0.35em" textAnchor="middle" className="court-marker-label">
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
    <section className="court-card panel" aria-labelledby="court-card-title">
      <div className="court-card__heading">
        <h2 id="court-card-title" className="court-card__title">Pista</h2>
        <span className="panel-timestamp">
          {frame ? (
            <>Fotograma <span className="mono">{frame.frame_index}</span>, <span className="mono">{formatTime(frame.timestamp_seconds)}</span></>
          ) : '—'}
        </span>
      </div>
      <div className="court-map-stage">
        {hasAnalysis ? (
          <>
            <CourtVisualization frame={frame} bounces={bounces} playerNames={playerNames} />
            <div className="court-legend">
              <ul aria-label="Leyenda">
                <li><i className="swatch swatch--far" aria-hidden="true" /> {playerNames.far || 'Fondo'}</li>
                <li><i className="swatch swatch--near" aria-hidden="true" /> {playerNames.near || 'Cámara'}</li>
              </ul>
              <p className="court-legend__count">
                <strong>{bounces.length}</strong> {bounces.length === 1 ? 'bote' : 'botes'}
              </p>
              <p className="court-legend__note">Numerados por orden, del color del campo donde caen.</p>
            </div>
          </>
        ) : (
          <div className="court-map-empty">
            <Radar size={22} strokeWidth={1.5} aria-hidden="true" />
            <span>El mapa aparecerá al analizar un partido.</span>
          </div>
        )}
      </div>
    </section>
  )
}
