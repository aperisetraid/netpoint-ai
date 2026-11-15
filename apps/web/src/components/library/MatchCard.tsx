import { useState } from 'react'
import { Activity, Clock, Film, Gauge, Loader2, Play, Target } from 'lucide-react'

import { formatDuration, formatRelativeDate } from '../../lib/libraryFilter.ts'
import { type LibraryMatch, getLibraryThumbnailUrl } from '../../services/api'

interface MatchCardProps {
  match: LibraryMatch
  index: number
  isOpening: boolean
  disabled: boolean
  onOpen: (matchId: string) => void
}

/** One stored analysis; the whole card is the button that loads it into the workspace. */
export function MatchCard({ match, index, isOpening, disabled, onOpen }: MatchCardProps) {
  const [thumbnailFailed, setThumbnailFailed] = useState(false)
  const showThumbnail = match.hasVideo && !thumbnailFailed

  return (
    <li className="match-card-item" style={{ '--card-index': Math.min(index, 12) } as React.CSSProperties}>
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
              <Film size={30} strokeWidth={1.4} />
            </span>
          )}
          <span className="match-card__duration">
            <Clock size={11} aria-hidden="true" /> {formatDuration(match.durationSeconds)}
          </span>
          <span className="match-card__play" aria-hidden="true">
            {isOpening ? <Loader2 size={22} className="animate-spin" /> : <Play size={22} fill="currentColor" />}
          </span>
        </span>

        <span className="match-card__body">
          <span className="match-card__title" title={match.title}>{match.title}</span>
          <span className="match-card__meta">
            <time dateTime={match.createdAt}>{formatRelativeDate(match.createdAt)}</time>
            <span aria-hidden="true">·</span>
            <span>{match.source === 'url' ? 'Enlace' : match.source === 'upload' ? 'Archivo' : 'Análisis'}</span>
            {match.width && match.height ? <><span aria-hidden="true">·</span><span>{match.height}p</span></> : null}
          </span>
          <span className="match-card__stats">
            <span title="Golpes estimados"><Target size={13} aria-hidden="true" /> {match.hitCount} golpes</span>
            <span title="Botes detectados"><Activity size={13} aria-hidden="true" /> {match.bounceCount} botes</span>
            <span title="Velocidad máxima estimada">
              <Gauge size={13} aria-hidden="true" />
              {match.maxSpeedKmh === null ? '--' : `${Math.round(match.maxSpeedKmh)} km/h`}
            </span>
          </span>
        </span>
      </button>
    </li>
  )
}
