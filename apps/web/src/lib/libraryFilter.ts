import type { LibraryMatch } from '../services/api'

export type LibrarySort = 'recent' | 'oldest' | 'duration' | 'shots'

export const librarySortLabels: Record<LibrarySort, string> = {
  recent: 'Más recientes',
  oldest: 'Más antiguos',
  duration: 'Mayor duración',
  shots: 'Más golpes',
}

function normalize(text: string): string {
  return text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
}

/** Filters by title or file name (accent-insensitive) and sorts without mutating the input. */
export function filterLibrary(matches: LibraryMatch[], query: string, sort: LibrarySort): LibraryMatch[] {
  const needle = normalize(query.trim())
  const visible = needle
    ? matches.filter((match) => normalize(`${match.title} ${match.videoFilename ?? ''}`).includes(needle))
    : [...matches]

  const byDate = (left: LibraryMatch, right: LibraryMatch) => Date.parse(right.createdAt) - Date.parse(left.createdAt)
  const comparators: Record<LibrarySort, (left: LibraryMatch, right: LibraryMatch) => number> = {
    recent: byDate,
    oldest: (left, right) => -byDate(left, right),
    duration: (left, right) => (right.durationSeconds ?? 0) - (left.durationSeconds ?? 0) || byDate(left, right),
    shots: (left, right) => right.hitCount - left.hitCount || byDate(left, right),
  }
  return visible.sort(comparators[sort])
}

/** "Hoy", "Ayer", "hace 3 días" or a short date once it is older than a week. */
export function formatRelativeDate(isoDate: string, now: Date = new Date()): string {
  const date = new Date(isoDate)
  if (Number.isNaN(date.getTime())) return '--'
  const startOfDay = (value: Date) => new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime()
  const days = Math.round((startOfDay(now) - startOfDay(date)) / 86_400_000)
  if (days <= 0) return 'Hoy'
  if (days === 1) return 'Ayer'
  if (days < 7) return `Hace ${days} días`
  return date.toLocaleDateString('es-ES', { day: 'numeric', month: 'short', year: 'numeric' })
}

/** m:ss for a duration in seconds. */
export function formatDuration(seconds: number | null): string {
  if (seconds === null) return '--:--'
  const total = Math.round(seconds)
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}
