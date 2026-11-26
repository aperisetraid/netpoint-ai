import { type FormEvent, type KeyboardEvent, useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  AlertTriangle,
  ArrowUp,
  ChevronRight,
  KeyRound,
  Play,
  RotateCcw,
  ScanSearch,
  Sparkles,
  Square,
  Video,
  X,
} from 'lucide-react'

import { type CoachChatMessage, type CoachDraft, useCoachChat } from '../../hooks/useCoachChat'
import type { CoachPerspective, CoachSession } from '../../services/coach'
import type { PlayerNames } from '../ingest/PlayerNamesDialog'
import { CoachMarkdown } from './CoachMarkdown'
import './Coach.css'

interface CoachPanelProps {
  matchId: string | null
  playerNames: PlayerNames
  currentTime: number
  /** Whether the video has a moment worth sending as context ("this point"). */
  hasVideo: boolean
  onSeek: (seconds: number) => void
  onClose: () => void
}

const perspectiveStorageKey = (matchId: string) => `netpoint-coach-perspective:${matchId}`

function readPerspective(matchId: string | null): CoachPerspective | null {
  if (!matchId) return null
  try {
    const stored = window.localStorage.getItem(perspectiveStorageKey(matchId))
    return stored === 'far' || stored === 'near' || stored === 'coach' ? stored : null
  } catch {
    return null
  }
}

function clock(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds))
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`
}

/** Conversational tactical coach over the analysed match; it lives in the side column next to the video. */
export function CoachPanel({ matchId, playerNames, currentTime, hasVideo, onSeek, onClose }: CoachPanelProps) {
  const [perspective, setPerspective] = useState<CoachPerspective | null>(() => readPerspective(matchId))
  const [perspectiveMatch, setPerspectiveMatch] = useState(matchId)
  const [input, setInput] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const stickToBottom = useRef(true)

  // Who is asking is remembered per match.
  if (perspectiveMatch !== matchId) {
    setPerspectiveMatch(matchId)
    setPerspective(readPerspective(matchId))
  }

  const chat = useCoachChat(matchId, () => ({
    players: playerNames,
    perspective,
    currentTime: hasVideo ? currentTime : null,
  }))
  const { session, messages, draft, isStreaming } = chat
  const canAsk = Boolean(matchId && session?.available && !isStreaming && !chat.needsAccessCode)

  function choosePerspective(next: CoachPerspective) {
    const value = perspective === next ? null : next
    setPerspective(value)
    if (!matchId) return
    try {
      if (value) window.localStorage.setItem(perspectiveStorageKey(matchId), value)
      else window.localStorage.removeItem(perspectiveStorageKey(matchId))
    } catch {
      // Storage may be unavailable (private mode); the choice still applies to this visit.
    }
  }

  function ask(question: string) {
    if (!canAsk || !question.trim()) return
    stickToBottom.current = true
    void chat.send(question)
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault()
    if (isStreaming) {
      chat.stop()
      return
    }
    if (!input.trim()) return
    ask(input)
    setInput('')
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      event.currentTarget.form?.requestSubmit()
    }
  }

  // Grow the composer with its content, up to a few lines.
  useLayoutEffect(() => {
    const textarea = textareaRef.current
    if (!textarea) return
    textarea.style.height = 'auto'
    textarea.style.height = `${Math.min(textarea.scrollHeight, 148)}px`
  }, [input])

  // Follow the answer as it streams, unless the user scrolled up to read.
  useEffect(() => {
    const scroller = scrollRef.current
    if (scroller && stickToBottom.current) scroller.scrollTop = scroller.scrollHeight
  }, [messages, draft?.text, draft?.status])

  const perspectiveOptions: { id: CoachPerspective; label: string }[] = [
    { id: 'far', label: playerNames.far || 'Fondo' },
    { id: 'near', label: playerNames.near || 'Cámara' },
    { id: 'coach', label: 'Entrenador' },
  ]

  return (
    <aside className="coach" aria-label="Coach táctico">
      <header className="coach__header">
        <h2>Coach táctico</h2>
        <div className="coach__actions">
          <button
            type="button"
            className="btn btn--ghost btn--icon btn--sm"
            title="Nueva conversación"
            aria-label="Nueva conversación"
            disabled={!messages.length || isStreaming}
            onClick={() => void chat.reset()}
          >
            <RotateCcw size={15} aria-hidden="true" />
          </button>
          <button type="button" className="btn btn--ghost btn--icon btn--sm" title="Volver al panel táctico" aria-label="Cerrar coach" onClick={onClose}>
            <X size={16} aria-hidden="true" />
          </button>
        </div>
      </header>

      <div className="coach__perspective">
        <span id="coach-perspective-label">Hablas como</span>
        <div className="segmented" role="radiogroup" aria-labelledby="coach-perspective-label">
          {perspectiveOptions.map(({ id, label }) => (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={perspective === id}
              disabled={!matchId}
              title={label}
              onClick={() => choosePerspective(id)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div
        ref={scrollRef}
        className="coach__scroll"
        onScroll={(event) => {
          const target = event.currentTarget
          stickToBottom.current = target.scrollHeight - target.scrollTop - target.clientHeight < 80
        }}
      >
        {session?.available && chat.needsAccessCode ? (
          <CoachAccessForm refused={chat.accessRefused} onSubmit={chat.submitAccessCode} />
        ) : null}
        <CoachBody
          matchId={matchId}
          session={session}
          isLoading={chat.isLoading}
          loadError={chat.loadError}
          messages={messages}
          draft={draft}
          canAsk={canAsk}
          onAsk={ask}
          onRetry={chat.retry}
          onSeek={onSeek}
        />
      </div>

      <form className="coach__composer" onSubmit={handleSubmit}>
        <div className="coach__field" data-disabled={!session?.available || undefined}>
          <textarea
            ref={textareaRef}
            rows={1}
            value={input}
            maxLength={4000}
            placeholder={
              !session?.available
                ? 'El coach no está disponible'
                : chat.needsAccessCode
                  ? 'Introduce antes el código de acceso'
                  : 'Pregunta sobre el partido…'
            }
            aria-label="Pregunta para el coach"
            disabled={!matchId || !session?.available}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={handleKeyDown}
          />
          <button
            type="submit"
            className="btn btn--primary coach__send"
            data-mode={isStreaming ? 'stop' : 'send'}
            aria-label={isStreaming ? 'Detener respuesta' : 'Enviar pregunta'}
            title={isStreaming ? 'Detener' : 'Enviar (Intro)'}
            disabled={!isStreaming && (!canAsk || !input.trim())}
          >
            {isStreaming ? <Square size={12} fill="currentColor" /> : <ArrowUp size={16} />}
          </button>
        </div>
        {matchId && hasVideo ? (
          <p className="coach__hint">
            El coach ve el vídeo en <b>{clock(currentTime)}</b>. «Este punto» se refiere a ese momento.
          </p>
        ) : null}
      </form>
    </aside>
  )
}

interface CoachBodyProps {
  matchId: string | null
  session: CoachSession | null
  isLoading: boolean
  loadError: string | null
  messages: CoachChatMessage[]
  draft: CoachDraft | null
  canAsk: boolean
  onAsk: (question: string) => void
  onRetry: (message: CoachChatMessage) => void
  onSeek: (seconds: number) => void
}

function CoachBody({ matchId, session, isLoading, loadError, messages, draft, canAsk, onAsk, onRetry, onSeek }: CoachBodyProps) {
  if (!matchId) {
    return (
      <div className="coach-empty">
        <Video size={22} strokeWidth={1.5} aria-hidden="true" />
        <p>Carga o abre un partido para conversar con el coach.</p>
      </div>
    )
  }
  if (isLoading) {
    return (
      <div className="coach-skeleton" aria-label="Cargando el coach">
        <i /><i /><i />
      </div>
    )
  }
  if (loadError) {
    return (
      <div className="notice notice--error coach-notice" role="alert">
        <AlertTriangle size={15} aria-hidden="true" />
        <p>{loadError}</p>
      </div>
    )
  }
  if (!session) return null

  return (
    <>
      {!session.available ? (
        <div className="notice notice--warning coach-notice">
          <KeyRound size={15} aria-hidden="true" />
          <p>
            Para activar el coach, define <code>ANTHROPIC_API_KEY</code> en el entorno del servicio de visión y
            reinícialo.
          </p>
        </div>
      ) : null}

      {messages.length === 0 && !draft ? (
        <CoachIntro session={session} canAsk={canAsk} onAsk={onAsk} onSeek={onSeek} />
      ) : (
        <ol className="coach-thread">
          {messages.map((message) => (
            <li key={message.id} className={`coach-msg coach-msg--${message.role}`}>
              {message.role === 'user' ? (
                <>
                  <p className="coach-msg__bubble">{message.text}</p>
                  {message.failed ? (
                    <p className="coach-msg__failed" role="alert">
                      {message.failed}
                      <button type="button" disabled={!canAsk} onClick={() => onRetry(message)}>Reintentar</button>
                    </p>
                  ) : null}
                </>
              ) : (
                <>
                  <CoachMarkdown text={message.text} onSeek={onSeek} />
                  {message.tools.length ? <CoachSources steps={message.tools} /> : null}
                </>
              )}
            </li>
          ))}
          {draft ? (
            <li className="coach-msg coach-msg--assistant" aria-live="polite" aria-busy="true">
              {draft.status || !draft.text ? (
                <p className="coach-status">
                  <i aria-hidden="true" />
                  <span>{draft.status ?? 'Analizando el partido…'}</span>
                </p>
              ) : null}
              {draft.text ? <CoachMarkdown text={draft.text} onSeek={onSeek} streaming /> : null}
            </li>
          ) : null}
        </ol>
      )}
    </>
  )
}

interface CoachAccessFormProps {
  refused: boolean
  onSubmit: (code: string) => void
}

/** The public demo protects the coach (it runs on its owner's Anthropic key) with a shared code. */
function CoachAccessForm({ refused, onSubmit }: CoachAccessFormProps) {
  const [code, setCode] = useState('')
  return (
    <form
      className="notice notice--warning coach-notice coach-access"
      onSubmit={(event) => {
        event.preventDefault()
        onSubmit(code)
        setCode('')
      }}
    >
      <KeyRound size={15} aria-hidden="true" />
      <div className="coach-access__body">
        <p>
          {refused
            ? 'El código no es correcto. Vuelve a introducirlo.'
            : 'Este coach está protegido. Introduce el código de acceso que te han facilitado.'}
        </p>
        <div className="coach-access__row">
          <input
            className="field__control"
            type="password"
            value={code}
            autoComplete="off"
            aria-label="Código de acceso del coach"
            placeholder="Código de acceso"
            onChange={(event) => setCode(event.target.value)}
          />
          <button type="submit" className="btn btn--primary btn--sm" disabled={!code.trim()}>Desbloquear</button>
        </div>
      </div>
    </form>
  )
}

function CoachSources({ steps }: { steps: string[] }) {
  return (
    <details className="coach-sources">
      <summary>
        <ScanSearch size={12} aria-hidden="true" />
        {steps.length === 1 ? '1 consulta a la telemetría' : `${steps.length} consultas a la telemetría`}
      </summary>
      <ul>
        {steps.map((step, index) => <li key={`${step}-${index}`}>{step}</li>)}
      </ul>
    </details>
  )
}

interface CoachIntroProps {
  session: CoachSession
  canAsk: boolean
  onAsk: (question: string) => void
  onSeek: (seconds: number) => void
}

function CoachIntro({ session, canAsk, onAsk, onSeek }: CoachIntroProps) {
  return (
    <div className="coach-intro">
      <div className="coach-intro__lead">
        <h3>Pregúntale al partido.</h3>
        <p>Analizo cada golpe, bote y desplazamiento del vídeo para explicarte qué pasó y cómo mejorar.</p>
      </div>

      {session.highlights.length ? (
        <div className="coach-highlights">
          {session.highlights.map((highlight) => (
            <button
              key={highlight.label}
              type="button"
              className="coach-highlight"
              title={`Ver en el vídeo (${clock(highlight.time)})`}
              onClick={() => onSeek(highlight.time)}
            >
              <span className="coach-highlight__label">{highlight.label}</span>
              <strong>{highlight.value}</strong>
              <span className="coach-highlight__detail">{highlight.detail}</span>
              <span className="timecode">
                <Play size={8} fill="currentColor" aria-hidden="true" /> {clock(highlight.time)}
              </span>
            </button>
          ))}
        </div>
      ) : null}

      <button type="button" className="btn btn--primary btn--block coach-report" disabled={!canAsk} onClick={() => onAsk(session.reportPrompt)}>
        <Sparkles size={16} aria-hidden="true" />
        <span>
          <b>Informe táctico del partido</b>
          <small>Patrones, momentos clave y prioridades de entrenamiento</small>
        </span>
      </button>

      <ul className="coach-suggestions" aria-label="Preguntas sugeridas">
        {session.suggestions.map((suggestion) => (
          <li key={suggestion}>
            <button type="button" disabled={!canAsk} onClick={() => onAsk(suggestion)}>
              <span>{suggestion}</span>
              <ChevronRight size={14} aria-hidden="true" />
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}
