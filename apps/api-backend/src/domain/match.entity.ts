export type MatchStatus = 'queued' | 'processing' | 'completed' | 'failed';

export type MatchPlayer = 'player1' | 'player2';

export interface MatchProcessRequest {
  sourceUrl: string;
  title?: string;
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
}

export interface FrameTelemetry {
  frame_index: number;
  timestamp_seconds: number;
  detections: DetectionTelemetry[];
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