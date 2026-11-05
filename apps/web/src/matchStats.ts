import type { Bounce } from './bounceDetection.ts'
import type { EstimatedHit } from './hitDetection.ts'
import type { DetectionTelemetry, FrameTelemetry } from './services/api'

export type PlayerSide = 'far' | 'near'
export type ShotType = 'serve' | 'volley' | 'forehand' | 'backhand'
export type Handedness = 'right' | 'left'

export interface CourtPosition {
  x: number
  y: number
}

export interface ShotRecord {
  timestamp: number
  frameIndex: number
  pointIndex: number
  player: PlayerSide
  type: ShotType
  speedKmh: number | null
  ballPosition: CourtPosition | null
  playerPosition: CourtPosition
}

export interface ShotSummary {
  totalShots: number
  measuredShots: number
  maxSpeedKmh: number | null
  averageSpeedKmh: number | null
  byType: Record<ShotType, number>
}

export interface MatchShotStatistics {
  shots: ShotRecord[]
  match: ShotSummary & { pointCount: number }
  byPlayer: Record<PlayerSide, ShotSummary>
}

export interface ShotStatisticsOptions {
  handedness?: Partial<Record<PlayerSide, Handedness>>
}

const courtLengthMeters = 23.77
const netPositionMeters = courtLengthMeters / 2
const kmhPerMeterPerSecond = 3.6
const speedSegmentCount = 3
const speedWindowSeconds = 0.25
const maximumSegmentGapSeconds = 0.12
const maximumPlausibleSpeedKmh = 265
const pointGapSeconds = 4
const serveBaselineToleranceMeters = 1
const volleyMaximumNetDistanceMeters = 6.4
const frameMatchToleranceSeconds = 0.05

function isFiniteNumber(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function metricPosition(detection: DetectionTelemetry): CourtPosition | null {
  return isFiniteNumber(detection.x_meters) && isFiniteNumber(detection.y_meters)
    ? { x: detection.x_meters, y: detection.y_meters }
    : null
}

function sideOf(xMeters: number): PlayerSide {
  return xMeters < netPositionMeters ? 'far' : 'near'
}

function centerX(bbox: DetectionTelemetry['bbox']): number {
  return (bbox[0] + bbox[2]) / 2
}

function bestBall(frame: FrameTelemetry, requirePosition: boolean): DetectionTelemetry | undefined {
  let best: DetectionTelemetry | undefined
  for (const detection of frame.detections) {
    if (
      detection.class !== 'ball'
      || detection.carried_forward
      || !detection.bbox.every(Number.isFinite)
      || (requirePosition && !metricPosition(detection))
    ) {
      continue
    }
    if (!best || detection.confidence > best.confidence) best = detection
  }
  return best
}

function distanceToBox(pointX: number, pointY: number, bbox: DetectionTelemetry['bbox']): number {
  const dx = Math.max(bbox[0] - pointX, 0, pointX - bbox[2])
  const dy = Math.max(bbox[1] - pointY, 0, pointY - bbox[3])
  return Math.hypot(dx, dy)
}

function findHitter(
  frame: FrameTelemetry,
  ball: DetectionTelemetry,
): { detection: DetectionTelemetry; position: CourtPosition } | undefined {
  const ballX = centerX(ball.bbox)
  const ballY = (ball.bbox[1] + ball.bbox[3]) / 2
  let best: { detection: DetectionTelemetry; position: CourtPosition; distance: number } | undefined

  for (const detection of frame.detections) {
    if (detection.class !== 'player' || !detection.bbox.every(Number.isFinite)) continue
    const position = metricPosition(detection)
    if (!position) continue
    const distance = distanceToBox(ballX, ballY, detection.bbox)
    if (!best || distance < best.distance) best = { detection, position, distance }
  }
  return best
}

function findFrameIndex(frames: FrameTelemetry[], timestamp: number): number {
  let low = 0
  let high = frames.length - 1
  while (low < high) {
    const middle = (low + high) >> 1
    if (frames[middle].timestamp_seconds < timestamp) low = middle + 1
    else high = middle
  }
  const candidates = [low - 1, low].filter((index) => index >= 0 && index < frames.length)
  let bestIndex = -1
  let bestDifference = frameMatchToleranceSeconds
  for (const index of candidates) {
    const difference = Math.abs(frames[index].timestamp_seconds - timestamp)
    if (difference <= bestDifference) {
      bestIndex = index
      bestDifference = difference
    }
  }
  return bestIndex
}

function median(values: number[]): number {
  const sorted = [...values].sort((first, second) => first - second)
  const middle = sorted.length >> 1
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

// Median of segment speeds over the hit frame and the next few ball samples, discarding gaps and impossible jumps.
export function estimateShotSpeedKmh(frames: FrameTelemetry[], startIndex: number): number | null {
  const startTime = frames[startIndex]?.timestamp_seconds
  if (!isFiniteNumber(startTime)) return null

  const samples: { time: number; position: CourtPosition }[] = []
  for (let index = startIndex; index < frames.length && samples.length <= speedSegmentCount; index++) {
    const frame = frames[index]
    if (frame.timestamp_seconds - startTime > speedWindowSeconds) break
    const ball = bestBall(frame, true)
    const position = ball ? metricPosition(ball) : null
    if (position) samples.push({ time: frame.timestamp_seconds, position })
  }

  const speeds: number[] = []
  for (let index = 1; index < samples.length; index++) {
    const previous = samples[index - 1]
    const current = samples[index]
    const elapsed = current.time - previous.time
    if (elapsed <= 0 || elapsed > maximumSegmentGapSeconds) continue
    const distance = Math.hypot(current.position.x - previous.position.x, current.position.y - previous.position.y)
    const speed = (distance / elapsed) * kmhPerMeterPerSecond
    if (speed <= maximumPlausibleSpeedKmh) speeds.push(speed)
  }
  return speeds.length ? median(speeds) : null
}

function isBehindBaseline(side: PlayerSide, position: CourtPosition): boolean {
  return side === 'far'
    ? position.x <= serveBaselineToleranceMeters
    : position.x >= courtLengthMeters - serveBaselineToleranceMeters
}

function classifyGroundstroke(
  side: PlayerSide,
  handedness: Handedness,
  ballCenterX: number,
  playerBbox: DetectionTelemetry['bbox'],
): 'forehand' | 'backhand' {
  const playerCenterX = centerX(playerBbox)
  // Assumes a broadcast camera behind the near baseline: the near player shows their back, the far player faces it.
  const ballOnPlayerRight = side === 'near' ? ballCenterX >= playerCenterX : ballCenterX <= playerCenterX
  return ballOnPlayerRight === (handedness === 'right') ? 'forehand' : 'backhand'
}

function emptyByType(): Record<ShotType, number> {
  return { serve: 0, volley: 0, forehand: 0, backhand: 0 }
}

function summarize(shots: ShotRecord[]): ShotSummary {
  const speeds = shots.map((shot) => shot.speedKmh).filter(isFiniteNumber)
  const byType = emptyByType()
  for (const shot of shots) byType[shot.type]++
  return {
    totalShots: shots.length,
    measuredShots: speeds.length,
    maxSpeedKmh: speeds.length ? Math.max(...speeds) : null,
    averageSpeedKmh: speeds.length ? speeds.reduce((sum, speed) => sum + speed, 0) / speeds.length : null,
    byType,
  }
}

export function calculateShotStatistics(
  frames: FrameTelemetry[],
  bounces: Bounce[],
  hits: EstimatedHit[],
  options: ShotStatisticsOptions = {},
): MatchShotStatistics {
  const orderedFrames = frames
    .filter((frame) => Number.isFinite(frame.timestamp_seconds))
    .sort((first, second) => first.timestamp_seconds - second.timestamp_seconds)
  const orderedBounces = bounces
    .filter((bounce) => [bounce.timestamp, bounce.x, bounce.y].every(Number.isFinite))
    .sort((first, second) => first.timestamp - second.timestamp)
  const orderedHits = hits
    .filter((hit) => Number.isFinite(hit.timestamp))
    .sort((first, second) => first.timestamp - second.timestamp)
  const handedness: Record<PlayerSide, Handedness> = { far: 'right', near: 'right', ...options.handedness }

  const shots: ShotRecord[] = []
  let pointIndex = -1
  let previousShot: ShotRecord | undefined

  for (const hit of orderedHits) {
    const frameIndex = findFrameIndex(orderedFrames, hit.timestamp)
    if (frameIndex < 0) continue
    const frame = orderedFrames[frameIndex]
    const ball = bestBall(frame, false)
    if (!ball) continue
    const hitter = findHitter(frame, ball)
    if (!hitter) continue

    const player = sideOf(hitter.position.x)
    const startsPoint = !previousShot || frame.timestamp_seconds - previousShot.timestamp > pointGapSeconds
    if (startsPoint) pointIndex++

    let type: ShotType
    if (startsPoint && isBehindBaseline(player, hitter.position)) {
      type = 'serve'
    } else if (
      previousShot
      && !startsPoint
      && Math.abs(hitter.position.x - netPositionMeters) <= volleyMaximumNetDistanceMeters
      && !orderedBounces.some((bounce) => bounce.timestamp > previousShot!.timestamp
        && bounce.timestamp < frame.timestamp_seconds
        && sideOf(bounce.x) === player)
    ) {
      type = 'volley'
    } else {
      type = classifyGroundstroke(player, handedness[player], centerX(ball.bbox), hitter.detection.bbox)
    }

    const shot: ShotRecord = {
      timestamp: frame.timestamp_seconds,
      frameIndex: frame.frame_index,
      pointIndex,
      player,
      type,
      speedKmh: estimateShotSpeedKmh(orderedFrames, frameIndex),
      ballPosition: metricPosition(ball),
      playerPosition: hitter.position,
    }
    shots.push(shot)
    previousShot = shot
  }

  return {
    shots,
    match: { ...summarize(shots), pointCount: pointIndex + 1 },
    byPlayer: {
      far: summarize(shots.filter((shot) => shot.player === 'far')),
      near: summarize(shots.filter((shot) => shot.player === 'near')),
    },
  }
}
