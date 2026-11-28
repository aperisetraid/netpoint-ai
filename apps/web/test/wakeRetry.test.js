import assert from 'node:assert/strict'
import test from 'node:test'
import { shouldKeepWaking, WAKE_WINDOW_MS, wakeRetryDelay } from '../src/lib/wakeRetry.ts'

test('retries while a sleeping service wakes, but not on real answers', () => {
  // The API answers 502 while the vision service wakes; no status means it could not connect at all.
  assert.equal(shouldKeepWaking(502, 0), true)
  assert.equal(shouldKeepWaking(503, 30_000), true)
  assert.equal(shouldKeepWaking(undefined, 10_000), true)
  // A 4xx is an answer, not a sleeping server.
  assert.equal(shouldKeepWaking(404, 0), false)
  assert.equal(shouldKeepWaking(400, 0), false)
})

test('gives up once the wake window is over', () => {
  assert.equal(shouldKeepWaking(502, WAKE_WINDOW_MS - 1), true)
  assert.equal(shouldKeepWaking(502, WAKE_WINDOW_MS), false)
  assert.equal(shouldKeepWaking(undefined, WAKE_WINDOW_MS + 5_000), false)
})

test('backs off a little and then retries at a steady pace', () => {
  assert.deepEqual([0, 1, 2, 3, 10].map(wakeRetryDelay), [2_000, 3_000, 5_000, 5_000, 5_000])
  assert.equal(wakeRetryDelay(-1), 2_000)
})
