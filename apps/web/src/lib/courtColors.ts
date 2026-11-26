import { courtPalette } from './palette.ts'

/** Colours measured on the video by the vision service (`court.colors` in the telemetry). */
export interface MeasuredCourtColors {
  surface: string
  surround?: string
}

export interface CourtFill {
  court: string
  courtOuter: string
}

/**
 * The surface keeps its hue (clay stays orange, a US Open court blue) but is muted and darkened, so the
 * white lines, the yellow ball and the player colours keep their contrast on it. Measured broadcast
 * colours are also lit and graded by TV, so this reads closer to how the court is remembered.
 */
const SURFACE_LIGHTNESS = [0.22, 0.32] as const
const SURFACE_MAX_SATURATION = 0.55
/** The surround sits a step darker than the court, and is forced to when both are the same material. */
const SURROUND_LIGHTNESS = [0.16, 0.27] as const
const SURROUND_STEP = 0.07
/** Below this RGB distance the surround is the same colour as the court (clay all round). */
const SAME_MATERIAL_DISTANCE = 40
/**
 * Brightest the surface may be: keeps a 3:1 contrast with the orange player, the dimmest mark. Green
 * reads much brighter than blue at the same lightness, so the cap is on luminance, not lightness.
 */
const MAX_SURFACE_LUMINANCE = 0.09

type Hsl = [number, number, number]

function parseHex(hex: string): [number, number, number] | null {
  const match = /^#([0-9a-f]{6})$/i.exec(hex)
  if (!match) return null
  const value = Number.parseInt(match[1], 16)
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255]
}

function toHsl([red, green, blue]: [number, number, number]): Hsl {
  const r = red / 255
  const g = green / 255
  const b = blue / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const lightness = (max + min) / 2
  if (max === min) return [0, 0, lightness]
  const delta = max - min
  const saturation = lightness > 0.5 ? delta / (2 - max - min) : delta / (max + min)
  let hue = max === r ? (g - b) / delta + (g < b ? 6 : 0) : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4
  hue /= 6
  return [hue, saturation, lightness]
}

function toHex([hue, saturation, lightness]: Hsl): string {
  const channel = (offset: number) => {
    const k = (offset + hue * 12) % 12
    const a = saturation * Math.min(lightness, 1 - lightness)
    return Math.round(255 * (lightness - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))))
  }
  return `#${[channel(0), channel(8), channel(4)].map((value) => value.toString(16).padStart(2, '0')).join('').toUpperCase()}`
}

function clamp(value: number, [minimum, maximum]: readonly [number, number]): number {
  return Math.min(maximum, Math.max(minimum, value))
}

/** Relative luminance (WCAG) of a `#RRGGBB` colour. */
export function luminance(hex: string): number {
  const rgb = parseHex(hex)
  if (!rgb) return 0
  const [r, g, b] = rgb.map((value) => {
    const channel = value / 255
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

export function contrastRatio(first: string, second: string): number {
  const [light, dark] = [luminance(first), luminance(second)].sort((a, b) => b - a)
  return (light + 0.05) / (dark + 0.05)
}

/** Court and surround fills for the 2D map and the 3D replay; the default hard court when unmeasured. */
export function courtFill(colors: MeasuredCourtColors | null | undefined): CourtFill {
  const surfaceRgb = colors ? parseHex(colors.surface) : null
  if (!surfaceRgb) return { court: courtPalette.court, courtOuter: courtPalette.courtOuter }

  const [hue, saturation, lightness] = toHsl(surfaceRgb)
  const court: Hsl = [hue, Math.min(saturation, SURFACE_MAX_SATURATION), clamp(lightness, SURFACE_LIGHTNESS)]
  while (luminance(toHex(court)) > MAX_SURFACE_LUMINANCE && court[2] > 0.1) court[2] -= 0.01

  const surroundRgb = colors?.surround ? parseHex(colors.surround) : null
  const sameMaterial =
    !surroundRgb || Math.hypot(...surroundRgb.map((value, index) => value - surfaceRgb[index])) < SAME_MATERIAL_DISTANCE
  const outer: Hsl = sameMaterial
    ? [court[0], court[1], Math.max(0.08, court[2] - SURROUND_STEP)]
    : (() => {
        const [outerHue, outerSaturation, outerLightness] = toHsl(surroundRgb)
        return [outerHue, Math.min(outerSaturation, SURFACE_MAX_SATURATION), clamp(outerLightness, SURROUND_LIGHTNESS)]
      })()
  return { court: toHex(court), courtOuter: toHex(outer) }
}
