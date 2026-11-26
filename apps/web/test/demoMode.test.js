import assert from 'node:assert/strict'
import test from 'node:test'
import { parseDemoMode } from '../src/lib/demoMode.ts'

test('only an explicit flag turns on the public demo', () => {
  for (const value of ['1', 'true', true]) assert.equal(parseDemoMode(value), true)
  for (const value of [undefined, '', '0', 'false', 'yes', 1]) assert.equal(parseDemoMode(value), false)
})
