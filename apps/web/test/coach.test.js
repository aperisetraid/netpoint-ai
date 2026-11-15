import assert from 'node:assert/strict'
import test from 'node:test'

import { parseInline, parseMarkdown } from '../src/lib/coachMarkdown.ts'
import { drainSseBuffer } from '../src/lib/sse.ts'

test('timestamp links become video jumps and other links stay safe', () => {
  assert.deepEqual(parseInline('Mira [0:27](#t=27.32) y [aquí](javascript:void) .'), [
    { kind: 'text', text: 'Mira ' },
    { kind: 'time', label: '0:27', seconds: 27.32 },
    { kind: 'text', text: ' y aquí .' },
  ])
  const [link] = parseInline('[docs](https://example.com)')
  assert.equal(link.kind, 'link')
  assert.equal(link.href, 'https://example.com')
})

test('inline emphasis, code and nesting', () => {
  assert.deepEqual(parseInline('**Revés [1:02](#t=62)** y *cruzado* con `x=3`'), [
    {
      kind: 'strong',
      children: [{ kind: 'text', text: 'Revés ' }, { kind: 'time', label: '1:02', seconds: 62 }],
    },
    { kind: 'text', text: ' y ' },
    { kind: 'em', children: [{ kind: 'text', text: 'cruzado' }] },
    { kind: 'text', text: ' con ' },
    { kind: 'code', text: 'x=3' },
  ])
  // A product of two numbers is not emphasis.
  assert.deepEqual(parseInline('2 * 3 * 4'), [{ kind: 'text', text: '2 * 3 * 4' }])
})

test('blocks: headings, lists, wrapped items, paragraphs and breaks', () => {
  const blocks = parseMarkdown('### Patrones\n- Uno\n- Dos\n  sigue\n\n1. Primero\n2. Segundo\n\nLínea A\nLínea B')
  assert.deepEqual(blocks.map((block) => block.kind), ['heading', 'list', 'list', 'paragraph'])
  assert.equal(blocks[0].level, 3)
  assert.equal(blocks[1].ordered, false)
  assert.deepEqual(blocks[1].items[1], [{ kind: 'text', text: 'Dos sigue' }])
  assert.equal(blocks[2].ordered, true)
  assert.deepEqual(blocks[3].children, [
    { kind: 'text', text: 'Línea A' },
    { kind: 'break' },
    { kind: 'text', text: 'Línea B' },
  ])
})

test('incomplete markdown while streaming renders as text instead of breaking', () => {
  assert.deepEqual(parseInline('Golpe **clave en [0:1'), [{ kind: 'text', text: 'Golpe **clave en [0:1' }])
})

test('SSE buffer yields complete events and keeps the partial tail', () => {
  const events = []
  const rest = drainSseBuffer(
    'data: {"type":"text","delta":"Ho"}\n\ndata: {"type":"text","delta":"la"}\r\n\r\n: comment\n\ndata: {"type":"st',
    (event) => events.push(event),
  )
  assert.deepEqual(events, [{ type: 'text', delta: 'Ho' }, { type: 'text', delta: 'la' }])
  assert.equal(rest, 'data: {"type":"st')
  drainSseBuffer(`${rest}atus","label":"Buscando"}\n\ndata: not-json\n\n`, (event) => events.push(event))
  assert.deepEqual(events.at(-1), { type: 'status', label: 'Buscando' })
  assert.equal(events.length, 3)
})
