import type { FastifyInstance } from 'fastify';

import type { CoachUseCase } from '../use-cases/coach.usecase.js';
import { CoachController } from './coach.controller.js';
import { MatchController, type MatchControllerDependencies } from './match.controller.js';

export interface RouteDependencies extends MatchControllerDependencies {
  coachUseCase: CoachUseCase;
}

export async function registerRoutes(
  app: FastifyInstance,
  dependencies: RouteDependencies,
): Promise<void> {
  const matchController = new MatchController(dependencies);
  const coachController = new CoachController(dependencies.coachUseCase);

  app.get('/api/v1/matches', {
    schema: matchController.libraryListSchema,
    handler: matchController.listLibrary.bind(matchController),
  });

  app.get('/api/v1/matches/:matchId', {
    schema: matchController.libraryMatchSchema,
    handler: matchController.getLibraryMatch.bind(matchController),
  });

  app.post('/api/v1/matches/process', {
    schema: matchController.processMatchSchema,
    handler: matchController.processMatch.bind(matchController),
  });

  app.post('/api/v1/matches/upload', {
    bodyLimit: 1024 * 1024 * 1024,
    schema: matchController.uploadMatchSchema,
    handler: matchController.uploadMatch.bind(matchController),
  });

  app.get('/api/v1/matches/:matchId/telemetry', {
    schema: matchController.matchTelemetrySchema,
    handler: matchController.getTelemetry.bind(matchController),
  });

  app.get('/api/v1/matches/:matchId/progress', {
    schema: matchController.matchProgressSchema,
    handler: matchController.getProgress.bind(matchController),
  });

  app.get('/api/v1/matches/:matchId/coach', {
    schema: coachController.sessionSchema,
    handler: coachController.getSession.bind(coachController),
  });

  app.post('/api/v1/matches/:matchId/coach/messages', {
    schema: coachController.messageSchema,
    handler: coachController.postMessage.bind(coachController),
  });

  app.delete('/api/v1/matches/:matchId/coach', {
    schema: coachController.resetSchema,
    handler: coachController.reset.bind(coachController),
  });
}
