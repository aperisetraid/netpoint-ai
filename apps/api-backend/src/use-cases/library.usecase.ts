import type { LibraryMatchResponse, LibraryMatchSummary } from '../domain/match.entity.js';
import { MatchNotFoundError } from './get-telemetry.usecase.js';
import { visionUrl } from '../infrastructure/vision-url.js';
import { isVisionServiceResponse, VisionServiceError } from './process-match.usecase.js';

export interface LibraryDependencies {
  fetchImpl?: typeof fetch;
}

/** Reads the analyses the vision service already keeps on disk; nothing is recomputed. */
export class LibraryUseCase {
  private readonly fetchImpl: typeof fetch;

  constructor({ fetchImpl = fetch }: LibraryDependencies = {}) {
    this.fetchImpl = fetchImpl;
  }

  async list(): Promise<LibraryMatchSummary[]> {
    const payload = await this.requestJson(visionUrl('/library/matches'));
    if (!Array.isArray(payload)) {
      throw new VisionServiceError('The Python vision service returned an invalid library.');
    }
    return payload as LibraryMatchSummary[];
  }

  async get(matchId: string): Promise<LibraryMatchResponse> {
    const payload = await this.requestJson(visionUrl(`/library/matches/${encodeURIComponent(matchId)}`), matchId);
    if (!isVisionServiceResponse(payload) || !('matchId' in payload) || !('title' in payload)) {
      throw new VisionServiceError('The Python vision service returned invalid telemetry.');
    }
    return payload as unknown as LibraryMatchResponse;
  }

  private async requestJson(url: string, matchId?: string): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImpl(url);
    } catch {
      throw new VisionServiceError('Could not connect to the Python vision service.');
    }

    if (response.status === 404 && matchId) {
      throw new MatchNotFoundError(matchId);
    }
    if (!response.ok) {
      throw new VisionServiceError(`The Python vision service returned status ${response.status}.`);
    }

    try {
      return await response.json();
    } catch {
      throw new VisionServiceError('The Python vision service returned invalid JSON.');
    }
  }
}
