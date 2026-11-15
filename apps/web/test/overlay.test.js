import assert from 'node:assert/strict'
import test from 'node:test'
import { findFrameAt, findIndexAtOrBefore } from '../src/lib/frameLookup.ts'
import {
  applyHomography,
  containRect,
  courtToImageHomography,
  solveHomography,
} from '../src/components/video/overlay/geometry.ts'
import { hitAnchor } from '../src/components/video/overlay/hitLabels.ts'
import { buildBallTrack, trailAt } from '../src/components/video/overlay/trail.ts'

const close = (actual, expected, tolerance = 1e-6) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} is not close to ${expected}`)

test('finds the last entry at or before a time', () => {
  const times = [0, 0.5, 1]
  assert.equal(findIndexAtOrBefore(times, -0.1), -1)
  assert.equal(findIndexAtOrBefore(times, 0), 0)
  assert.equal(findIndexAtOrBefore(times, 0.99), 1)
  assert.equal(findIndexAtOrBefore(times, 5), 2)

  const frames = times.map((time, index) => ({ frame_index: index, timestamp_seconds: time }))
  assert.equal(findFrameAt(frames, -1), undefined)
  assert.equal(findFrameAt(frames, 0.7).frame_index, 1)
})

test('letterboxes media inside a box of a different aspect ratio', () => {
  const tall = containRect(1000, 1000, 1920, 1080)
  close(tall.x, 0)
  close(tall.y, 218.75)
  close(tall.scale, 1000 / 1920)
  assert.deepEqual(containRect(2000, 540, 1920, 1080), { x: 520, y: 0, scale: 0.5 })
  assert.equal(containRect(0, 500, 1920, 1080).scale, 0)
})

test('maps court meters to image pixels through the calibrated corners', () => {
  const corners = [[653, 350], [1267, 350], [1564, 857], [356, 857]]
  const homography = courtToImageHomography(corners)
  const courtCorners = [[0, 0], [0, 10.97], [23.77, 10.97], [23.77, 0]]
  courtCorners.forEach(([x, y], index) => {
    const [u, v] = applyHomography(homography, x, y)
    close(u, corners[index][0], 1e-6)
    close(v, corners[index][1], 1e-6)
  })
  // The court centre projects onto the image's vertical axis of symmetry, above the middle row.
  const [centerU, centerV] = applyHomography(homography, 23.77 / 2, 10.97 / 2)
  close(centerU, 960, 1e-6)
  assert.ok(centerV > 350 && centerV < (350 + 857) / 2)

  assert.equal(courtToImageHomography(null), null)
  assert.equal(solveHomography([[0, 0], [1, 1], [2, 2], [3, 3]], corners), null)
})

function ballFrames(positions, fps = 50) {
  return positions.map((position, index) => ({
    frame_index: index,
    timestamp_seconds: index / fps,
    detections: position === null ? [] : [{
      class: 'ball', confidence: 0.8,
      bbox: [position[0] - 2, position[1] - 2, position[0] + 2, position[1] + 2],
      x_meters: null, y_meters: null,
    }],
  }))
}

test('builds a fading trail that ends at the interpolated playback position', () => {
  const track = buildBallTrack(ballFrames([[100, 100], [110, 100], [120, 100], [130, 100]]))
  const trail = trailAt(track, 0.05, 1920)

  assert.deepEqual(trail.map((point) => Math.round(point.x)), [100, 110, 120, 125])
  close(trail.at(-1).age, 0)
  close(trail[0].age, 0.05)
  assert.ok(trail.every((point, index) => index === 0 || point.age < trail[index - 1].age))
})

test('drops trail samples that are too old or beyond a tracking jump', () => {
  const positions = Array.from({ length: 60 }, (_, index) => [100 + index * 5, 200])
  const old = trailAt(buildBallTrack(ballFrames(positions)), 59 / 50, 1920)
  assert.equal(old.length, 31)

  const jump = buildBallTrack(ballFrames([[100, 100], [105, 100], [900, 500], [905, 500], [910, 500]]))
  assert.deepEqual(trailAt(jump, 4 / 50, 1920).map((point) => point.x), [900, 905, 910])

  const lost = buildBallTrack(ballFrames([[100, 100], ...Array(30).fill(null)]))
  assert.deepEqual(trailAt(lost, 30 / 50, 1920), [])
  assert.deepEqual(trailAt(buildBallTrack([]), 1, 1920), [])
})

test('anchors a hit label above the player on the hitting side', () => {
  const frame = {
    frame_index: 0,
    timestamp_seconds: 0,
    detections: [
      { class: 'player', confidence: 0.9, bbox: [800, 100, 860, 220], x_meters: 2, y_meters: 5 },
      { class: 'player', confidence: 0.9, bbox: [900, 600, 1000, 900], x_meters: 22, y_meters: 5 },
    ],
  }
  assert.deepEqual(hitAnchor(frame, { player: 'near' }), [950, 600])
  assert.deepEqual(hitAnchor(frame, { player: 'far' }), [830, 100])
  assert.equal(hitAnchor(undefined, { player: 'far' }), null)
})
