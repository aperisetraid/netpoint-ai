import assert from 'node:assert/strict'
import test from 'node:test'
import { contrastRatio, courtFill } from '../src/lib/courtColors.ts'
import { courtPalette } from '../src/lib/palette.ts'

// Colours the vision service measured on the two demo clips.
const usOpen = { surface: '#5574AF', surround: '#769B77' }
const monteCarlo = { surface: '#B35C42', surround: '#B45C42' }

function hue(hex) {
  const [r, g, b] = [1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16))
  const max = Math.max(r, g, b)
  if (max === r) return 'red'
  return max === g ? 'green' : 'blue'
}

test('keeps the default hard court when nothing was measured', () => {
  const fallback = { court: courtPalette.court, courtOuter: courtPalette.courtOuter }
  assert.deepEqual(courtFill(undefined), fallback)
  assert.deepEqual(courtFill(null), fallback)
  assert.deepEqual(courtFill({ surface: 'azul' }), fallback)
})

test('a blue court with a green surround keeps both hues', () => {
  const fill = courtFill(usOpen)
  assert.equal(hue(fill.court), 'blue')
  assert.equal(hue(fill.courtOuter), 'green')
})

test('clay all round stays orange, with a darker surround', () => {
  const fill = courtFill(monteCarlo)
  assert.equal(hue(fill.court), 'red')
  assert.equal(hue(fill.courtOuter), 'red')
  assert.notEqual(fill.court, fill.courtOuter)
  assert.ok(contrastRatio(fill.court, fill.courtOuter) > 1.1)
  // Without a surround the court is still framed.
  assert.notEqual(courtFill({ surface: monteCarlo.surface }).courtOuter, courtFill({ surface: monteCarlo.surface }).court)
})

test('lines, ball and both players stay legible on every measured court', () => {
  for (const colors of [usOpen, monteCarlo, { surface: '#F2F2F2' }, { surface: '#2E7D32' }]) {
    const { court } = courtFill(colors)
    assert.ok(contrastRatio(court, courtPalette.line) >= 4.5, `lines on ${court}`)
    for (const mark of [courtPalette.ball, courtPalette.far, courtPalette.near]) {
      assert.ok(contrastRatio(court, mark) >= 3, `${mark} on ${court}`)
    }
  }
})
