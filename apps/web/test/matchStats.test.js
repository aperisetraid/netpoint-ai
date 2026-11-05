import assert from 'node:assert/strict'
import test from 'node:test'
import { calculateShotStatistics, estimateShotSpeedKmh } from '../src/matchStats.ts'

const fps = 50

function frame(index, detections) {
  return { frame_index: index, timestamp_seconds: index / fps, image_width: 1920, image_height: 1080, detections }
}
const player = (bbox, x, y) => ({ class: 'player', confidence: 0.9, bbox, x_meters: x, y_meters: y })
const ball = (bbox, x, y) => ({ class: 'ball', confidence: 0.8, bbox, x_meters: x, y_meters: y })

test('estimates speed with the median of valid segments and ignores outliers', () => {
  const frames = [
    frame(0, [ball([0, 0, 4, 4], 1, 5)]),
    frame(1, [ball([0, 0, 4, 4], 1.5, 5)]),
    frame(2, [ball([0, 0, 4, 4], 4.5, 5)]),
    frame(3, [ball([0, 0, 4, 4], 2.5, 5)]),
  ]
  assert.equal(Math.round(estimateShotSpeedKmh(frames, 0)), 90)
})

test('returns null speed when following frames have no metric ball', () => {
  const frames = [frame(0, [ball([0, 0, 4, 4], 1, 5)]), frame(1, [ball([0, 0, 4, 4], null, null)])]
  assert.equal(estimateShotSpeedKmh(frames, 0), null)
})

test('classifies serve, volley and groundstrokes', () => {
  const farServer = player([900, 100, 960, 220], -0.5, 4)
  const nearVolleyer = player([800, 600, 900, 800], 15, 5)
  const frames = [
    frame(0, [farServer, ball([930, 90, 940, 100], 0, 4)]),
    frame(50, [nearVolleyer, ball([920, 650, 930, 660], 15, 5)]),
    frame(100, [nearVolleyer, ball([920, 650, 930, 660], 15, 5)]),
  ]
  const hits = [0, 1, 2].map((second) => ({ timestamp: second }))
  const bounces = [{ timestamp: 1.5, x: 18, y: 5 }]

  const result = calculateShotStatistics(frames, bounces, hits)

  assert.deepEqual(result.shots.map((shot) => [shot.player, shot.type]), [
    ['far', 'serve'], ['near', 'volley'], ['near', 'forehand'],
  ])
  assert.equal(result.match.pointCount, 1)
  assert.deepEqual(result.byPlayer.near.byType, { serve: 0, volley: 1, forehand: 1, backhand: 0 })
})

test('uses handedness for groundstrokes', () => {
  const frames = [frame(0, [player([800, 600, 900, 800], 20, 5), ball([920, 650, 930, 660], 20, 5)])]
  const result = calculateShotStatistics(frames, [], [{ timestamp: 0 }], { handedness: { near: 'left' } })
  assert.equal(result.shots[0].type, 'backhand')
})
