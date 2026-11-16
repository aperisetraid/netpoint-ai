import { formatSpeed } from '../../../lib/format.ts'
import { shotTypeLabels } from '../../../lib/shotSummary.ts'
import { courtPalette, sideColors, withAlpha } from '../../../lib/palette.ts'
import type { FrameTelemetry, HitEvent } from '../../../services/api'

export const hitLabelSeconds = 1.3
const fadeInSeconds = 0.12
const fadeOutSeconds = 0.35
const courtLengthMeters = 23.77
const labelFont = "'Archivo Variable', 'Archivo', system-ui, sans-serif"

/** Top-centre of the box of the player on the hitter's side, in image pixels. */
export function hitAnchor(frame: FrameTelemetry | undefined, hit: HitEvent): [number, number] | null {
  let anchor: [number, number] | null = null
  let confidence = -Infinity
  for (const detection of frame?.detections ?? []) {
    if (detection.class !== 'player' || typeof detection.x_meters !== 'number') continue
    const side = detection.x_meters < courtLengthMeters / 2 ? 'far' : 'near'
    if (side !== hit.player || detection.confidence <= confidence) continue
    confidence = detection.confidence
    anchor = [(detection.bbox[0] + detection.bbox[2]) / 2, detection.bbox[1]]
  }
  return anchor
}

/** Draws a floating card above `anchor` with the shot type and speed, `age` seconds after the hit.
 *  The card wears the hitter's colour (as on the court map); the type is always spelled out. */
export function drawHitLabel(
  context: CanvasRenderingContext2D,
  hit: HitEvent,
  age: number,
  anchor: [number, number],
  unit: number,
  imageWidth: number,
): void {
  if (age < 0 || age > hitLabelSeconds) return
  const opacity = Math.min(1, age / fadeInSeconds, (hitLabelSeconds - age) / fadeOutSeconds)
  const rise = (1 - (1 - Math.min(1, age / 0.3)) ** 3) * 10 * unit

  const typeText = shotTypeLabels[hit.type]
  const speedText = hit.speed_kmh === null ? '' : formatSpeed(hit.speed_kmh)
  const fontSize = 13 * unit
  const paddingX = 9 * unit
  const gap = 8 * unit
  const dot = 7 * unit
  const height = 26 * unit

  const accent = sideColors[hit.player]
  context.save()
  context.globalAlpha = opacity
  context.textBaseline = 'middle'
  context.font = `700 ${fontSize}px ${labelFont}`
  const typeWidth = context.measureText(typeText).width
  context.font = `500 ${fontSize}px ${labelFont}`
  const speedWidth = speedText ? context.measureText(speedText).width + gap : 0
  const width = paddingX * 2 + dot + gap * 0.75 + typeWidth + speedWidth

  const left = Math.max(4 * unit, Math.min(imageWidth - width - 4 * unit, anchor[0] - width / 2))
  const top = Math.max(4 * unit, anchor[1] - height - 12 * unit - rise)
  const middle = top + height / 2

  context.beginPath()
  context.roundRect(left, top, width, height, height / 2)
  context.fillStyle = withAlpha(courtPalette.stage, 0.86)
  context.fill()
  context.strokeStyle = accent
  context.lineWidth = 1.5 * unit
  context.stroke()

  // Pointer from the card down to the player.
  context.beginPath()
  context.moveTo(anchor[0], top + height)
  context.lineTo(anchor[0], Math.max(top + height, anchor[1] - 3 * unit))
  context.stroke()

  context.beginPath()
  context.arc(left + paddingX + dot / 2, middle, dot / 2, 0, Math.PI * 2)
  context.fillStyle = accent
  context.fill()

  let textX = left + paddingX + dot + gap * 0.75
  context.font = `700 ${fontSize}px ${labelFont}`
  context.fillStyle = courtPalette.line
  context.fillText(typeText, textX, middle)
  if (speedText) {
    textX += typeWidth + gap
    context.font = `500 ${fontSize}px ${labelFont}`
    context.fillStyle = withAlpha(courtPalette.line, 0.72)
    context.fillText(speedText, textX, middle)
  }
  context.restore()
}
