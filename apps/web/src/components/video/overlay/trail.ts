import { findIndexAtOrBefore } from '../../../lib/frameLookup.ts'
import type { FrameTelemetry } from '../../../services/api'

export interface BallTrack {
  /** Timestamp of every frame, ascending. */
  times: Float64Array
  /** Ball centre per frame in image pixels; NaN where the ball was not detected. */
  x: Float32Array
  y: Float32Array
}

export interface TrailPoint {
  x: number
  y: number
  /** Seconds before the current playback time. */
  age: number
}

export const trailSeconds = 0.6
const maximumGapSeconds = 0.35
const maximumSpeedWidthsPerSecond = 1.5

export function buildBallTrack(frames: FrameTelemetry[]): BallTrack {
  const track: BallTrack = {
    times: new Float64Array(frames.length),
    x: new Float32Array(frames.length).fill(NaN),
    y: new Float32Array(frames.length).fill(NaN),
  }
  frames.forEach((frame, index) => {
    track.times[index] = frame.timestamp_seconds
    let confidence = -Infinity
    for (const detection of frame.detections) {
      if (detection.class !== 'ball' || detection.carried_forward || detection.confidence <= confidence) continue
      confidence = detection.confidence
      track.x[index] = (detection.bbox[0] + detection.bbox[2]) / 2
      track.y[index] = (detection.bbox[1] + detection.bbox[3]) / 2
    }
  })
  return track
}

function isContinuous(track: BallTrack, earlier: number, later: number, imageWidth: number): boolean {
  const elapsed = track.times[later] - track.times[earlier]
  return elapsed > 0
    && elapsed <= maximumGapSeconds
    && Math.hypot(track.x[later] - track.x[earlier], track.y[later] - track.y[earlier])
      <= Math.max(12, imageWidth * maximumSpeedWidthsPerSecond * elapsed)
}

/**
 * Recent ball positions, oldest first, ending at the position interpolated for `time`.
 * The trail stops at the first tracking gap or jump so unrelated detections are never joined.
 */
export function trailAt(track: BallTrack, time: number, imageWidth: number): TrailPoint[] {
  const current = findIndexAtOrBefore(track.times, time)
  if (current < 0) return []

  let newest = current
  while (newest >= 0 && Number.isNaN(track.x[newest])) newest--
  if (newest < 0 || time - track.times[newest] > maximumGapSeconds) return []

  const points: TrailPoint[] = []
  let next = current + 1
  while (next < track.times.length && Number.isNaN(track.x[next])) next++
  if (newest === current && next < track.times.length && isContinuous(track, newest, next, imageWidth)) {
    const fraction = (time - track.times[newest]) / (track.times[next] - track.times[newest])
    points.push({
      x: track.x[newest] + (track.x[next] - track.x[newest]) * fraction,
      y: track.y[newest] + (track.y[next] - track.y[newest]) * fraction,
      age: 0,
    })
  }

  let later = -1
  for (let index = newest; index >= 0; index--) {
    const age = time - track.times[index]
    if (age > trailSeconds) break
    if (Number.isNaN(track.x[index])) continue
    if (later >= 0 && !isContinuous(track, index, later, imageWidth)) break
    points.push({ x: track.x[index], y: track.y[index], age })
    later = index
  }
  return points.reverse()
}

/** Draws the trail in image coordinates; `unit` is the image-space length of one CSS pixel. */
export function drawTrail(context: CanvasRenderingContext2D, points: TrailPoint[], unit: number): void {
  if (!points.length) return
  // Stretches meet at segment midpoints and bend through the samples, which rounds the corners;
  // each one is stroked on its own because a canvas path cannot fade along its length.
  context.lineCap = 'butt'
  const last = points.length - 1
  const middle = (index: number): [number, number] => [
    (points[index - 1].x + points[index].x) / 2,
    (points[index - 1].y + points[index].y) / 2,
  ]
  const stroke = (age: number) => {
    const freshness = 1 - Math.min(1, age / trailSeconds)
    context.strokeStyle = `rgba(190, 242, 100, ${0.08 + 0.8 * freshness * freshness})`
    context.lineWidth = (1.5 + 4.5 * freshness) * unit
    context.stroke()
  }

  if (last >= 1) {
    context.beginPath()
    context.moveTo(points[0].x, points[0].y)
    context.lineTo(...middle(1))
    stroke(points[0].age)
    for (let index = 1; index < last; index++) {
      context.beginPath()
      context.moveTo(...middle(index))
      context.quadraticCurveTo(points[index].x, points[index].y, ...middle(index + 1))
      stroke(points[index].age)
    }
    context.beginPath()
    context.moveTo(...middle(last))
    context.lineTo(points[last].x, points[last].y)
    stroke(points[last].age)
  }

  const head = points[points.length - 1]
  const headFreshness = 1 - Math.min(1, head.age / trailSeconds)
  context.beginPath()
  context.arc(head.x, head.y, 9 * unit, 0, Math.PI * 2)
  context.fillStyle = `rgba(190, 242, 100, ${0.22 * headFreshness})`
  context.fill()
  context.beginPath()
  context.arc(head.x, head.y, 4 * unit, 0, Math.PI * 2)
  context.fillStyle = `rgba(247, 254, 231, ${0.95 * headFreshness})`
  context.fill()
}
