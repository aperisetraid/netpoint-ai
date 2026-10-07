import { randomUUID } from 'node:crypto';

import type {
  FrameTelemetry,
  MatchProcessRequest,
  MatchProcessResponse,
  MatchRegistry,
} from '../domain/match.entity.js';

const VISION_SERVICE_URL = 'http://localhost:8000/process-video';

interface VisionServiceResponse {
  telemetry: FrameTelemetry[];
}

export class VisionServiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VisionServiceError';
  }
}

function isVisionServiceResponse(value: unknown): value is VisionServiceResponse {
  return (
    typeof value === 'object' &&
    value !== null &&
    'telemetry' in value &&
    Array.isArray(value.telemetry)
  );
}

export interface ProcessMatchDependencies {
  matchRegistry: MatchRegistry;
  generateMatchId?: () => string;
  fetchImpl?: typeof fetch;
}

export class ProcessMatchUseCase {
  private readonly matchRegistry: MatchRegistry;

  private readonly generateMatchId: () => string;

  private readonly fetchImpl: typeof fetch;

  constructor({
    matchRegistry,
    generateMatchId = randomUUID,
    fetchImpl = fetch,
  }: ProcessMatchDependencies) {
    this.matchRegistry = matchRegistry;
    this.generateMatchId = generateMatchId;
    this.fetchImpl = fetchImpl;
  }

  async execute(request: MatchProcessRequest): Promise<MatchProcessResponse> {
    const matchId = this.generateMatchId();
    let response: Response;

    try {
      response = await this.fetchImpl(VISION_SERVICE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ youtubeUrl: request.sourceUrl, matchId }),
      });
    } catch {
      throw new VisionServiceError('Could not connect to the Python vision service.');
    }

    if (!response.ok) {
      throw new VisionServiceError(
        `The Python vision service returned status ${response.status}.`,
      );
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new VisionServiceError('The Python vision service returned invalid JSON.');
    }

    if (!isVisionServiceResponse(payload)) {
      throw new VisionServiceError('The Python vision service returned invalid telemetry.');
    }

    const telemetry = {
      matchId,
      telemetry: payload.telemetry,
    };

    this.matchRegistry.save({
      matchId,
      sourceUrl: request.sourceUrl,
      title: request.title,
      status: 'completed',
      telemetry,
      createdAt: new Date().toISOString(),
    });

    return {
      ...telemetry,
      status: 'completed',
    };
  }
}