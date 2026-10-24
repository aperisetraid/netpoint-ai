import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Readable } from 'node:stream';

import type { MatchProcessRequest } from '../domain/match.entity.js';
import { MatchNotFoundError, GetTelemetryUseCase } from '../use-cases/get-telemetry.usecase.js';
import { ProcessMatchUseCase, VisionServiceError } from '../use-cases/process-match.usecase.js';

const DETECTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['class', 'confidence', 'bbox', 'x_meters', 'y_meters'],
  properties: {
    class: { type: 'string', enum: ['player', 'ball'] },
    confidence: { type: 'number' },
    bbox: {
      type: 'array',
      minItems: 4,
      maxItems: 4,
      items: { type: 'number' },
    },
    x_meters: { anyOf: [{ type: 'number' }, { type: 'null' }] },
    y_meters: { anyOf: [{ type: 'number' }, { type: 'null' }] },
    carried_forward: { type: 'boolean' },
  },
} as const;

const FRAME_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['frame_index', 'timestamp_seconds', 'detections'],
  properties: {
    frame_index: { type: 'integer' },
    timestamp_seconds: { type: 'number' },
    image_width: { type: 'integer', minimum: 1 },
    image_height: { type: 'integer', minimum: 1 },
    court_corners: {
      anyOf: [
        {
          type: 'array',
          minItems: 4,
          maxItems: 4,
          items: { type: 'array', minItems: 2, maxItems: 2, items: { type: 'number' } },
        },
        { type: 'null' },
      ],
    },
    detections: {
      type: 'array',
      items: DETECTION_SCHEMA,
    },
  },
} as const;

const TELEMETRY_RESPONSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['matchId', 'telemetry'],
  properties: {
    matchId: { type: 'string' },
    telemetry: {
      type: 'array',
      items: FRAME_SCHEMA,
    },
  },
} as const;

const PROCESS_MATCH_SCHEMA = {
  body: {
    type: 'object',
    additionalProperties: false,
    required: ['sourceUrl'],
    properties: {
      sourceUrl: { type: 'string', minLength: 1 },
      title: { type: 'string' },
      matchId: { type: 'string', format: 'uuid' },
    },
  },
  response: {
    200: {
      type: 'object',
      additionalProperties: false,
      required: ['matchId', 'status', 'telemetry'],
      properties: {
        matchId: { type: 'string' },
        status: { type: 'string', enum: ['completed'] },
        telemetry: {
          type: 'array',
          items: FRAME_SCHEMA,
        },
      },
    },
    502: {
      type: 'object',
      additionalProperties: false,
      required: ['message'],
      properties: {
        message: { type: 'string' },
      },
    },
  },
} as const;

const UPLOAD_MATCH_SCHEMA = {
  headers: {
    type: 'object',
    required: ['x-video-filename'],
    properties: {
      'x-match-id': { type: 'string', format: 'uuid' },
      'x-video-filename': { type: 'string', minLength: 1 },
      'x-title': { type: 'string' },
    },
  },
  response: PROCESS_MATCH_SCHEMA.response,
} as const;

const MATCH_TELEMETRY_SCHEMA = {
  params: {
    type: 'object',
    additionalProperties: false,
    required: ['matchId'],
    properties: {
      matchId: { type: 'string', minLength: 1 },
    },
  },
  response: {
    200: TELEMETRY_RESPONSE_SCHEMA,
  },
} as const;

const MATCH_PROGRESS_SCHEMA = {
  params: MATCH_TELEMETRY_SCHEMA.params,
  response: {
    200: {
      type: 'object',
      additionalProperties: false,
      required: ['processedFrames', 'totalFrames'],
      properties: {
        processedFrames: { type: 'integer', minimum: 0 },
        totalFrames: { anyOf: [{ type: 'integer', minimum: 0 }, { type: 'null' }] },
      },
    },
    400: {
      type: 'object',
      additionalProperties: false,
      required: ['message'],
      properties: { message: { type: 'string' } },
    },
    502: {
      type: 'object',
      additionalProperties: false,
      required: ['message'],
      properties: { message: { type: 'string' } },
    },
  },
} as const;

function isValidHttpUrl(value: string): boolean {
  try {
    const parsedUrl = new URL(value);
    return parsedUrl.protocol === 'http:' || parsedUrl.protocol === 'https:';
  } catch {
    return false;
  }
}

function isValidUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

interface MatchTelemetryParams {
  matchId: string;
}

export interface MatchControllerDependencies {
  processMatchUseCase: ProcessMatchUseCase;
  getTelemetryUseCase: GetTelemetryUseCase;
}

export class MatchController {
  readonly processMatchSchema = PROCESS_MATCH_SCHEMA;

  readonly uploadMatchSchema = UPLOAD_MATCH_SCHEMA;

  readonly matchTelemetrySchema = MATCH_TELEMETRY_SCHEMA;

  readonly matchProgressSchema = MATCH_PROGRESS_SCHEMA;

  constructor(private readonly dependencies: MatchControllerDependencies) {}

  async processMatch(
    request: FastifyRequest<{ Body: MatchProcessRequest }>,
    reply: FastifyReply,
  ): Promise<void> {
    if (!isValidHttpUrl(request.body.sourceUrl)) {
      await reply.status(400).send({ message: 'sourceUrl must be a valid http or https URL.' });
      return;
    }
    if (request.body.matchId && !isValidUuid(request.body.matchId)) {
      await reply.status(400).send({ message: 'matchId must be a valid UUID.' });
      return;
    }

    try {
      const response = await this.dependencies.processMatchUseCase.execute(request.body);
      await reply.status(200).send(response);
    } catch (error) {
      if (error instanceof VisionServiceError) {
        await reply.status(502).send({ message: error.message });
        return;
      }

      throw error;
    }
  }

  async uploadMatch(
    request: FastifyRequest<{
      Body: Readable;
      Headers: { 'x-match-id'?: string; 'x-video-filename'?: string; 'x-title'?: string };
    }>,
    reply: FastifyReply,
  ): Promise<void> {
    let fileName: string;
    try {
      fileName = decodeURIComponent(request.headers['x-video-filename'] ?? '');
    } catch {
      await reply.status(400).send({ message: 'x-video-filename must be URL encoded.' });
      return;
    }

    const extension = fileName.split('.').at(-1)?.toLowerCase();
    if (!extension || !['mp4', 'm4v', 'mov', 'avi', 'mkv', 'webm'].includes(extension)) {
      await reply.status(415).send({ message: 'Unsupported video format.' });
      return;
    }

    const matchId = request.headers['x-match-id'];
    if (matchId && !isValidUuid(matchId)) {
      await reply.status(400).send({ message: 'x-match-id must be a valid UUID.' });
      return;
    }

    let title: string | undefined;
    try {
      title = request.headers['x-title']
        ? decodeURIComponent(request.headers['x-title'])
        : undefined;
    } catch {
      await reply.status(400).send({ message: 'x-title must be URL encoded.' });
      return;
    }

    try {
      const response = await this.dependencies.processMatchUseCase.executeUpload({
        fileName,
        title,
        matchId,
        file: request.body,
      });
      await reply.status(200).send(response);
    } catch (error) {
      if (error instanceof VisionServiceError) {
        await reply.status(502).send({ message: error.message });
        return;
      }
      throw error;
    }
  }

  async getTelemetry(
    request: FastifyRequest<{ Params: MatchTelemetryParams }>,
    reply: FastifyReply,
  ): Promise<void> {
    const { matchId } = request.params;

    if (!isValidUuid(matchId)) {
      await reply.status(400).send({ message: 'matchId must be a valid UUID.' });
      return;
    }

    try {
      const telemetry = this.dependencies.getTelemetryUseCase.execute(matchId);
      await reply.status(200).send(telemetry);
    } catch (error) {
      if (error instanceof MatchNotFoundError) {
        await reply.status(404).send({ message: error.message });
        return;
      }

      throw error;
    }
  }

  async getProgress(
    request: FastifyRequest<{ Params: MatchTelemetryParams }>,
    reply: FastifyReply,
  ): Promise<void> {
    const { matchId } = request.params;
    if (!isValidUuid(matchId)) {
      await reply.status(400).send({ message: 'matchId must be a valid UUID.' });
      return;
    }

    try {
      const progress = await this.dependencies.processMatchUseCase.getProgress(matchId);
      await reply.status(200).send(progress);
    } catch (error) {
      if (error instanceof VisionServiceError) {
        await reply.status(502).send({ message: error.message });
        return;
      }
      throw error;
    }
  }
}