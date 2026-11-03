import assert from 'node:assert/strict'
import test from 'node:test'
import { detectBounces, getVisibleBounces } from '../src/bounceDetection.ts'

function makeFrames(positions) {
  return positions.map((position, index) => ({
    frame_index: index,
    timestamp_seconds: index / 30,
    image_width: 1000,
    image_height: 720,
    detections: position === null ? [] : [{
      class: 'ball',
      confidence: 0.9,
      bbox: [position.x, position.y - 5, position.x + 5, position.y],
      x_meters: 10,
      y_meters: 4,
    }],
  }))
}

const positions = (values) => values.map((y) => y === null ? null : { x: 100, y })

test('detects a vertical reversal and records its position and time', () => {
  const bounces = detectBounces(makeFrames(positions([90, 94, 100, 97, 94])))
  assert.deepEqual(bounces, [{ timestamp: 2 / 30, x: 10, y: 4 }])
})

test('only shows bounces reached by the current playback frame', () => {
  const bounces = [
    { timestamp: 0.2, x: 4, y: 3 },
    { timestamp: 0.5, x: 8, y: 6 },
    { timestamp: 1.2, x: 12, y: 5 },
  ]

  assert.deepEqual(getVisibleBounces(bounces, 0), [])
  assert.deepEqual(getVisibleBounces(bounces, 0.5), bounces.slice(0, 2))
})

test('does not count uninterrupted motion or stationary noise', () => {
  assert.deepEqual(detectBounces(makeFrames(positions([90, 92, 94, 96, 98]))), [])
  assert.deepEqual(detectBounces(makeFrames(positions([100, 101, 102, 101, 100]))), [])
})

test('does not join trajectories across long gaps or spatial jumps', () => {
  assert.deepEqual(detectBounces(makeFrames(positions([90, 94, null, null, null, null, null, 100, 97, 94]))), [])
  assert.deepEqual(detectBounces(makeFrames([{ x: 100, y: 90 }, { x: 100, y: 94 }, { x: 500, y: 100 }, { x: 500, y: 97 }, { x: 500, y: 94 }])), [])
})

test('allows a flat peak without counting it twice', () => {
  const bounces = detectBounces(makeFrames(positions([90, 94, 100, 100, 94, 90])))
  assert.equal(bounces.length, 1)
  assert.equal(bounces[0].timestamp, 2 / 30)
})

test('detects a gradual reversal using a longer trajectory', () => {
  const bounces = detectBounces(makeFrames(positions([94, 95, 96, 97, 98, 99, 100, 99, 98, 97, 96, 95, 94])))
  assert.equal(bounces.length, 1)
  assert.equal(bounces[0].timestamp, 6 / 30)
})

test('does not count a reversal at a player as a bounce', () => {
  const frames = makeFrames(positions([90, 94, 100, 97, 94]))
  for (const frame of frames) {
    frame.detections.push({
      class: 'player', confidence: 0.9, bbox: [80, 60, 130, 110], x_meters: 10, y_meters: 4,
    })
  }
  assert.deepEqual(detectBounces(frames), [])
})

test('does not count a vertical peak when horizontal motion reverses too', () => {
  const frames = makeFrames(positions([90, 94, 100, 97, 94]))
  const horizontalPositions = [100, 120, 140, 120, 100]
  for (const [index, frame] of frames.entries()) {
    const ball = frame.detections[0]
    ball.bbox = [horizontalPositions[index], ball.bbox[1], horizontalPositions[index] + 5, ball.bbox[3]]
  }

  assert.deepEqual(detectBounces(frames), [])
})

test('rejects a trajectory spike observed in the test video', () => {
  const frames = makeFrames([
    { x: 1373, y: 828 }, { x: 1388, y: 831 }, { x: 1316, y: 942 },
    { x: 1421, y: 848 }, { x: 1442, y: 853 },
  ])
  for (const frame of frames) {
    frame.image_width = 1920
    frame.image_height = 1080
  }
  assert.deepEqual(detectBounces(frames), [])
})

test('detects a continuous bounce trajectory observed in the test video', () => {
  const frames = makeFrames([
    { x: 1117, y: 374 }, { x: 1123, y: 381 }, { x: 1128, y: 386 },
    { x: 1132, y: 376 }, { x: 1136, y: 366 },
  ])
  for (const frame of frames) {
    frame.image_width = 1920
    frame.image_height = 1080
  }
  assert.equal(detectBounces(frames)[0]?.timestamp, 2 / 30)
})

test('preserves a bounce when the ball is briefly missing after contact', () => {
  const frames = makeFrames(positions([90, 94, 100, null, 96, 92]))
  assert.equal(detectBounces(frames)[0]?.timestamp, 2 / 30)
})

test('does not infer a bounce when a trajectory resumes without observing descent', () => {
  const frames = makeFrames(positions([90, ...Array(11).fill(null), 100, 94, 88]))
  for (const frame of frames.slice(12)) {
    const ball = frame.detections[0]
    ball.x_meters = 22.9
    ball.y_meters = 4.34
  }

  assert.deepEqual(detectBounces(frames), [])
})

test('detects a bounce with observed descent and ascent after a long gap', () => {
  const frames = makeFrames(positions([
    90, ...Array(12).fill(null), 90, 94, 100, 97, 94,
  ]))
  for (const frame of frames.slice(13)) {
    frame.detections[0].x_meters = 22.9
    frame.detections[0].y_meters = 4.34
  }

  assert.deepEqual(detectBounces(frames), [{ timestamp: 15 / 30, x: 22.9, y: 4.34 }])
})

test('does not infer a bounce after missed frames without observed descent', () => {
  const frames = makeFrames([
    { x: 900, y: 330 }, null, null,
    { x: 512, y: 522 }, { x: 513, y: 515 }, { x: 514, y: 505 },
  ])
  for (const frame of frames.slice(3)) {
    frame.detections[0].x_meters = 22.9
    frame.detections[0].y_meters = 4.34
  }

  assert.deepEqual(detectBounces(frames), [])
})

test('does not infer a bounce after an abrupt spatial tracking switch', () => {
  const frames = makeFrames([
    { x: 100, y: 90 }, { x: 100, y: 94 }, { x: 900, y: 100 },
    { x: 900, y: 94 }, { x: 900, y: 88 },
  ])

  assert.deepEqual(detectBounces(frames), [])
})

test('does not plot bounce candidates outside the court', () => {
  const frames = makeFrames(positions([90, 94, 100, 97, 94]))
  for (const frame of frames) {
    frame.detections[0].x_meters = 24.2
  }

  assert.deepEqual(detectBounces(frames), [])
})