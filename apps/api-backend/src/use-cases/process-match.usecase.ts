import { randomUUID } from 'node:crypto';

import type {
  MatchProcessRequest,
  MatchProcessResponse,
  MatchRegistry,
  MatchTelemetryResponse,
  ShotTelemetry,
} from '../domain/match.entity.js';

const COURT_BOUNDS = {
  minX: 0,
  maxX: 8.23,
  minY: 0,
  maxY: 23.77,
} as const;

const SHOT_BLUEPRINTS = [
  { timestamp: 1.24, player: 'player1', speedKmH: 131.2, x: 2.14, y: 6.8 },
  { timestamp: 2.91, player: 'player2', speedKmH: 118.7, x: 6.02, y: 16.45 },
  { timestamp: 4.3, player: 'player1', speedKmH: 143.6, x: 8.91, y: 18.2 },
  { timestamp: 6.12, player: 'player2', speedKmH: 124.9, x: 3.72, y: 12.3 },
  { timestamp: 7.86, player: 'player1', speedKmH: 136.4, x: -0.32, y: 9.14 },
  { timestamp: 9.42, player: 'player2', speedKmH: 129.1, x: 5.44, y: 21.1 },
  { timestamp: 11.07, player: 'player1', speedKmH: 147.3, x: 7.89, y: 24.42 },
  { timestamp: 12.68, player: 'player2', speedKmH: 122.5, x: 1.84, y: 14.88 },
] as const;

export function isBounceInsideCourt(x: number, y: number): boolean {
  return (
    x >= COURT_BOUNDS.minX &&
    x <= COURT_BOUNDS.maxX &&
    y >= COURT_BOUNDS.minY &&
    y <= COURT_BOUNDS.maxY
  );
}

function buildMockShots(): ShotTelemetry[] {
  return SHOT_BLUEPRINTS.map((shot, index) => ({
    shotNumber: index + 1,
    timestamp: shot.timestamp,
    player: shot.player,
    speedKmH: shot.speedKmH,
    bounceCoordinates: {
      x: shot.x,
      y: shot.y,
    },
    isInside: isBounceInsideCourt(shot.x, shot.y),
  }));
}

function buildMockTelemetry(matchId: string): MatchTelemetryResponse {
  const shots = buildMockShots();

  return {
    matchId,
    totalRallies: Math.ceil(shots.length / 2),
    shots,
  };
}

export interface ProcessMatchDependencies {
  matchRegistry: MatchRegistry;
  generateMatchId?: () => string;
}

export class ProcessMatchUseCase {
  private readonly matchRegistry: MatchRegistry;

  private readonly generateMatchId: () => string;

  constructor({ matchRegistry, generateMatchId = randomUUID }: ProcessMatchDependencies) {
    this.matchRegistry = matchRegistry;
    this.generateMatchId = generateMatchId;
  }

  execute(request: MatchProcessRequest): MatchProcessResponse {
    const matchId = this.generateMatchId();
    const telemetry = buildMockTelemetry(matchId);

    this.matchRegistry.save({
      matchId,
      sourceUrl: request.sourceUrl,
      title: request.title,
      status: 'processing',
      telemetry,
      createdAt: new Date().toISOString(),
    });

    return {
      matchId,
      status: 'processing',
      message: 'Mock telemetry generated. Processing has started.',
    };
  }
}