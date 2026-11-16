import assert from 'node:assert/strict'
import test from 'node:test'
import { courtPalette, sideColors, withAlpha } from '../src/lib/palette.ts'

test('every player side has its own colour, distinct from the ball', () => {
  assert.deepEqual(Object.keys(sideColors).sort(), ['far', 'near'])
  assert.notEqual(sideColors.far, sideColors.near)
  for (const colour of Object.values(sideColors)) assert.notEqual(colour, courtPalette.ball)
})

test('palette entries are #RRGGBB so they can be faded on canvas', () => {
  for (const colour of Object.values(courtPalette)) assert.match(colour, /^#[0-9A-F]{6}$/i)
})

test('converts hex to rgba', () => {
  assert.equal(withAlpha('#DCF04A', 0.5), 'rgba(220, 240, 74, 0.5)')
  assert.equal(withAlpha('#050B15', 1), 'rgba(5, 11, 21, 1)')
})
