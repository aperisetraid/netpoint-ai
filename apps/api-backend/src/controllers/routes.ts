import type { FastifyInstance } from 'fastify';

import { MatchController, type MatchControllerDependencies } from './match.controller.js';

export async function registerRoutes(
  app: FastifyInstance,
  dependencies: MatchControllerDependencies,
): Promise<void> {
  const matchController = new MatchController(dependencies);

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
}