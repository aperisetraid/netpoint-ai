export interface ProcessMatchRequest {
  sourceUrl: string
  title?: string
}

export interface ProcessMatchResponse {
  matchId: string
  status: 'processing'
  message: string
}

export interface ShotTelemetry {
  shotNumber: number
  timestamp: number
  player: 'player1' | 'player2'
  speedKmH: number
  bounceCoordinates: {
    x: number
    y: number
  }
  isInside: boolean
}

export interface MatchTelemetryResponse {
  matchId: string
  totalRallies: number
  shots: ShotTelemetry[]
}

const defaultApiBaseUrl = 'http://localhost:3000'

const apiBaseUrl = (import.meta.env.VITE_API_BASE_URL || defaultApiBaseUrl).replace(/\/$/, '')

export class ApiError extends Error {
  readonly status?: number

  constructor(message: string, status?: number) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

async function readErrorMessage(response: Response): Promise<string> {
  const contentType = response.headers.get('content-type')
  const text = await response.text()

  if (contentType?.includes('application/json') && text) {
    try {
      const payload = JSON.parse(text) as { message?: string }
      if (payload.message) {
        return payload.message
      }
    } catch {
      return text || `La API respondió con estado ${response.status}.`
    }
  }

  return text || `La API respondió con estado ${response.status}.`
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response

  try {
    response = await fetch(`${apiBaseUrl}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...(init?.headers ?? {}),
      },
    })
  } catch {
    throw new ApiError('No se pudo conectar con el backend local. Verificá que el servidor esté activo.')
  }

  if (!response.ok) {
    throw new ApiError(await readErrorMessage(response), response.status)
  }

  return (await response.json()) as T
}

export async function processMatch(payload: ProcessMatchRequest): Promise<ProcessMatchResponse> {
  return requestJson<ProcessMatchResponse>('/api/v1/matches/process', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export async function getMatchTelemetry(matchId: string): Promise<MatchTelemetryResponse> {
  return requestJson<MatchTelemetryResponse>(`/api/v1/matches/${matchId}/telemetry`, {
    method: 'GET',
  })
}