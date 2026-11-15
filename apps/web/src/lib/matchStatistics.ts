import type { FrameTelemetry } from '../services/api'

const courtLengthMeters = 23.77

export interface MatchStatistics {
  frameCount: number
  durationSeconds: number
  farPlayerFrames: number
  nearPlayerFrames: number
  ballFrames: number
}

export function calculateMatchStatistics(frames: FrameTelemetry[]): MatchStatistics {
  let farPlayerFrames = 0
  let nearPlayerFrames = 0
  let ballFrames = 0
  let firstTimestamp = Infinity
  let lastTimestamp = -Infinity

  for (const frame of frames) {
    const players = frame.detections.filter(
      (detection) => detection.class === 'player'
        && typeof detection.x_meters === 'number'
        && Number.isFinite(detection.x_meters),
    )
    if (players.some((player) => player.x_meters! < courtLengthMeters / 2)) farPlayerFrames++
    if (players.some((player) => player.x_meters! >= courtLengthMeters / 2)) nearPlayerFrames++
    if (frame.detections.some((detection) => detection.class === 'ball')) ballFrames++
    if (Number.isFinite(frame.timestamp_seconds)) {
      firstTimestamp = Math.min(firstTimestamp, frame.timestamp_seconds)
      lastTimestamp = Math.max(lastTimestamp, frame.timestamp_seconds)
    }
  }

  return {
    frameCount: frames.length,
    durationSeconds: lastTimestamp >= firstTimestamp ? lastTimestamp - firstTimestamp : 0,
    farPlayerFrames,
    nearPlayerFrames,
    ballFrames,
  }
}
