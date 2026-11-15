import assert from 'node:assert/strict'
import test from 'node:test'
import { calculateMatchStatistics } from '../src/lib/matchStatistics.ts'

const frame = (index, timestamp, detections = []) => ({ frame_index: index, timestamp_seconds: timestamp, detections })
const player = (xMeters) => ({ class: 'player', confidence: 0.9, bbox: [0, 0, 10, 10], x_meters: xMeters, y_meters: 4 })

test('summarizes duration, player coverage and ball coverage', () => {
  const frames = [
    frame(0, 2, [player(4), { class: 'ball' }]),
    frame(1, 2.5, [player(18)]),
    frame(2, 3.25, [player(4), player(null)]),
  ]

  assert.deepEqual(calculateMatchStatistics(frames), {
    frameCount: 3,
    durationSeconds: 1.25,
    farPlayerFrames: 2,
    nearPlayerFrames: 1,
    ballFrames: 1,
  })
})

test('returns zeroed statistics for empty telemetry', () => {
  assert.deepEqual(calculateMatchStatistics([]), {
    frameCount: 0,
    durationSeconds: 0,
    farPlayerFrames: 0,
    nearPlayerFrames: 0,
    ballFrames: 0,
  })
})
