export type MatchStatus = 'queued' | 'processing' | 'completed' | 'failed';

export type MatchPlayer = 'player1' | 'player2';

export interface MatchProcessRequest {
  sourceUrl: string;
  title?: string;
}

export interface MatchProcessResponse {
  matchId: string;
  status: 'processing';
  message: string;
}

export interface BounceCoordinates {
  x: number;
  y: number;
}

export interface ShotTelemetry {
  shotNumber: number;
  timestamp: number;
  player: MatchPlayer;
  speedKmH: number;
  bounceCoordinates: BounceCoordinates;
  isInside: boolean;
}

export interface MatchTelemetryResponse {
  matchId: string;
  totalRallies: number;
  shots: ShotTelemetry[];
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