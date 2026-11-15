import assert from 'node:assert/strict'
import test from 'node:test'
import { summarizeShots } from '../src/lib/shotSummary.ts'

const hit = (player, type, speedKmh, pointIndex = 0) => ({
  timestamp_seconds: 0, frame_index: 0, player, type, speed_kmh: speedKmh, point_index: pointIndex,
  ball: { x: null, y: null, z: null }, player_position: { x: 0, y: 0 }, confidence: 0.5,
})

test('aggregates shots per player and type, ignoring unmeasured speeds', () => {
  const summary = summarizeShots([
    hit('far', 'serve', 180),
    hit('near', 'forehand', 100),
    hit('near', 'volley', null),
    hit('near', 'forehand', 120, 1),
  ])

  assert.equal(summary.match.totalShots, 4)
  assert.equal(summary.match.measuredShots, 3)
  assert.equal(summary.match.maxSpeedKmh, 180)
  assert.equal(summary.match.pointCount, 2)
  assert.deepEqual(summary.byPlayer.near.byType, { serve: 0, volley: 1, forehand: 2, backhand: 0 })
  assert.equal(summary.byPlayer.near.averageSpeedKmh, 110)
  assert.equal(summary.byPlayer.far.maxSpeedKmh, 180)
})

test('reports null speeds when nothing was measured', () => {
  const summary = summarizeShots([])
  assert.equal(summary.match.pointCount, 0)
  assert.equal(summary.match.maxSpeedKmh, null)
  assert.equal(summary.byPlayer.far.averageSpeedKmh, null)
})
