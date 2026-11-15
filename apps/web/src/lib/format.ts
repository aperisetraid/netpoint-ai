export function formatSpeed(value: number | null): string {
  return value === null ? '--' : `${Math.round(value)} km/h`
}

export function formatPercent(value: number): string {
  return `${Math.round(value)}%`
}

export function formatTime(value: number): string {
  const minutes = Math.floor(value / 60)
  const seconds = Math.floor(value % 60)
  const centiseconds = Math.floor((value % 1) * 100)
  return `${minutes}:${String(seconds).padStart(2, '0')}.${String(centiseconds).padStart(2, '0')}`
}
