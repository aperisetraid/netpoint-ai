export type MatchStatus = 'queued' | 'processing' | 'completed' | 'failed';

export type MatchPlayer = 'player1' | 'player2';

export interface MatchProcessRequest {
  sourceUrl: string;
  title?: string;
  matchId?: string;
}

export interface MatchProgressResponse {
  processedFrames: number;
  totalFrames: number | null;
}

export interface MatchProcessResponse {
  matchId: string;
  status: 'completed';
  telemetry: FrameTelemetry[];
}

export interface DetectionTelemetry {
  class: 'player' | 'ball';
  confidence: number;
  bbox: [number, number, number, number];
  x_meters: number | null;
  y_meters: number | null;
  carried_forward?: boolean;
}

export interface FrameTelemetry {
  frame_index: number;
  timestamp_seconds: number;
  detections: DetectionTelemetry[];
  image_width?: number;
  image_height?: number;
  court_corners?: [number, number][] | null;
}

export interface MatchTelemetryResponse {
  matchId: string;
  telemetry: FrameTelemetry[];
}

export interface MatchRecord {
  matchId: string;
  sourceUrl: string;
  title?: string;
  status: MatchStatus;
  telemetry: MatchTelemetryResponse;
  createdAt: string;
}

export interface MatchRegistry {
  save(match: MatchRecord): void;
  getById(matchId: string): MatchRecord | undefined;
}