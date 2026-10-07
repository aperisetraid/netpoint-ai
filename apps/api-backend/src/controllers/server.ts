import cors from '@fastify/cors';
import swagger from '@fastify/swagger';
import type { FastifyStaticSwaggerOptions } from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import Fastify, { type FastifyInstance } from 'fastify';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { load as loadYaml } from 'js-yaml';

import type { MatchRegistry } from '../domain/match.entity.js';
import { InMemoryMatchRegistry } from '../infrastructure/in-memory-match.registry.js';
import { registerRoutes } from './routes.js';
import { GetTelemetryUseCase } from '../use-cases/get-telemetry.usecase.js';
import { ProcessMatchUseCase } from '../use-cases/process-match.usecase.js';

export interface BuildAppOptions {
  logger?: boolean;
  matchRegistry?: MatchRegistry;
  fetchImpl?: typeof fetch;
}

type OpenApiDocument = Extract<FastifyStaticSwaggerOptions['specification'], { document: unknown }>['document'];

async function registerSwaggerUi(app: FastifyInstance): Promise<void> {
  const openapiFile = new URL('../../../../packages/openapi-spec/openapi.yaml', import.meta.url);
  const rawOpenApiDocument = await readFile(openapiFile, 'utf8');
  const openapiDocument = loadYaml(rawOpenApiDocument) as OpenApiDocument;

  await app.register(swagger, {
    mode: 'static',
    specification: {
      document: openapiDocument,
    },
  });

  await app.register(swaggerUi, {
    routePrefix: '/documentation',
  });
}

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger ?? false });
  const matchRegistry = options.matchRegistry ?? new InMemoryMatchRegistry();
  const processMatchUseCase = new ProcessMatchUseCase({
    matchRegistry,
    fetchImpl: options.fetchImpl,
  });
  const getTelemetryUseCase = new GetTelemetryUseCase(matchRegistry);

  await app.register(cors, { origin: true });
  await registerSwaggerUi(app);

  app.get('/health', async () => ({
    status: 'ok',
    service: 'NetPoint AI Backend',
  }));

  await registerRoutes(app, {
    processMatchUseCase,
    getTelemetryUseCase,
  });

  return app;
}

export async function startServer(): Promise<FastifyInstance> {
  const app = await buildApp({ logger: true });
  const port = Number(process.env.PORT ?? 3000);

  await app.listen({ port, host: '0.0.0.0' });
  return app;
}

const isDirectExecution =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectExecution) {
  startServer().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}