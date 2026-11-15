export interface ProcessMatchRequest {
  sourceUrl: string
  title?: string
  matchId?: string
}

export interface ProcessMatchResponse {
  matchId: string
  status: 'completed'
  telemetry: MatchTelemetry
}

export interface DetectionTelemetry {
  class: 'player' | 'ball'
  confidence: number
  bbox: [number, number, number, number]
  x_meters: number | null
  y_meters: number | null
  /** Ball height from the 3D flight fit; null when it could not be reconstructed. */
  z_meters?: number | null
  carried_forward?: boolean
}

export interface FrameTelemetry {
  frame_index: number
  timestamp_seconds: number
  detections: DetectionTelemetry[]
  court_corners?: [number, number][] | null
}

export type PlayerSide = 'far' | 'near'
export type ShotType = 'serve' | 'volley' | 'forehand' | 'backhand'

export interface BounceEvent {
  timestamp_seconds: number
  frame_index: number
  x_meters: number
  y_meters: number
  side: PlayerSide
  confidence: number
  method: 'fit3d' | 'image2d'
}

export interface HitEvent {
  timestamp_seconds: number
  frame_index: number
  player: PlayerSide
  type: ShotType
  speed_kmh: number | null
  point_index: number
  ball: { x: number | null; y: number | null; z: number | null }
  player_position: { x: number; y: number }
  confidence: number
}

export interface MatchTelemetry {
  version: number
  video: { fps: number | null; width: number; height: number; frame_count: number }
  court: { length_meters: number; width_meters: number; calibrated: boolean }
  frames: FrameTelemetry[]
  events: { bounces: BounceEvent[]; hits: HitEvent[] }
}

export interface MatchTelemetryResponse {
  matchId: string
  telemetry: MatchTelemetry
}

const defaultApiBaseUrl = 'http://localhost:3000'

const apiBaseUrl = (import.meta.env.VITE_API_BASE_URL || defaultApiBaseUrl).replace(/\/$/, '')
const visionBaseUrl = (import.meta.env.VITE_VISION_BASE_URL || 'http://localhost:8000').replace(/\/$/, '')

export function getMatchFrameUrl(matchId: string, frameIndex: number): string {
  return `${visionBaseUrl}/matches/${encodeURIComponent(matchId)}/frames/${frameIndex}`
}

export function getMatchVideoUrl(matchId: string): string {
  return `${visionBaseUrl}/matches/${encodeURIComponent(matchId)}/video`
}

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

export async function uploadMatchVideo(
  file: File,
  title?: string,
  matchId?: string,
): Promise<ProcessMatchResponse> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/octet-stream',
    'X-Video-Filename': encodeURIComponent(file.name),
  }
  if (title) {
    headers['X-Title'] = encodeURIComponent(title)
  }
  if (matchId) {
    headers['X-Match-Id'] = matchId
  }
  return requestJson<ProcessMatchResponse>('/api/v1/matches/upload', {
    method: 'POST',
    body: file,
    headers,
  })
}

export interface MatchProgressResponse {
  processedFrames: number
  totalFrames: number | null
}

export async function getMatchProgress(matchId: string): Promise<MatchProgressResponse> {
  return requestJson<MatchProgressResponse>(`/api/v1/matches/${encodeURIComponent(matchId)}/progress`, {
    method: 'GET',
  })
}