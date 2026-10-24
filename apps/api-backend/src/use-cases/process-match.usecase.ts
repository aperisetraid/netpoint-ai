import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';

import type {
  FrameTelemetry,
  MatchProgressResponse,
  MatchProcessRequest,
  MatchProcessResponse,
  MatchRegistry,
} from '../domain/match.entity.js';

const VISION_SERVICE_URL = 'http://localhost:8000/process-video';
const VISION_UPLOAD_URL = 'http://localhost:8000/process-upload';
const VISION_PROGRESS_URL = 'http://localhost:8000/matches';

interface VisionServiceResponse {
  telemetry: FrameTelemetry[];
}

interface VisionServiceProgress {
  processedFrames: number;
  totalFrames: number | null;
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
    fetchImpl = fetch,
  }: ProcessMatchDependencies) {
    this.matchRegistry = matchRegistry;
    this.generateMatchId = generateMatchId;
    this.fetchImpl = fetchImpl;
  }

  async execute(request: MatchProcessRequest): Promise<MatchProcessResponse> {
    const matchId = request.matchId ?? this.generateMatchId();
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

    return this.saveMatch(matchId, request.sourceUrl, request.title, payload.telemetry);
  }

  async executeUpload(request: MatchFileUploadRequest): Promise<MatchProcessResponse> {
    const matchId = request.matchId ?? this.generateMatchId();
    let response: Response;

    try {
      response = await this.fetchImpl(VISION_UPLOAD_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-Match-Id': matchId,
          'X-Video-Filename': encodeURIComponent(request.fileName),
        },
        body: request.file as unknown as RequestInit['body'],
        duplex: 'half',
      } as RequestInit & { duplex: 'half' });
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
        `${VISION_PROGRESS_URL}/${encodeURIComponent(matchId)}/progress`,
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
    frameTelemetry: FrameTelemetry[],
  ): MatchProcessResponse {
    const telemetry = { matchId, telemetry: frameTelemetry };
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