import { useCallback, useEffect, useRef, useState } from 'react'

import { ApiError } from '../services/api'
import {
  type CoachMessagePayload,
  type CoachSession,
  type CoachTranscriptEntry,
  getCoachSession,
  resetCoachSession,
  streamCoachMessage,
} from '../services/coach'

export interface CoachDraft {
  text: string
  /** Latest progress line: a telemetry query or a short note from the coach. */
  status: string | null
  steps: string[]
}

export interface CoachChatMessage extends CoachTranscriptEntry {
  /** The question never got an answer; the UI offers to resend it. */
  failed?: string
}

type Context = Omit<CoachMessagePayload, 'message'>

const unexpectedError = 'El coach no pudo responder. Inténtalo de nuevo.'

/** One coach conversation per match: loads the stored history and streams new turns. */
export function useCoachChat(matchId: string | null, getContext: () => Context) {
  const [session, setSession] = useState<CoachSession | null>(null)
  const [messages, setMessages] = useState<CoachChatMessage[]>([])
  const [draft, setDraft] = useState<CoachDraft | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(Boolean(matchId))
  const [loadedMatch, setLoadedMatch] = useState(matchId)
  const abortRef = useRef<AbortController | null>(null)
  const contextRef = useRef(getContext)

  useEffect(() => {
    contextRef.current = getContext
  })

  // Another match: start from a clean slate while its conversation loads.
  if (loadedMatch !== matchId) {
    setLoadedMatch(matchId)
    setSession(null)
    setMessages([])
    setDraft(null)
    setLoadError(null)
    setIsLoading(Boolean(matchId))
  }

  useEffect(() => {
    if (!matchId) return
    const controller = new AbortController()
    getCoachSession(matchId, controller.signal)
      .then((loaded) => {
        setSession(loaded)
        setMessages(loaded.messages)
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return
        setLoadError(error instanceof ApiError ? error.message : unexpectedError)
      })
      .finally(() => {
        if (!controller.signal.aborted) setIsLoading(false)
      })
    return () => {
      controller.abort()
      // A turn still streaming belongs to the match being left.
      abortRef.current?.abort()
    }
  }, [matchId])

  const send = useCallback(async (question: string) => {
    const message = question.trim()
    if (!matchId || !message || abortRef.current) return
    const controller = new AbortController()
    abortRef.current = controller
    const pendingId = `pending-${crypto.randomUUID()}`
    setMessages((current) => [
      ...current.filter((entry) => !entry.failed),
      { id: pendingId, role: 'user', text: message, createdAt: new Date().toISOString(), tools: [] },
    ])
    setDraft({ text: '', status: null, steps: [] })

    const fail = (reason: string) =>
      setMessages((current) => current.map((entry) => (entry.id === pendingId ? { ...entry, failed: reason } : entry)))

    let finished = false
    try {
      await streamCoachMessage(matchId, { message, ...contextRef.current() }, (event) => {
        switch (event.type) {
          case 'text':
            setDraft((current) => current && { ...current, text: current.text + event.delta, status: null })
            break
          case 'replace':
            setDraft((current) => current && { ...current, text: event.text })
            break
          case 'status':
            setDraft((current) => current && { ...current, status: event.label, steps: [...current.steps, event.label] })
            break
          case 'done':
            finished = true
            setMessages((current) => [
              ...current.map((entry) => (entry.id === pendingId ? event.question : entry)),
              event.message,
            ])
            break
          case 'error':
            finished = true
            fail(event.message)
            break
        }
      }, controller.signal)
      if (!finished) fail('La conexión se cerró antes de terminar la respuesta.')
    } catch (error) {
      if (controller.signal.aborted) fail('Respuesta detenida.')
      else fail(error instanceof ApiError ? error.message : unexpectedError)
    } finally {
      abortRef.current = null
      setDraft(null)
    }
  }, [matchId])

  const stop = useCallback(() => abortRef.current?.abort(), [])

  const retry = useCallback((entry: CoachChatMessage) => {
    setMessages((current) => current.filter((candidate) => candidate.id !== entry.id))
    void send(entry.text)
  }, [send])

  const reset = useCallback(async () => {
    if (!matchId || abortRef.current) return
    try {
      await resetCoachSession(matchId)
      setMessages([])
    } catch (error) {
      setLoadError(error instanceof ApiError ? error.message : unexpectedError)
    }
  }, [matchId])

  return {
    session,
    messages,
    draft,
    isLoading,
    loadError,
    isStreaming: draft !== null,
    send,
    stop,
    retry,
    reset,
  }
}
