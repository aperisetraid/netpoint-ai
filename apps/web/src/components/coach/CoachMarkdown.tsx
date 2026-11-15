import { type ReactNode, useMemo } from 'react'
import { Play } from 'lucide-react'

import { type Block, type Inline, parseMarkdown } from '../../lib/coachMarkdown.ts'

interface CoachMarkdownProps {
  text: string
  onSeek: (seconds: number) => void
  /** Draws a caret after the last block while the answer is still being written. */
  streaming?: boolean
}

function renderInline(nodes: Inline[], onSeek: (seconds: number) => void, prefix: string): ReactNode[] {
  return nodes.map((node, index) => {
    const key = `${prefix}-${index}`
    switch (node.kind) {
      case 'text':
        return node.text
      case 'break':
        return <br key={key} />
      case 'strong':
        return <strong key={key}>{renderInline(node.children, onSeek, key)}</strong>
      case 'em':
        return <em key={key}>{renderInline(node.children, onSeek, key)}</em>
      case 'code':
        return <code key={key}>{node.text}</code>
      case 'link':
        return (
          <a key={key} href={node.href} target="_blank" rel="noreferrer noopener">
            {renderInline(node.children, onSeek, key)}
          </a>
        )
      case 'time':
        return (
          <button
            key={key}
            type="button"
            className="coach-time"
            title={`Ver ${node.label} en el vídeo`}
            onClick={() => onSeek(node.seconds)}
          >
            <Play size={9} fill="currentColor" aria-hidden="true" />
            {node.label}
          </button>
        )
    }
  })
}

function renderBlock(block: Block, index: number, onSeek: (seconds: number) => void): ReactNode {
  const key = `b${index}`
  switch (block.kind) {
    case 'paragraph':
      return <p key={key}>{renderInline(block.children, onSeek, key)}</p>
    case 'heading':
      return <h4 key={key} data-level={block.level}>{renderInline(block.children, onSeek, key)}</h4>
    case 'quote':
      return <blockquote key={key}>{renderInline(block.children, onSeek, key)}</blockquote>
    case 'rule':
      return <hr key={key} />
    case 'list': {
      const items = block.items.map((item, itemIndex) => (
        <li key={`${key}-${itemIndex}`}>{renderInline(item, onSeek, `${key}-${itemIndex}`)}</li>
      ))
      return block.ordered
        ? <ol key={key} start={block.start}>{items}</ol>
        : <ul key={key}>{items}</ul>
    }
  }
}

/** Safe rendering of the coach's Markdown: no raw HTML, and video moments become buttons. */
export function CoachMarkdown({ text, onSeek, streaming = false }: CoachMarkdownProps) {
  const blocks = useMemo(() => parseMarkdown(text), [text])
  return (
    <div className="coach-md" data-streaming={streaming || undefined}>
      {blocks.map((block, index) => renderBlock(block, index, onSeek))}
    </div>
  )
}
