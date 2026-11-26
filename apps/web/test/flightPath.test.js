import assert from 'node:assert/strict'
import test from 'node:test'
import {
  GRAVITY,
  NET_X,
  buildFlightSegments,
  currentShotIndex,
  describeShots,
  netClearance,
  netHeightAt,
  positionOnSegment,
  segmentAt,
} from '../src/lib/flightPath.ts'

const hit = (time, player, ball, type = 'forehand') => ({
  timestamp_seconds: time,
  frame_index: Math.round(time * 50),
  player,
  type,
  speed_kmh: 120,
  point_index: 0,
  ball,
  player_position: { x: ball.x ?? 0, y: ball.y ?? 5 },
  confidence: 0.9,
})
const bounce = (time, x, y, side) => ({
  timestamp_seconds: time,
  frame_index: Math.round(time * 50),
  x_meters: x,
  y_meters: y,
  side,
  confidence: 0.9,
  method: 'fit3d',
})

// Zverev's serve from the Monte Carlo clip: contact at 2.8 m, bounce 0.34 s later in the near box.
const serve = hit(1.955, 'far', { x: -0.19, y: 4.88, z: 2.8 }, 'serve')
const serveBounce = bounce(2.294, 17.12, 6.12, 'near')
const returnHit = hit(2.713, 'near', { x: 27.66, y: 6.75, z: 1.65 }, 'backhand')

test('joins hit → bounce → hit with parabolas that meet every event', () => {
  const segments = buildFlightSegments([serve, returnHit], [serveBounce])
  assert.equal(segments.length, 2)
  const [flight, rebound] = segments

  assert.deepEqual([flight.shooter, flight.hitIndex], ['far', 0])
  // The rebound keeps the server's colour: it is still the serve until the return.
  assert.deepEqual([rebound.shooter, rebound.hitIndex], ['far', 0])

  for (const [segment, time, expected] of [
    [flight, serve.timestamp_seconds, { x: -0.19, y: 4.88, z: 2.8 }],
    [flight, serveBounce.timestamp_seconds, { x: 17.12, y: 6.12, z: 0 }],
    [rebound, returnHit.timestamp_seconds, { x: 27.66, y: 6.75, z: 1.65 }],
  ]) {
    const point = positionOnSegment(segment, time)
    for (const axis of ['x', 'y', 'z']) assert.ok(Math.abs(point[axis] - expected[axis]) < 1e-9, axis)
  }
  // Gravity bends it: the launch goes down less steeply than the straight line.
  assert.ok(flight.velocity.z > (0 - 2.8) / (serveBounce.timestamp_seconds - serve.timestamp_seconds))
  assert.ok(Math.abs(flight.velocity.z - (-2.8 / 0.339 + (GRAVITY * 0.339) / 2)) < 1e-9)
})

test('the serve clears the net by a few centimetres', () => {
  const [flight] = buildFlightSegments([serve], [serveBounce])
  const clearance = netClearance(flight)
  assert.ok(clearance > 0 && clearance < 0.3, String(clearance))
  // A flight that stays on one side never crosses the net.
  const [, rebound] = buildFlightSegments([serve, returnHit], [serveBounce])
  assert.equal(netClearance(rebound), null)
})

test('net height sags from the posts to the centre strap', () => {
  assert.ok(Math.abs(netHeightAt(10.97 / 2) - 0.914) < 1e-9)
  assert.ok(Math.abs(netHeightAt(-0.914) - 1.07) < 1e-9)
  assert.ok(netHeightAt(1) > netHeightAt(3))
  assert.ok(NET_X > 11.8 && NET_X < 11.9)
})

test('skips gaps too long to be one flight and handles missing contact points', () => {
  const late = hit(9, 'near', { x: null, y: null, z: null }, 'serve')
  const segments = buildFlightSegments([serve, late], [serveBounce])
  // serve → bounce is drawn; bounce → a hit 6.7 s later is a new point, not a flight.
  assert.equal(segments.length, 1)
  assert.equal(segmentAt(segments, 5), null)
  assert.equal(segmentAt(segments, 2), segments[0])

  const lateBounce = bounce(9.5, 5, 5, 'far')
  const [fromServe] = buildFlightSegments([late], [lateBounce])
  // No 3D contact: it starts from the player at the usual serve height.
  assert.deepEqual(fromServe.start, { x: 0, y: 5, z: 2.6 })
})

test('describes each shot and finds the one being played', () => {
  const hits = [serve, returnHit]
  const shots = describeShots(hits, buildFlightSegments(hits, [serveBounce]))
  assert.equal(shots[0].contactHeight, 2.8)
  assert.ok(shots[0].netClearance > 0)
  assert.ok(Math.abs(shots[0].apexHeight - 2.8) < 1e-9)
  // The return has no detected flight after it.
  assert.deepEqual([shots[1].netClearance, shots[1].apexHeight], [null, null])

  assert.equal(currentShotIndex(hits, 1), -1)
  assert.equal(currentShotIndex(hits, 2.5), 0)
  assert.equal(currentShotIndex(hits, 10), 1)
  // Seeking to a shot lands a few microseconds early; it still counts as that shot.
  assert.equal(currentShotIndex(hits, returnHit.timestamp_seconds - 0.00002), 1)
})
