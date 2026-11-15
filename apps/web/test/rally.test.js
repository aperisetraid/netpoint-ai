import assert from 'node:assert/strict'
import test from 'node:test'
import { ballAt, createGeometry, hitInterval, playerAt } from '../src/components/loader/rally.ts'

const geometry = createGeometry(200, 70)

test('the ball touches the racket of the player who hits it at every hit', () => {
  for (let index = 0; index < 8; index++) {
    const time = index * hitInterval
    const side = index % 2 === 0 ? 'left' : 'right'
    const ball = ballAt(geometry, time)
    const player = playerAt(geometry, side, time)
    const expectedX = side === 'left' ? geometry.leftX + geometry.reach : geometry.rightX - geometry.reach

    assert.ok(Math.abs(ball.x - expectedX) < 1e-6)
    assert.ok(Math.abs(ball.y - player.y) < 1e-6)
    assert.ok(Math.abs(ball.z) < 1e-6)
    assert.ok(player.swing > 0.99)
  }
})

test('the ball flies over the net and stays inside the court', () => {
  const start = 2 * hitInterval
  for (let step = 0; step <= 40; step++) {
    const ball = ballAt(geometry, start + (hitInterval * step) / 40)
    assert.ok(ball.z >= -1e-9)
    assert.ok(ball.y >= geometry.yMin - 1e-6 && ball.y <= geometry.yMax + 1e-6)
  }
  const atNet = ballAt(geometry, start + hitInterval / 2)
  assert.ok(Math.abs(atNet.x - 100) < 1)
  assert.ok(atNet.z > 4)
})
