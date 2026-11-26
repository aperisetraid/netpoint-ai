import { drainSseBuffer } from '../lib/sse.ts'
import { ApiError } from './api'

export type CoachPerspective = 'far' | 'near' | 'coach'

export interface CoachTranscriptEntry {
  id: string
  role: 'user' | 'assistant'
  /** Markdown; video moments are linked as [m:ss](#t=SECONDS). */
  text: string
  createdAt: string
  /** Telemetry queries that back the answer. */
  tools: string[]
}

export interface CoachHighlight {
  label: string
  value: string
  detail: string
  time: number
}

export interface CoachSession {
  available: boolean
  model: string
  messages: CoachTranscriptEntry[]
  highlights: CoachHighlight[]
  suggestions: string[]
  reportPrompt: string
}

export interface CoachMessagePayload {
  message: string
  players: { far: string; near: string }
  perspective: CoachPerspective | null
  currentTime: number | null
}

export type CoachStreamEvent =
  | { type: 'text'; delta: string }
  | { type: 'replace'; text: string }
  | { type: 'status'; label: string }
  | { type: 'done'; question: CoachTranscriptEntry; message: CoachTranscriptEntry }
  | { type: 'error'; message: string }

const apiBaseUrl = (import.meta.env.VITE_API_BASE_URL || 'http://localhost:3000').replace(/\/$/, '')

function coachUrl(matchId: string, path = ''): string {
  return `${apiBaseUrl}/api/v1/matches/${encodeURIComponent(matchId)}/coach${path}`
}

async function failure(response: Response): Promise<ApiError> {
  try {
    const payload = (await response.json()) as { message?: string }
    if (payload.message) return new ApiError(payload.message, response.status)
  } catch {
    // Fall back to the generic message below.
  }
  return new ApiError(`El coach respondió con estado ${response.status}.`, response.status)
}

async function send(url: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init)
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error
    throw new ApiError('No se pudo conectar con el backend local. Verificá que el servidor esté activo.')
  }
}

export async function getCoachSession(matchId: string, signal?: AbortSignal): Promise<CoachSession> {
  const response = await send(coachUrl(matchId), { signal })
  if (!response.ok) throw await failure(response)
  return (await response.json()) as CoachSession
}

export async function resetCoachSession(matchId: string): Promise<void> {
  const response = await send(coachUrl(matchId), { method: 'DELETE' })
  if (!response.ok) throw await failure(response)
}

/** Sends a question and calls `onEvent` for every streamed event until the turn ends. */
export async function streamCoachMessage(
  matchId: string,
  payload: CoachMessagePayload,
  onEvent: (event: CoachStreamEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const response = await send(coachUrl(matchId, '/messages'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify(payload),
    signal,
  })
  if (!response.ok) throw await failure(response)
  if (!response.body) throw new ApiError('El coach no devolvió ninguna respuesta.')

  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
  let buffer = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buffer = drainSseBuffer<CoachStreamEvent>(buffer + value, onEvent)
  }
  drainSseBuffer(`${buffer}\n\n`, onEvent)
}
