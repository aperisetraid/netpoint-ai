import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';

import { longRunningFetch } from '../infrastructure/long-running-fetch.js';
import { visionUrl } from '../infrastructure/vision-url.js';
import type {
  MatchProgressResponse,
  MatchProcessRequest,
  MatchProcessResponse,
  MatchRegistry,
  MatchTelemetry,
} from '../domain/match.entity.js';

interface VisionServiceResponse {
  telemetry: MatchTelemetry;
}

interface VisionServiceProgress {
  processedFrames: number;
  totalFrames: number | null;
}

/** The vision service is deployed without the pipeline (read-only demo) and refuses new analyses. */
export class ProcessingDisabledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProcessingDisabledError';
  }
}

async function processingDisabled(response: Response): Promise<ProcessingDisabledError> {
  let message = 'New analyses are disabled in this deployment.';
  try {
    const payload = (await response.json()) as { detail?: unknown };
    if (typeof payload.detail === 'string') message = payload.detail;
  } catch {
    // Keep the generic message.
  }
  return new ProcessingDisabledError(message);
}

export class VisionServiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VisionServiceError';
  }
}

export function isVisionServiceResponse(value: unknown): value is VisionServiceResponse {
  if (typeof value !== 'object' || value === null || !('telemetry' in value)) {
    return false;
  }
  const telemetry = value.telemetry as Partial<MatchTelemetry> | null;
  return (
    typeof telemetry === 'object' &&
    telemetry !== null &&
    typeof telemetry.video === 'object' &&
    telemetry.video !== null &&
    Array.isArray(telemetry.frames) &&
    Array.isArray(telemetry.events?.bounces) &&
    Array.isArray(telemetry.events?.hits)
  );
}

function isVisionServiceProgress(value: unknown): value is VisionServiceProgress {
  return (
    typeof value === 'object' &&
    value !== null &&
    'processedFrames' in value &&
    typeof value.processedFrames === 'number' &&
    'totalFrames' in value &&
    (typeof value.totalFrames === 'number' || value.totalFrames === null)
  );
}

export interface ProcessMatchDependencies {
  matchRegistry: MatchRegistry;
  generateMatchId?: () => string;
  fetchImpl?: typeof fetch;
}

export interface MatchFileUploadRequest {
  fileName: string;
  title?: string;
  matchId?: string;
  file: Readable;
}

export class ProcessMatchUseCase {
  private readonly matchRegistry: MatchRegistry;

  private readonly generateMatchId: () => string;

  private readonly fetchImpl: typeof fetch;

  constructor({
    matchRegistry,
    generateMatchId = randomUUID,
    fetchImpl = longRunningFetch,
  }: ProcessMatchDependencies) {
    this.matchRegistry = matchRegistry;
    this.generateMatchId = generateMatchId;
    this.fetchImpl = fetchImpl;
  }

  async execute(request: MatchProcessRequest): Promise<MatchProcessResponse> {
    const matchId = request.matchId ?? this.generateMatchId();
    let response: Response;

    try {
      response = await this.fetchImpl(visionUrl('/process-video'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ youtubeUrl: request.sourceUrl, matchId, title: request.title }),
      });
    } catch {
      throw new VisionServiceError('Could not connect to the Python vision service.');
    }

    if (response.status === 503 && response.headers.get('X-NetPoint-Read-Only') === '1') {
      throw await processingDisabled(response);
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

    return this.saveMatch(matchId, request.sourceUrl, request.title, payload.telemetry);
  }

  async executeUpload(request: MatchFileUploadRequest): Promise<MatchProcessResponse> {
    const matchId = request.matchId ?? this.generateMatchId();
    let response: Response;

    try {
      response = await this.fetchImpl(visionUrl('/process-upload'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-Match-Id': matchId,
          'X-Video-Filename': encodeURIComponent(request.fileName),
          ...(request.title ? { 'X-Title': encodeURIComponent(request.title) } : {}),
        },
        body: request.file as unknown as RequestInit['body'],
        duplex: 'half',
      } as RequestInit & { duplex: 'half' });
    } catch {
      throw new VisionServiceError('Could not connect to the Python vision service.');
    }

    if (response.status === 503 && response.headers.get('X-NetPoint-Read-Only') === '1') {
      throw await processingDisabled(response);
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

    return this.saveMatch(
      matchId,
      `uploaded://${encodeURIComponent(request.fileName)}`,
      request.title,
      payload.telemetry,
    );
  }

  async getProgress(matchId: string): Promise<MatchProgressResponse> {
    let response: Response;
    try {
      response = await this.fetchImpl(
        visionUrl(`/matches/${encodeURIComponent(matchId)}/progress`),
      );
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
      throw new VisionServiceError('The Python vision service returned invalid progress.');
    }

    if (!isVisionServiceProgress(payload)) {
      throw new VisionServiceError('The Python vision service returned invalid progress.');
    }
    return payload;
  }

  private saveMatch(
    matchId: string,
    sourceUrl: string,
    title: string | undefined,
    matchTelemetry: MatchTelemetry,
  ): MatchProcessResponse {
    const telemetry = { matchId, telemetry: matchTelemetry };
    this.matchRegistry.save({
      matchId,
      sourceUrl,
      title,
      status: 'completed',
      telemetry,
      createdAt: new Date().toISOString(),
    });

    return { ...telemetry, status: 'completed' };
  }
}