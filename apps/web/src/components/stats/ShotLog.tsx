import { formatSpeed, formatTime } from '../../lib/format.ts'
import { shotTypeLabels } from '../../lib/shotSummary.ts'
import type { HitEvent, PlayerSide } from '../../services/api'

interface ShotLogProps {
  hits: HitEvent[]
  currentTime: number
  playerLabel: (side: PlayerSide) => string
}

/** Chronological list of hits; the ones already played are marked as past. */
export function ShotLog({ hits, currentTime, playerLabel }: ShotLogProps) {
  if (!hits.length) {
    return <p className="shot-log__empty">No se detectaron golpes en este vídeo.</p>
  }
  return (
    <ol className="shot-log">
      {hits.map((hit) => (
        <li key={`${hit.frame_index}-${hit.player}`} className={hit.timestamp_seconds <= currentTime ? 'is-past' : undefined}>
          <span className="shot-log__time">{formatTime(hit.timestamp_seconds)}</span>
          <span className="shot-log__type">{shotTypeLabels[hit.type]}</span>
          <span className="shot-log__player" title={playerLabel(hit.player)}>
            <i className={`swatch swatch--${hit.player}`} aria-hidden="true" />
            <span>{playerLabel(hit.player)}</span>
          </span>
          <strong>{formatSpeed(hit.speed_kmh)}</strong>
        </li>
      ))}
    </ol>
  )
}
