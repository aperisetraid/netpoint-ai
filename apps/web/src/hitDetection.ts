import type { FrameTelemetry } from './services/api'

export interface EstimatedHit {
  timestamp: number
}

interface BallSample {
  frame: FrameTelemetry
  time: number
  x: number
  y: number
}

const minimumBallConfidence = 0.25
const velocityWindowSeconds = 0.25
const minimumWindowSamples = 3
const minimumDirectionSpeedWidthsPerSecond = 0.01
const minimumDirectionChangeDegrees = 60
const minimumVelocityChangeWidthsPerSecond = 0.1
const maximumTrajectoryGapSeconds = 0.35
const maximumBallImageSpeedWidthsPerSecond = 1.5
const playerReachHeightRatio = 0.4
const minimumPlayerReachPixels = 28
const hitCooldownSeconds = 0.5
const bounceExclusionSeconds = 0.1

function collectBallSamples(frames: FrameTelemetry[]): BallSample[] {
  const samples: BallSample[] = []

  for (const frame of frames) {
    const ball = frame.detections
      .filter((detection) => detection.class === 'ball'
        && !detection.carried_forward
        && detection.confidence >= minimumBallConfidence)
      .sort((first, second) => second.confidence - first.confidence)[0]
    if (!ball || !ball.bbox.every(Number.isFinite)) continue

    samples.push({
      frame,
      time: frame.timestamp_seconds,
      x: (ball.bbox[0] + ball.bbox[2]) / 2,
      y: (ball.bbox[1] + ball.bbox[3]) / 2,
    })
  }

  return samples
}

// Splits samples wherever time or position jumps, so detector switches are not read as ball motion.
function splitTrajectories(samples: BallSample[]): BallSample[][] {
  const trajectories: BallSample[][] = []
  let current: BallSample[] = []

  for (const sample of samples) {
    const previous = current.at(-1)
    if (previous) {
      const elapsed = sample.time - previous.time
      const width = sample.frame.image_width ?? 1920
      const maximumDistance = Math.max(12, width * maximumBallImageSpeedWidthsPerSecond * elapsed)
      if (
        elapsed <= 0
        || elapsed > maximumTrajectoryGapSeconds
        || Math.hypot(sample.x - previous.x, sample.y - previous.y) > maximumDistance
      ) {
        trajectories.push(current)
        current = []
      }
    }
    current.push(sample)
  }
  if (current.length) trajectories.push(current)

  return trajectories
}

// Least-squares velocity in pixels per second.
function fitVelocity(samples: BallSample[]): [number, number] {
  const meanTime = samples.reduce((sum, sample) => sum + sample.time, 0) / samples.length
  let timeVariance = 0
  let xCovariance = 0
  let yCovariance = 0
  for (const sample of samples) {
    const centered = sample.time - meanTime
    timeVariance += centered * centered
    xCovariance += centered * sample.x
    yCovariance += centered * sample.y
  }

  return timeVariance > 0 ? [xCovariance / timeVariance, yCovariance / timeVariance] : [0, 0]
}

function isWithinPlayerReach(sample: BallSample): boolean {
  return sample.frame.detections.some((detection) => {
    if (detection.class !== 'player' || detection.carried_forward) return false
    const [left, top, right, bottom] = detection.bbox
    const reach = Math.max(minimumPlayerReachPixels, (bottom - top) * playerReachHeightRatio)
    return sample.x >= left - reach && sample.x <= right + reach
      && sample.y >= top - reach && sample.y <= bottom + reach
  })
}

/**
 * Estimates racket contacts as abrupt changes of the ball's image-space velocity while it is
 * within reach of a player. It does not observe the racket, so the result is an estimate.
 */
export function detectEstimatedHits(
  frames: FrameTelemetry[],
  bounceTimestamps: number[] = [],
): EstimatedHit[] {
  const candidates: { time: number; score: number }[] = []

  for (const trajectory of splitTrajectories(collectBallSamples(frames))) {
    for (const contact of trajectory) {
      const before = trajectory.filter(
        (sample) => sample.time <= contact.time && contact.time - sample.time <= velocityWindowSeconds,
      )
      const after = trajectory.filter(
        (sample) => sample.time >= contact.time && sample.time - contact.time <= velocityWindowSeconds,
      )
      if (before.length < minimumWindowSamples || after.length < minimumWindowSamples) continue

      const width = contact.frame.image_width ?? 1920
      const [beforeX, beforeY] = fitVelocity(before)
      const [afterX, afterY] = fitVelocity(after)
      const beforeSpeed = Math.hypot(beforeX, beforeY)
      const afterSpeed = Math.hypot(afterX, afterY)
      const velocityChange = Math.hypot(afterX - beforeX, afterY - beforeY)
      const minimumDirectionSpeed = width * minimumDirectionSpeedWidthsPerSecond
      if (
        velocityChange < width * minimumVelocityChangeWidthsPerSecond
        || beforeSpeed < minimumDirectionSpeed
        || afterSpeed < minimumDirectionSpeed
      ) {
        continue
      }

      const cosine = (beforeX * afterX + beforeY * afterY) / (beforeSpeed * afterSpeed)
      const directionChange = Math.acos(Math.max(-1, Math.min(1, cosine))) * 180 / Math.PI
      if (directionChange < minimumDirectionChangeDegrees || !isWithinPlayerReach(contact)) continue
      if (bounceTimestamps.some((bounce) => Math.abs(bounce - contact.time) <= bounceExclusionSeconds)) continue

      candidates.push({ time: contact.time, score: velocityChange })
    }
  }

  const hits: EstimatedHit[] = []
  let cluster: { time: number; score: number }[] = []
  function flushCluster() {
    if (!cluster.length) return
    const strongest = cluster.reduce((best, candidate) => candidate.score > best.score ? candidate : best)
    hits.push({ timestamp: strongest.time })
    cluster = []
  }

  for (const candidate of candidates.sort((first, second) => first.time - second.time)) {
    const last = cluster.at(-1)
    if (last && candidate.time - last.time > hitCooldownSeconds) flushCluster()
    cluster.push(candidate)
  }
  flushCluster()

  return hits
}
