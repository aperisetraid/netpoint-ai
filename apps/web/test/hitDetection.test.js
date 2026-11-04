import assert from 'node:assert/strict'
import test from 'node:test'
import { detectEstimatedHits } from '../src/hitDetection.ts'

const fps = 60

// Ball centres observed in the short test clip, as [frame, x, y].
const serveTossAndHit = [
  [82, 1094, 502], [83, 1095, 502], [84, 1098, 502], [85, 1100, 502], [86, 1102, 502],
  [87, 1104, 502], [88, 1106, 502], [89, 1108, 504], [90, 1110, 505], [91, 1111, 507],
  [92, 1113, 509], [93, 1115, 511], [95, 1090, 488], [96, 1076, 478], [98, 1040, 450],
  [99, 1028, 440], [101, 1003, 422], [102, 990, 413], [103, 979, 406], [104, 970, 399],
  [105, 961, 394],
]
const servePlayer = [1053, 544, 1133, 815]

const apexHitByFarPlayer = [
  [149, 858, 157], [150, 858, 154], [151, 858, 152], [152, 858, 150], [153, 858, 148],
  [154, 858, 146], [155, 858, 144], [156, 858, 144], [157, 858, 142], [158, 858, 142],
  [159, 858, 140], [160, 858, 140], [161, 858, 140], [170, 880, 150], [173, 893, 158],
  [175, 902, 164], [176, 906, 167], [178, 916, 174], [181, 930, 190], [182, 935, 194],
  [184, 947, 205], [185, 951, 210], [187, 956, 216],
]
const farPlayer = [791, 108, 833, 201]

const smoothFlightAfterServe = [
  [101, 1003, 422], [102, 990, 413], [103, 979, 406], [104, 970, 399], [105, 961, 394],
  [107, 945, 384], [108, 938, 380], [109, 934, 378], [110, 928, 375], [111, 924, 374],
  [112, 919, 372], [113, 916, 372], [114, 910, 370], [115, 909, 372], [116, 906, 371],
]

const bounceAtMidCourt = [
  [112, 919, 372], [113, 916, 372], [114, 910, 370], [115, 909, 372], [116, 906, 371],
  [117, 903, 371], [118, 901, 372], [119, 900, 372], [120, 898, 374], [121, 896, 373],
  [122, 892, 356], [124, 887, 330], [125, 885, 319], [126, 883, 308], [127, 882, 297],
  [128, 878, 285], [129, 877, 278], [130, 874, 266],
]

function makeFrames(samples, playerBox) {
  return samples.map(([frame, x, y]) => ({
    frame_index: frame,
    timestamp_seconds: frame / fps,
    image_width: 1920,
    image_height: 1080,
    detections: [
      { class: 'ball', confidence: 0.65, bbox: [x - 2, y - 2, x + 2, y + 2], x_meters: 10, y_meters: 4 },
      ...(playerBox
        ? [{ class: 'player', confidence: 0.9, bbox: playerBox, x_meters: 4, y_meters: 4 }]
        : []),
    ],
  }))
}

const hitFrames = (hits) => hits.map((hit) => Math.round(hit.timestamp * fps))

test('detects a serve even though the toss is almost stationary', () => {
  const [hit, ...others] = hitFrames(detectEstimatedHits(makeFrames(serveTossAndHit, servePlayer)))

  assert.equal(others.length, 0)
  assert.ok(hit >= 90 && hit <= 96, `serve estimated at frame ${hit}`)
})

test('detects a hit where the ball stalls at the apex of its flight', () => {
  const [hit, ...others] = hitFrames(detectEstimatedHits(makeFrames(apexHitByFarPlayer, farPlayer)))

  assert.equal(others.length, 0)
  assert.ok(hit >= 158 && hit <= 168, `hit estimated at frame ${hit}`)
})

test('does not count smooth deceleration of a ball flying past a player', () => {
  const nearBall = [990, 400, 1130, 600]

  assert.deepEqual(detectEstimatedHits(makeFrames(smoothFlightAfterServe, nearBall)), [])
})

test('does not count a bounce away from the players', () => {
  assert.deepEqual(detectEstimatedHits(makeFrames(bounceAtMidCourt, [100, 600, 160, 800])), [])
})

test('does not count the same bounce as a hit when a player is nearby', () => {
  const frames = makeFrames(bounceAtMidCourt, [880, 300, 920, 420])
  const bounceTimestamp = 120 / fps

  assert.deepEqual(detectEstimatedHits(frames, [bounceTimestamp]), [])
})

test('does not join ball detections across a position jump', () => {
  const frames = makeFrames([
    [262, 772, 285], [263, 770, 279], [264, 766, 274], [265, 806, 190], [266, 804, 191],
    [267, 801, 192], [268, 798, 194], [269, 794, 196],
  ], farPlayer)

  assert.deepEqual(detectEstimatedHits(frames), [])
})
