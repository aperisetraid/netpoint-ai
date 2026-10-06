import type { MatchRegistry, MatchTelemetryResponse } from '../domain/match.entity.js';

export class MatchNotFoundError extends Error {
  constructor(matchId: string) {
    super(`Match ${matchId} was not found.`);
    this.name = 'MatchNotFoundError';
  }
}

export class GetTelemetryUseCase {
  constructor(private readonly matchRegistry: MatchRegistry) {}

  execute(matchId: string): MatchTelemetryResponse {
    const match = this.matchRegistry.getById(matchId);

    if (!match) {
      throw new MatchNotFoundError(matchId);
    }

    return match.telemetry;
  }
}