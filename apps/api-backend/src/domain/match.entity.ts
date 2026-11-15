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
  telemetry: MatchTelemetry;
}

export interface DetectionTelemetry {
  class: 'player' | 'ball';
  confidence: number;
  bbox: [number, number, number, number];
  x_meters: number | null;
  y_meters: number | null;
  z_meters?: number | null;
  carried_forward?: boolean;
  /** Ball position estimated from its trajectory in a frame where it was not detected. */
  interpolated?: boolean;
  source?: 'yolo' | 'yolo_court' | 'color' | 'motion' | 'interpolated' | 'flight3d';
}

export interface FrameTelemetry {
  frame_index: number;
  timestamp_seconds: number;
  detections: DetectionTelemetry[];
  court_corners?: [number, number][] | null;
}

export type CourtSide = 'far' | 'near';

export interface BounceEvent {
  timestamp_seconds: number;
  frame_index: number;
  x_meters: number;
  y_meters: number;
  side: CourtSide;
  confidence: number;
  method: 'fit3d' | 'image2d';
}

export interface HitEvent {
  timestamp_seconds: number;
  frame_index: number;
  player: CourtSide;
  type: 'serve' | 'volley' | 'forehand' | 'backhand';
  speed_kmh: number | null;
  point_index: number;
  ball: { x: number | null; y: number | null; z: number | null };
  player_position: { x: number; y: number };
  confidence: number;
}

export interface MatchTelemetry {
  version: number;
  video: { fps: number | null; width: number; height: number; frame_count: number };
  court: { length_meters: number; width_meters: number; calibrated: boolean };
  frames: FrameTelemetry[];
  events: { bounces: BounceEvent[]; hits: HitEvent[] };
}

export interface MatchTelemetryResponse {
  matchId: string;
  telemetry: MatchTelemetry;
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

/** Summary of an analysis already stored by the vision service. */
export interface LibraryMatchSummary {
  id: string;
  title: string;
  createdAt: string;
  source: 'url' | 'upload' | null;
  videoFilename: string | null;
  hasVideo: boolean;
  fps: number | null;
  width: number | null;
  height: number | null;
  frameCount: number;
  durationSeconds: number | null;
  calibrated: boolean;
  hitCount: number;
  bounceCount: number;
  maxSpeedKmh: number | null;
}

export interface LibraryMatchResponse extends MatchTelemetryResponse {
  title: string;
}
