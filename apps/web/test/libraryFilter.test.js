import assert from 'node:assert/strict'
import test from 'node:test'
import { filterLibrary, formatDuration, formatRelativeDate } from '../src/lib/libraryFilter.ts'

const match = (id, title, createdAt, extra = {}) => ({
  id, title, createdAt, source: 'upload', videoFilename: `${id}.mp4`, hasVideo: true, fps: 25, width: 1920,
  height: 1080, frameCount: 100, durationSeconds: 4, calibrated: true, hitCount: 0, bounceCount: 0,
  maxSpeedKmh: null, ...extra,
})

const matches = [
  match('a', 'Final Copa', '2026-11-10T10:00:00Z', { durationSeconds: 30, hitCount: 2 }),
  match('b', 'Entrenamiento revés', '2026-11-14T10:00:00Z', { durationSeconds: 10, hitCount: 9 }),
  match('c', 'Semifinal', '2026-11-01T10:00:00Z', { durationSeconds: null, hitCount: 5 }),
]
const ids = (list) => list.map((item) => item.id)

test('sorts by date, duration and shots without mutating the input', () => {
  const original = ids(matches)
  assert.deepEqual(ids(filterLibrary(matches, '', 'recent')), ['b', 'a', 'c'])
  assert.deepEqual(ids(filterLibrary(matches, '', 'oldest')), ['c', 'a', 'b'])
  assert.deepEqual(ids(filterLibrary(matches, '', 'duration')), ['a', 'b', 'c'])
  assert.deepEqual(ids(filterLibrary(matches, '', 'shots')), ['b', 'c', 'a'])
  assert.deepEqual(ids(matches), original)
})

test('search ignores accents and case and also looks at the file name', () => {
  assert.deepEqual(ids(filterLibrary(matches, 'REVES', 'recent')), ['b'])
  assert.deepEqual(ids(filterLibrary(matches, 'final', 'recent')), ['a', 'c'])
  assert.deepEqual(ids(filterLibrary(matches, 'c.mp4', 'recent')), ['c'])
  assert.deepEqual(filterLibrary(matches, 'xyz', 'recent'), [])
})

test('formats relative dates and durations', () => {
  const now = new Date(2026, 10, 15, 12)
  assert.equal(formatRelativeDate(new Date(2026, 10, 15, 8).toISOString(), now), 'Hoy')
  assert.equal(formatRelativeDate(new Date(2026, 10, 14, 23).toISOString(), now), 'Ayer')
  assert.equal(formatRelativeDate(new Date(2026, 10, 12, 9).toISOString(), now), 'Hace 3 días')
  assert.match(formatRelativeDate(new Date(2026, 9, 1).toISOString(), now), /2026/)
  assert.equal(formatRelativeDate('nope', now), '--')
  assert.equal(formatDuration(null), '--:--')
  assert.equal(formatDuration(65.4), '1:05')
})
