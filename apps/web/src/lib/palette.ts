import type { PlayerSide } from '../services/api'

/**
 * Data colours drawn on the court and over the video. Both are dark in either theme,
 * so these bright steps are shared by the canvas overlay, the court map and the loader.
 * Colour follows the entity: the ball, and each player (and the half of the court they defend).
 * Validated with the dataviz palette checks (all pairs, CVD ΔE ≥ 17, normal-vision ΔE ≥ 25).
 * The UI-surface steps of the same hues live in `styles/tokens.css` (`--data-*`).
 */
export const courtPalette = {
  ball: '#DCF04A',
  far: '#5CC8F2',
  near: '#F58A4B',
  /** Hard-court surface, outer apron and line paint. */
  court: '#1E4E8C',
  courtOuter: '#163A6A',
  line: '#EEF2F6',
  /** Ink behind the video and in the label cards drawn over it. */
  stage: '#050B15',
} as const

export const sideColors: Record<PlayerSide, string> = {
  far: courtPalette.far,
  near: courtPalette.near,
}

/** `#RRGGBB` → `rgba(r, g, b, alpha)` for canvas strokes that fade. */
export function withAlpha(hex: string, alpha: number): string {
  const value = Number.parseInt(hex.slice(1), 16)
  return `rgba(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}, ${alpha})`
}
