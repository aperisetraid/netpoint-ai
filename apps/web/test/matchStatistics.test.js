import assert from 'node:assert/strict'
import test from 'node:test'
import { calculateMatchStatistics, estimateHitCount } from '../src/matchStatistics.ts'

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

function makeBall(x, y = 60, confidence = 0.9, carriedForward = false) {
  return {
    class: 'ball',
    confidence,
    bbox: [x - 2, y - 2, x + 2, y + 2],
    x_meters: null,
    y_meters: null,
    carried_forward: carriedForward,
  }
}

function makePlayerBox() {
  return {
    class: 'player',
    confidence: 0.9,
    bbox: [115, 35, 175, 115],
    x_meters: 4,
    y_meters: 4,
  }
}

function makeRally(points, playerBox = makePlayerBox()) {
  return points.map(([x, y], index) => makeFrame(index, index / 30, [
    makeBall(x, y),
    playerBox,
  ]))
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
    estimatedHitCount: 0,
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
    estimatedHitCount: 0,
  })
})

test('estimates one hit for a sharp ball direction change near a player', () => {
  const frames = makeRally([[80, 60], [95, 60], [110, 60], [125, 60], [110, 60], [95, 60], [80, 60]])

  assert.equal(estimateHitCount(frames), 1)
})

test('ignores direction changes away from players and around detected bounces', () => {
  const points = [[80, 60], [95, 60], [110, 60], [125, 60], [110, 60], [95, 60], [80, 60]]
  const farPlayer = { ...makePlayerBox(), bbox: [400, 35, 460, 115] }
  const frames = makeRally(points, farPlayer)

  assert.equal(estimateHitCount(frames), 0)
  assert.equal(estimateHitCount(makeRally(points), [3 / 30]), 0)
})

test('does not estimate hits from carried-forward ball positions', () => {
  const frames = makeRally([[80, 60], [95, 60], [110, 60], [125, 60], [110, 60], [95, 60], [80, 60]])
  for (const frame of frames.slice(2, 5)) {
    frame.detections[0] = makeBall(frame.detections[0].bbox[0] + 2, 60, 0.9, true)
  }

  assert.equal(estimateHitCount(frames), 0)
})