import assert from 'node:assert/strict'
import test from 'node:test'
import { calculateMatchStatistics } from '../src/matchStatistics.ts'

function makeFrame(frameIndex, timestamp, detections = []) {
  return {
    frame_index: frameIndex,
    timestamp_seconds: timestamp,
    detections,
  }
}

function makePlayer(xMeters) {
  return {
    class: 'player',
    confidence: 0.9,
    bbox: [0, 0, 10, 10],
    x_meters: xMeters,
    y_meters: 4,
  }
}

test('summarizes duration, player coverage, ball coverage, and bounces', () => {
  const frames = [
    makeFrame(0, 2, [makePlayer(4), { class: 'ball' }]),
    makeFrame(1, 2.5, [makePlayer(18)]),
    makeFrame(2, 3.25, [makePlayer(4), makePlayer(null)]),
  ]

  assert.deepEqual(calculateMatchStatistics(frames, 2), {
    frameCount: 3,
    durationSeconds: 1.25,
    farPlayerFrames: 2,
    nearPlayerFrames: 1,
    ballFrames: 1,
    bounceCount: 2,
  })
})

test('returns zeroed statistics for empty telemetry', () => {
  assert.deepEqual(calculateMatchStatistics([], 0), {
    frameCount: 0,
    durationSeconds: 0,
    farPlayerFrames: 0,
    nearPlayerFrames: 0,
    ballFrames: 0,
    bounceCount: 0,
  })
})