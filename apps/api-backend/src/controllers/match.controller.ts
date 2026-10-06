import type { FastifyReply, FastifyRequest } from 'fastify';

import type { MatchProcessRequest } from '../domain/match.entity.js';
import { MatchNotFoundError, GetTelemetryUseCase } from '../use-cases/get-telemetry.usecase.js';
import { ProcessMatchUseCase } from '../use-cases/process-match.usecase.js';

const PROCESS_MATCH_SCHEMA = {
  body: {
    type: 'object',
    additionalProperties: false,
    required: ['sourceUrl'],
    properties: {
      sourceUrl: { type: 'string', minLength: 1 },
      title: { type: 'string' },
    },
  },
  response: {
    202: {
      type: 'object',
      additionalProperties: false,
      required: ['matchId', 'status', 'message'],
      properties: {
        matchId: { type: 'string' },
        status: { type: 'string', enum: ['processing'] },
        message: { type: 'string' },
      },
    },
  },
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
    200: {
      type: 'object',
      additionalProperties: false,
      required: ['matchId', 'totalRallies', 'shots'],
      properties: {
        matchId: { type: 'string' },
        totalRallies: { type: 'integer' },
        shots: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: [
              'shotNumber',
              'timestamp',
              'player',
              'speedKmH',
              'bounceCoordinates',
              'isInside',
            ],
            properties: {
              shotNumber: { type: 'integer' },
              timestamp: { type: 'number' },
              player: { type: 'string', enum: ['player1', 'player2'] },
              speedKmH: { type: 'number' },
              bounceCoordinates: {
                type: 'object',
                additionalProperties: false,
                required: ['x', 'y'],
                properties: {
                  x: { type: 'number' },
                  y: { type: 'number' },
                },
              },
              isInside: { type: 'boolean' },
            },
          },
        },
      },
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

  readonly matchTelemetrySchema = MATCH_TELEMETRY_SCHEMA;

  constructor(private readonly dependencies: MatchControllerDependencies) {}

  async processMatch(
    request: FastifyRequest<{ Body: MatchProcessRequest }>,
    reply: FastifyReply,
  ): Promise<void> {
    if (!isValidHttpUrl(request.body.sourceUrl)) {
      await reply.status(400).send({ message: 'sourceUrl must be a valid http or https URL.' });
      return;
    }

    const response = this.dependencies.processMatchUseCase.execute(request.body);
    await reply.status(202).send(response);
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
}