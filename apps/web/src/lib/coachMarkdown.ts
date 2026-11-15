/**
 * Minimal Markdown for the coach's answers, parsed to a small AST that React renders safely
 * (no HTML injection). Supports what the coach is asked to write: paragraphs, headings,
 * lists, bold, italics, inline code and links, where `[m:ss](#t=SECONDS)` becomes a video jump.
 */

export type Inline =
  | { kind: 'text'; text: string }
  | { kind: 'strong'; children: Inline[] }
  | { kind: 'em'; children: Inline[] }
  | { kind: 'code'; text: string }
  | { kind: 'time'; label: string; seconds: number }
  | { kind: 'link'; href: string; children: Inline[] }
  | { kind: 'break' }

export type Block =
  | { kind: 'paragraph'; children: Inline[] }
  | { kind: 'heading'; level: 1 | 2 | 3; children: Inline[] }
  | { kind: 'list'; ordered: boolean; start: number; items: Inline[][] }
  | { kind: 'quote'; children: Inline[] }
  | { kind: 'rule' }

const TIME_HREF = /^#t=(\d+(?:\.\d+)?)$/
const SAFE_HREF = /^https?:\/\//i

interface InlineRule {
  pattern: RegExp
  build: (match: RegExpExecArray) => Inline
}

const inlineRules: InlineRule[] = [
  { pattern: /`([^`\n]+)`/, build: (m) => ({ kind: 'code', text: m[1] }) },
  {
    pattern: /\[([^\]\n]+)\]\(([^)\s]+)\)/,
    build: (m) => {
      const time = TIME_HREF.exec(m[2])
      if (time) return { kind: 'time', label: m[1], seconds: Number(time[1]) }
      if (SAFE_HREF.test(m[2])) return { kind: 'link', href: m[2], children: parseInline(m[1]) }
      return { kind: 'text', text: m[1] }
    },
  },
  { pattern: /\*\*(?=\S)([\s\S]+?)(?<=\S)\*\*/, build: (m) => ({ kind: 'strong', children: parseInline(m[1]) }) },
  { pattern: /__(?=\S)([\s\S]+?)(?<=\S)__/, build: (m) => ({ kind: 'strong', children: parseInline(m[1]) }) },
  { pattern: /(?<![\w*])\*(?=[^\s*])([^*\n]+?)(?<=\S)\*(?![\w*])/, build: (m) => ({ kind: 'em', children: parseInline(m[1]) }) },
  { pattern: /(?<![\w_])_(?=[^\s_])([^_\n]+?)(?<=\S)_(?![\w_])/, build: (m) => ({ kind: 'em', children: parseInline(m[1]) }) },
]

function pushText(nodes: Inline[], text: string) {
  if (!text) return
  const lines = text.split('\n')
  lines.forEach((line, index) => {
    if (index > 0) nodes.push({ kind: 'break' })
    if (!line) return
    const last = nodes.at(-1)
    if (last?.kind === 'text') last.text += line
    else nodes.push({ kind: 'text', text: line })
  })
}

export function parseInline(source: string): Inline[] {
  const nodes: Inline[] = []
  let rest = source
  while (rest) {
    let best: { index: number; length: number; node: Inline } | null = null
    for (const rule of inlineRules) {
      const match = rule.pattern.exec(rest)
      if (match && (best === null || match.index < best.index)) {
        best = { index: match.index, length: match[0].length, node: rule.build(match) }
      }
    }
    if (!best) {
      pushText(nodes, rest)
      break
    }
    pushText(nodes, rest.slice(0, best.index))
    if (best.node.kind === 'text') pushText(nodes, best.node.text)
    else nodes.push(best.node)
    rest = rest.slice(best.index + best.length)
  }
  return nodes
}

const HEADING = /^(#{1,6})\s+(.*)$/
const BULLET = /^\s*[-*•]\s+(.*)$/
const ORDERED = /^\s*(\d+)[.)]\s+(.*)$/
const QUOTE = /^>\s?(.*)$/
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/

export function parseMarkdown(source: string): Block[] {
  const blocks: Block[] = []
  let paragraph: string[] = []
  let list: { ordered: boolean; start: number; items: string[] } | null = null

  const flushParagraph = () => {
    if (paragraph.length) blocks.push({ kind: 'paragraph', children: parseInline(paragraph.join('\n')) })
    paragraph = []
  }
  const flushList = () => {
    if (list) blocks.push({ kind: 'list', ordered: list.ordered, start: list.start, items: list.items.map(parseInline) })
    list = null
  }

  for (const line of source.replace(/\r\n/g, '\n').split('\n')) {
    if (!line.trim()) {
      flushParagraph()
      flushList()
      continue
    }
    const heading = HEADING.exec(line)
    const bullet = BULLET.exec(line)
    const ordered = ORDERED.exec(line)
    const quote = QUOTE.exec(line)
    if (RULE.test(line)) {
      flushParagraph()
      flushList()
      blocks.push({ kind: 'rule' })
    } else if (heading) {
      flushParagraph()
      flushList()
      const level = Math.min(3, heading[1].length) as 1 | 2 | 3
      blocks.push({ kind: 'heading', level, children: parseInline(heading[2]) })
    } else if (bullet || ordered) {
      flushParagraph()
      const isOrdered = ordered !== null
      if (!list || list.ordered !== isOrdered) {
        flushList()
        list = { ordered: isOrdered, start: ordered ? Number(ordered[1]) : 1, items: [] }
      }
      list.items.push(ordered ? ordered[2] : bullet![1])
    } else if (quote) {
      flushParagraph()
      flushList()
      blocks.push({ kind: 'quote', children: parseInline(quote[1]) })
    } else if (list && /^\s{2,}\S/.test(line)) {
      // A wrapped list item continues the previous one.
      list.items[list.items.length - 1] += ` ${line.trim()}`
    } else {
      flushList()
      paragraph.push(line)
    }
  }
  flushParagraph()
  flushList()
  return blocks
}
