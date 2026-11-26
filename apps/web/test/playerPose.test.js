import assert from 'node:assert/strict'
import test from 'node:test'
import {
  aimAt,
  buildSwings,
  dominantHand,
  playerFrame,
  playerShift,
  RACKET_REACH,
  racketAim,
  restAim,
  SHOULDER_HEIGHT,
} from '../src/lib/playerPose.ts'

const hit = (time, player, type, position, ball) => ({
  timestamp_seconds: time,
  frame_index: Math.round(time * 50),
  player,
  type,
  speed_kmh: 100,
  point_index: 0,
  ball,
  player_position: position,
  confidence: 0.9,
})

const close = (actual, expected, label) => assert.ok(Math.abs(actual - expected) < 1e-9, `${label}: ${actual}`)

test('aims in the player frame: forward is towards the net, right depends on the half', () => {
  // The near player faces the far baseline (−x): +y is their right.
  close(aimAt('near', { x: 24, y: 5 }, { x: 23, y: 5, z: SHOULDER_HEIGHT }).yaw, 0, 'ahead')
  assert.ok(aimAt('near', { x: 24, y: 5 }, { x: 24, y: 6, z: SHOULDER_HEIGHT }).yaw > 0)
  // The far player faces +x: +y is their left.
  assert.ok(aimAt('far', { x: 0, y: 5 }, { x: 0, y: 6, z: SHOULDER_HEIGHT }).yaw < 0)
  assert.ok(aimAt('far', { x: 0, y: 5 }, { x: 0.5, y: 5, z: 2.8 }).pitch > 1)
})

test('infers the dominant hand from forehands and backhands', () => {
  const near = { x: 24, y: 5 }
  const lefty = [
    hit(1, 'near', 'forehand', near, { x: 23.6, y: 4.2, z: 1 }),
    hit(3, 'near', 'backhand', near, { x: 23.6, y: 5.9, z: 1 }),
  ]
  assert.equal(dominantHand(lefty, 'near'), -1)
  const righty = [hit(1, 'near', 'forehand', near, { x: 23.6, y: 5.9, z: 1 })]
  assert.equal(dominantHand(righty, 'near'), 1)
  // Serves and volleys do not tell: right-handed by default.
  assert.equal(dominantHand([hit(1, 'near', 'serve', near, { x: 24, y: 5, z: 2.8 })], 'near'), 1)
})

test('the racket rests in front, swings through the contact and comes back', () => {
  const swings = buildSwings(
    [hit(2, 'far', 'forehand', { x: 0, y: 5 }, { x: 0.4, y: 4.2, z: 1 }), hit(2, 'near', 'serve', { x: 24, y: 5 }, { x: 24, y: 5, z: 2.8 })],
    'far',
  )
  assert.equal(swings.length, 1)
  const rest = restAim(1)
  assert.deepEqual(racketAim(swings, 1, 0), rest)
  assert.deepEqual(racketAim(swings, 1, 4), rest)
  assert.deepEqual(racketAim([], 1, 2), rest)

  const contact = racketAim(swings, 1, 2)
  close(contact.yaw, swings[0].contact.yaw, 'contact yaw')
  close(contact.pitch, swings[0].contact.pitch, 'contact pitch')
  // A forehand on the right: the racket is further right before the contact and across after it.
  assert.ok(racketAim(swings, 1, 1.78).yaw > contact.yaw)
  assert.ok(racketAim(swings, 1, 2.22).yaw < contact.yaw)
})

test('a contact measured behind the player keeps the arm within reach', () => {
  const [swing] = buildSwings([hit(1, 'far', 'forehand', { x: 0, y: 5 }, { x: -1.8, y: 3.3, z: 0.48 })], 'far')
  assert.ok(Math.abs(swing.contact.yaw) <= 2)
})

test('around a contact the player eases over so the racket meets the ball', () => {
  const player = { x: 0, y: 5 }
  const ball = { x: 2, y: 5.9, z: 1.95 }
  const [swing] = buildSwings([hit(4, 'far', 'backhand', player, ball)], 'far')
  const shift = playerShift([swing], 4)
  // Shoulder of the shifted player plus a straight arm along the aim lands on the ball.
  const { forward, right } = playerFrame('far')
  const { yaw, pitch } = swing.contact
  const horizontal = RACKET_REACH * Math.cos(pitch)
  const reach = {
    x: player.x + shift.x + right[0] * Math.sin(yaw) * horizontal + forward[0] * Math.cos(yaw) * horizontal,
    y: player.y + shift.y + right[1] * Math.sin(yaw) * horizontal + forward[1] * Math.cos(yaw) * horizontal,
    z: SHOULDER_HEIGHT + RACKET_REACH * Math.sin(pitch),
  }
  for (const axis of ['x', 'y', 'z']) close(reach[axis], ball[axis], axis)
  assert.deepEqual(playerShift([swing], 6), { x: 0, y: 0 })
  // Half a second away the player is back on the detected position.
  assert.deepEqual(playerShift([swing], 3.5), { x: 0, y: 0 })
})

test('a ball out of reach caps the shift', () => {
  const [swing] = buildSwings([hit(1, 'near', 'forehand', { x: 24, y: 5 }, { x: 18, y: 5, z: 1 })], 'near')
  assert.ok(Math.hypot(swing.shift.x, swing.shift.y) <= 2.5 + 1e-9)
})
