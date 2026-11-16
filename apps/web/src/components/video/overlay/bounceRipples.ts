import { courtPalette, sideColors, withAlpha } from '../../../lib/palette.ts'
import type { BounceEvent } from '../../../services/api'
import { applyHomography, type Homography } from './geometry.ts'

export const rippleSeconds = 0.9
/** How long the landing mark stays on the court after the ripple. */
export const bounceMarkSeconds = 6
const markRadiusMeters = 0.16
const rippleStartRadiusMeters = 0.2
const rippleEndRadiusMeters = 1.5
const ringSegments = 40

function traceCourtCircle(
  context: CanvasRenderingContext2D,
  courtToImage: Homography,
  bounce: BounceEvent,
  radiusMeters: number,
): void {
  context.beginPath()
  for (let segment = 0; segment <= ringSegments; segment++) {
    const angle = (segment / ringSegments) * Math.PI * 2
    const [x, y] = applyHomography(
      courtToImage,
      bounce.x_meters + Math.cos(angle) * radiusMeters,
      bounce.y_meters + Math.sin(angle) * radiusMeters,
    )
    if (segment === 0) context.moveTo(x, y)
    else context.lineTo(x, y)
  }
  context.closePath()
}

/**
 * Draws one bounce `age` seconds after contact: rings expanding on the court plane, so they
 * follow the perspective of the video, and a landing mark that fades afterwards.
 */
export function drawBounce(
  context: CanvasRenderingContext2D,
  courtToImage: Homography,
  bounce: BounceEvent,
  age: number,
  unit: number,
): void {
  if (age < 0 || age > bounceMarkSeconds) return
  const color = sideColors[bounce.side]

  for (const delay of [0, 0.18]) {
    const progress = (age - delay) / (rippleSeconds - delay)
    if (progress < 0 || progress > 1) continue
    const eased = 1 - (1 - progress) ** 3
    traceCourtCircle(
      context,
      courtToImage,
      bounce,
      rippleStartRadiusMeters + (rippleEndRadiusMeters - rippleStartRadiusMeters) * eased,
    )
    context.strokeStyle = withAlpha(color, 0.9 * (1 - progress))
    context.lineWidth = (3.5 - 2 * progress) * unit
    context.stroke()
  }

  const markOpacity = Math.min(1, age / 0.08) * Math.min(1, (bounceMarkSeconds - age) / 1.5)
  const impact = age < 0.25 ? 1 + 0.8 * (1 - age / 0.25) : 1
  traceCourtCircle(context, courtToImage, bounce, markRadiusMeters * impact)
  context.fillStyle = withAlpha(color, 0.85 * markOpacity)
  context.fill()
  context.strokeStyle = withAlpha(courtPalette.line, 0.9 * markOpacity)
  context.lineWidth = 1.5 * unit
  context.stroke()
}
