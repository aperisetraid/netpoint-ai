import type { FrameTelemetry } from './services/api'

const courtLengthMeters = 23.77

export interface MatchStatistics {
  frameCount: number
  durationSeconds: number
  farPlayerFrames: number
  nearPlayerFrames: number
  ballFrames: number
  bounceCount: number
}

export function calculateMatchStatistics(
  frames: FrameTelemetry[],
  bounceCount: number,
): MatchStatistics {
  let farPlayerFrames = 0
  let nearPlayerFrames = 0
  let ballFrames = 0

  for (const frame of frames) {
    const players = frame.detections.filter(
      (detection) => detection.class === 'player'
        && typeof detection.x_meters === 'number'
        && Number.isFinite(detection.x_meters),
    )
    if (players.some((player) => player.x_meters! < courtLengthMeters / 2)) {
      farPlayerFrames++
    }
    if (players.some((player) => player.x_meters! >= courtLengthMeters / 2)) {
      nearPlayerFrames++
    }
    if (frame.detections.some((detection) => detection.class === 'ball')) {
      ballFrames++
    }
  }

  const timestamps = frames
    .map((frame) => frame.timestamp_seconds)
    .filter(Number.isFinite)
  const durationSeconds = timestamps.length
    ? Math.max(...timestamps) - Math.min(...timestamps)
    : 0

  return {
    frameCount: frames.length,
    durationSeconds,
    farPlayerFrames,
    nearPlayerFrames,
    ballFrames,
    bounceCount,
  }
}