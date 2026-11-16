import { useState } from 'react'
import { Film, Loader2, Play } from 'lucide-react'

import { formatDuration, formatRelativeDate } from '../../lib/libraryFilter.ts'
import { type LibraryMatch, getLibraryThumbnailUrl } from '../../services/api'

interface MatchCardProps {
  match: LibraryMatch
  index: number
  isOpening: boolean
  disabled: boolean
  onOpen: (matchId: string) => void
}

const sourceLabels = { url: 'Enlace', upload: 'Archivo' } as const

/** One stored analysis; the whole card is the button that loads it into the workspace. */
export function MatchCard({ match, isOpening, disabled, onOpen }: MatchCardProps) {
  const [thumbnailFailed, setThumbnailFailed] = useState(false)
  const showThumbnail = match.hasVideo && !thumbnailFailed
  const source = sourceLabels[match.source as keyof typeof sourceLabels] ?? 'Análisis'

  return (
    <li className="match-card-item">
      <button
        type="button"
        className="match-card"
        data-opening={isOpening}
        disabled={disabled}
        aria-busy={isOpening}
        onClick={() => onOpen(match.id)}
      >
        <span className="match-card__media">
          {showThumbnail ? (
            <img
              src={getLibraryThumbnailUrl(match.id)}
              alt=""
              loading="lazy"
              decoding="async"
              onError={() => setThumbnailFailed(true)}
            />
          ) : (
            <span className="match-card__fallback" aria-hidden="true">
              <Film size={28} strokeWidth={1.4} />
            </span>
          )}
          <span className="match-card__duration">{formatDuration(match.durationSeconds)}</span>
          <span className="match-card__play" aria-hidden="true">
            {isOpening ? <Loader2 size={20} className="animate-spin" /> : <Play size={20} fill="currentColor" />}
          </span>
        </span>

        <span className="match-card__body">
          <span className="match-card__title" title={match.title}>{match.title}</span>
          <span className="match-card__meta">
            <time dateTime={match.createdAt}>{formatRelativeDate(match.createdAt)}</time>
            {', '}{source.toLowerCase()}
            {match.width && match.height ? `, ${match.height}p` : null}
          </span>
          <span className="match-card__stats">
            <span className="figure" title="Golpes estimados">
              <strong className="figure__value">{match.hitCount}</strong>
              <span className="figure__label">golpes</span>
            </span>
            <span className="figure" title="Botes detectados">
              <strong className="figure__value">{match.bounceCount}</strong>
              <span className="figure__label">botes</span>
            </span>
            <span className="figure" title="Velocidad máxima estimada">
              <strong className="figure__value">{match.maxSpeedKmh === null ? '—' : Math.round(match.maxSpeedKmh)}</strong>
              <span className="figure__label">km/h máx.</span>
            </span>
          </span>
        </span>
      </button>
    </li>
  )
}
