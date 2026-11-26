import type { FastifyReply, FastifyRequest } from 'fastify';

import { MatchNotFoundError } from '../use-cases/get-telemetry.usecase.js';
import { CoachRequestError, type CoachMessageRequest, CoachUseCase } from '../use-cases/coach.usecase.js';
import { VisionServiceError } from '../use-cases/process-match.usecase.js';

const ERROR_RESPONSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['message'],
  properties: { message: { type: 'string' } },
} as const;

const MATCH_PARAMS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['matchId'],
  properties: { matchId: { type: 'string', format: 'uuid' } },
} as const;

const ERROR_RESPONSES = {
  400: ERROR_RESPONSE_SCHEMA,
  404: ERROR_RESPONSE_SCHEMA,
  409: ERROR_RESPONSE_SCHEMA,
  422: ERROR_RESPONSE_SCHEMA,
  502: ERROR_RESPONSE_SCHEMA,
} as const;

const TRANSCRIPT_ENTRY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'role', 'text', 'createdAt', 'tools'],
  properties: {
    id: { type: 'string' },
    role: { type: 'string', enum: ['user', 'assistant'] },
    text: { type: 'string' },
    createdAt: { type: 'string' },
    tools: { type: 'array', items: { type: 'string' } },
  },
} as const;

const COACH_SESSION_SCHEMA = {
  params: MATCH_PARAMS_SCHEMA,
  response: {
    200: {
      type: 'object',
      additionalProperties: false,
      required: ['available', 'model', 'messages', 'highlights', 'suggestions', 'reportPrompt'],
      properties: {
        available: { type: 'boolean' },
        model: { type: 'string' },
        messages: { type: 'array', items: TRANSCRIPT_ENTRY_SCHEMA },
        highlights: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['label', 'value', 'detail', 'time'],
            properties: {
              label: { type: 'string' },
              value: { type: 'string' },
              detail: { type: 'string' },
              time: { type: 'number' },
            },
          },
        },
        suggestions: { type: 'array', items: { type: 'string' } },
        reportPrompt: { type: 'string' },
      },
    },
    ...ERROR_RESPONSES,
  },
} as const;

const COACH_MESSAGE_SCHEMA = {
  params: MATCH_PARAMS_SCHEMA,
  body: {
    type: 'object',
    additionalProperties: false,
    required: ['message'],
    properties: {
      message: { type: 'string', minLength: 1, maxLength: 4000 },
      players: {
        type: 'object',
        additionalProperties: false,
        properties: {
          far: { type: 'string', maxLength: 80 },
          near: { type: 'string', maxLength: 80 },
        },
      },
      perspective: { anyOf: [{ type: 'string', enum: ['far', 'near', 'coach'] }, { type: 'null' }] },
      currentTime: { anyOf: [{ type: 'number', minimum: 0 }, { type: 'null' }] },
    },
  },
  // 200 is a text/event-stream passed through untouched, so it has no JSON schema.
  response: ERROR_RESPONSES,
} as const;

const COACH_RESET_SCHEMA = {
  params: MATCH_PARAMS_SCHEMA,
  response: { 204: { type: 'null' }, ...ERROR_RESPONSES },
} as const;

interface MatchParams {
  matchId: string;
}

export class CoachController {
  readonly sessionSchema = COACH_SESSION_SCHEMA;

  readonly messageSchema = COACH_MESSAGE_SCHEMA;

  readonly resetSchema = COACH_RESET_SCHEMA;

  constructor(private readonly coachUseCase: CoachUseCase) {}

  async getSession(request: FastifyRequest<{ Params: MatchParams }>, reply: FastifyReply): Promise<void> {
    await this.handle(reply, async () => {
      await reply.status(200).send(await this.coachUseCase.getSession(request.params.matchId));
    });
  }

  async postMessage(
    request: FastifyRequest<{ Params: MatchParams; Body: CoachMessageRequest }>,
    reply: FastifyReply,
  ): Promise<void> {
    await this.handle(reply, async () => {
      const stream = await this.coachUseCase.streamMessage(request.params.matchId, request.body);
      // Stop generating upstream when the browser goes away. (The request's own 'close' fires as soon
      // as its body is read, so the response is the reliable signal for a dropped connection.)
      reply.raw.on('close', () => {
        if (!reply.raw.writableFinished) stream.destroy();
      });
      await reply
        .status(200)
        .header('content-type', 'text/event-stream; charset=utf-8')
        .header('cache-control', 'no-cache')
        .header('x-accel-buffering', 'no')
        .send(stream);
    });
  }

  async reset(request: FastifyRequest<{ Params: MatchParams }>, reply: FastifyReply): Promise<void> {
    await this.handle(reply, async () => {
      await this.coachUseCase.reset(request.params.matchId);
      await reply.status(204).send();
    });
  }

  private async handle(reply: FastifyReply, action: () => Promise<void>): Promise<void> {
    try {
      await action();
    } catch (error) {
      if (error instanceof MatchNotFoundError) {
        await reply.status(404).send({ message: error.message });
        return;
      }
      if (error instanceof CoachRequestError) {
        await reply.status(error.status).send({ message: error.message });
        return;
      }
      if (error instanceof VisionServiceError) {
        await reply.status(502).send({ message: error.message });
        return;
      }
      throw error;
    }
  }
}
