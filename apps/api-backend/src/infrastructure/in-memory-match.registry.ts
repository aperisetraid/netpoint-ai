import type { MatchRecord, MatchRegistry } from '../domain/match.entity.js';

export class InMemoryMatchRegistry implements MatchRegistry {
  private readonly matches = new Map<string, MatchRecord>();

  save(match: MatchRecord): void {
    this.matches.set(match.matchId, match);
  }

  getById(matchId: string): MatchRecord | undefined {
    return this.matches.get(matchId);
  }
}