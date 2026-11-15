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
    z_meters: { anyOf: [{ type: 'number' }, { type: 'null' }] },
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

const NULLABLE_NUMBER = { anyOf: [{ type: 'number' }, { type: 'null' }] } as const;
const COURT_SIDE = { type: 'string', enum: ['far', 'near'] } as const;

const BOUNCE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['timestamp_seconds', 'frame_index', 'x_meters', 'y_meters', 'side', 'confidence', 'method'],
  properties: {
    timestamp_seconds: { type: 'number' },
    frame_index: { type: 'integer' },
    x_meters: { type: 'number' },
    y_meters: { type: 'number' },
    side: COURT_SIDE,
    confidence: { type: 'number' },
    method: { type: 'string', enum: ['fit3d', 'image2d'] },
  },
} as const;

const HIT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'timestamp_seconds',
    'frame_index',
    'player',
    'type',
    'speed_kmh',
    'point_index',
    'ball',
    'player_position',
    'confidence',
  ],
  properties: {
    timestamp_seconds: { type: 'number' },
    frame_index: { type: 'integer' },
    player: COURT_SIDE,
    type: { type: 'string', enum: ['serve', 'volley', 'forehand', 'backhand'] },
    speed_kmh: NULLABLE_NUMBER,
    point_index: { type: 'integer' },
    ball: {
      type: 'object',
      additionalProperties: false,
      required: ['x', 'y', 'z'],
      properties: { x: NULLABLE_NUMBER, y: NULLABLE_NUMBER, z: NULLABLE_NUMBER },
    },
    player_position: {
      type: 'object',
      additionalProperties: false,
      required: ['x', 'y'],
      properties: { x: { type: 'number' }, y: { type: 'number' } },
    },
    confidence: { type: 'number' },
  },
} as const;

const MATCH_TELEMETRY_OBJECT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['version', 'video', 'court', 'frames', 'events'],
  properties: {
    version: { type: 'integer' },
    video: {
      type: 'object',
      additionalProperties: false,
      required: ['fps', 'width', 'height', 'frame_count'],
      properties: {
        fps: NULLABLE_NUMBER,
        width: { type: 'integer', minimum: 0 },
        height: { type: 'integer', minimum: 0 },
        frame_count: { type: 'integer', minimum: 0 },
      },
    },
    court: {
      type: 'object',
      additionalProperties: false,
      required: ['length_meters', 'width_meters', 'calibrated'],
      properties: {
        length_meters: { type: 'number' },
        width_meters: { type: 'number' },
        calibrated: { type: 'boolean' },
      },
    },
    frames: { type: 'array', items: FRAME_SCHEMA },
    events: {
      type: 'object',
      additionalProperties: false,
      required: ['bounces', 'hits'],
      properties: {
        bounces: { type: 'array', items: BOUNCE_SCHEMA },
        hits: { type: 'array', items: HIT_SCHEMA },
      },
    },
  },
} as const;

const TELEMETRY_RESPONSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['matchId', 'telemetry'],
  properties: {
    matchId: { type: 'string' },
    telemetry: MATCH_TELEMETRY_OBJECT_SCHEMA,
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
        telemetry: MATCH_TELEMETRY_OBJECT_SCHEMA,
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