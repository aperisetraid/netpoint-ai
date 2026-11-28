import assert from 'node:assert/strict'
import test from 'node:test'
import { findFrameAt, frameStepTime } from '../src/lib/frameLookup.ts'

// 25 fps: one frame every 0.04 s.
const frames = [0, 1, 2, 3].map((index) => ({ frame_index: index, timestamp_seconds: index * 0.04 }))

test('steps to the middle of the previous or next frame', () => {
  assert.ok(Math.abs(frameStepTime(frames, 1, 1) - 0.1) < 1e-9)
  assert.ok(Math.abs(frameStepTime(frames, 2, -1) - 0.06) < 1e-9)
  // The last frame has no next one: its length comes from the one before.
  assert.ok(Math.abs(frameStepTime(frames, 2, 1) - 0.14) < 1e-9)
})

test('a seek that lands a little early still shows the frame it asked for', () => {
  const time = frameStepTime(frames, 1, 1)
  assert.equal(findFrameAt(frames, time - 0.001).frame_index, 2)
})

test('stops at either end and with an unknown frame', () => {
  assert.equal(frameStepTime(frames, 0, -1), null)
  assert.equal(frameStepTime(frames, 3, 1), null)
  assert.equal(frameStepTime(frames, 9, 1), null)
})
