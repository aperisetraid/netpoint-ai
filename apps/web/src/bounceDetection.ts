import type { DetectionTelemetry, FrameTelemetry } from './services/api'

export interface Bounce {
  timestamp: number
  x: number
  y: number
}

interface BallSample {
  frame: FrameTelemetry
  ball: DetectionTelemetry
  imageY: number
}

const courtLengthMeters = 23.77
const courtWidthMeters = 10.97
const maxTrajectoryGapSeconds = 0.35
const maxBallImageSpeedPerSecond = 1.5

export function detectBounces(frames: FrameTelemetry[]): Bounce[] {
  const bounces: Bounce[] = []
  let samples: BallSample[] = []

  function addBounce(candidate: BallSample) {
    if (bounces.length && candidate.frame.timestamp_seconds - bounces[bounces.length - 1].timestamp < 0.3) return

    bounces.push({
      timestamp: candidate.frame.timestamp_seconds,
      x: candidate.ball.x_meters!,
      y: candidate.ball.y_meters!,
    })
  }

  function overlapsPlayer(sample: BallSample): boolean {
    const centerX = (sample.ball.bbox[0] + sample.ball.bbox[2]) / 2
    const centerY = (sample.ball.bbox[1] + sample.ball.bbox[3]) / 2
    return sample.frame.detections.some((detection) => detection.class === 'player'
      && centerX >= detection.bbox[0] && centerX <= detection.bbox[2]
      && centerY >= detection.bbox[1] && centerY <= detection.bbox[3])
  }

  function processSamples() {
    for (let index = 2; index < samples.length - 2; index++) {
      const candidate = samples[index]
      if (candidate.imageY <= samples[index - 1].imageY || candidate.imageY < samples[index + 1].imageY) continue

      let beforeCount = 0
      let afterCount = 0
      let beforeMinY = candidate.imageY
      let afterMinY = candidate.imageY
      for (let previousIndex = index - 1; previousIndex >= 0; previousIndex--) {
        const sample = samples[previousIndex]
        if (candidate.frame.timestamp_seconds - sample.frame.timestamp_seconds > 0.2) break
        beforeCount++
        beforeMinY = Math.min(beforeMinY, sample.imageY)
      }
      for (let nextIndex = index + 1; nextIndex < samples.length; nextIndex++) {
        const sample = samples[nextIndex]
        if (sample.frame.timestamp_seconds - candidate.frame.timestamp_seconds > 0.2) break
        afterCount++
        afterMinY = Math.min(afterMinY, sample.imageY)
      }
      if (beforeCount < 2 || afterCount < 2) continue
      const threshold = Math.max(2, (candidate.frame.image_height ?? 720) * 0.003)
      if (candidate.imageY - beforeMinY < threshold || candidate.imageY - afterMinY < threshold) continue

      const centerX = (candidate.ball.bbox[0] + candidate.ball.bbox[2]) / 2
      const previous = samples[index - 1]
      const next = samples[index + 1]
      const previousX = (previous.ball.bbox[0] + previous.ball.bbox[2]) / 2
      const nextX = (next.ball.bbox[0] + next.ball.bbox[2]) / 2
      const beforeX = (samples[index - 2].ball.bbox[0] + samples[index - 2].ball.bbox[2]) / 2
      const afterX = (samples[index + 2].ball.bbox[0] + samples[index + 2].ball.bbox[2]) / 2
      const incomingHorizontalMotion = centerX - beforeX
      const outgoingHorizontalMotion = afterX - centerX
      if (incomingHorizontalMotion * outgoingHorizontalMotion < 0) continue

      const fraction = (candidate.frame.timestamp_seconds - previous.frame.timestamp_seconds)
        / (next.frame.timestamp_seconds - previous.frame.timestamp_seconds)
      const expectedX = previousX + (nextX - previousX) * fraction
      if (Math.abs(centerX - expectedX) > Math.max(12, (candidate.frame.image_width ?? 1920) * 0.015)) continue
      if (overlapsPlayer(candidate)) continue
      addBounce(candidate)
    }
    samples = []
  }

  for (const frame of frames) {
    const ball = frame.detections
      .filter((detection) => detection.class === 'ball' && !detection.carried_forward
        && detection.x_meters !== null && detection.y_meters !== null
        && Number.isFinite(detection.x_meters) && Number.isFinite(detection.y_meters)
        && detection.x_meters >= 0 && detection.x_meters <= courtLengthMeters
        && detection.y_meters >= 0 && detection.y_meters <= courtWidthMeters)
      .sort((first, second) => second.confidence - first.confidence)[0]
    if (!ball) {
      continue
    }

    const sample = { frame, ball, imageY: ball.bbox[3] }
    const previous = samples.at(-1)
    if (previous) {
      const elapsed = frame.timestamp_seconds - previous.frame.timestamp_seconds
      const horizontalDistance = (ball.bbox[0] + ball.bbox[2] - previous.ball.bbox[0] - previous.ball.bbox[2]) / 2
      const verticalDistance = sample.imageY - previous.imageY
      const maxDistance = Math.max(12, (frame.image_width ?? 1920) * maxBallImageSpeedPerSecond * elapsed)
      if (elapsed > maxTrajectoryGapSeconds || elapsed <= 0 || Math.hypot(horizontalDistance, verticalDistance) > maxDistance) {
        processSamples()
        samples = []
        if (elapsed > maxTrajectoryGapSeconds) {
          samples.push(sample)
          continue
        }
      }
    }
    samples.push(sample)
  }
  processSamples()
  return bounces
}

export function getVisibleBounces(bounces: Bounce[], currentTime: number): Bounce[] {
  return bounces.filter((bounce) => bounce.timestamp <= currentTime)
}