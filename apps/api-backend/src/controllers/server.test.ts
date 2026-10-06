import assert from 'node:assert/strict';
import test from 'node:test';

import { buildApp } from './server.js';

const app = await buildApp();

test.after(async () => {
  await app.close();
});

test('POST /api/v1/matches/process returns unique match IDs and processing status', async () => {
  const payload = {
    sourceUrl: 'https://example.com/matches/final.mp4',
    title: 'Final ATP - Set 1',
  };

  const firstResponse = await app.inject({
    method: 'POST',
    url: '/api/v1/matches/process',
    payload,
  });
  const secondResponse = await app.inject({
    method: 'POST',
    url: '/api/v1/matches/process',
    payload,
  });

  assert.equal(firstResponse.statusCode, 202);
  assert.equal(secondResponse.statusCode, 202);

  const firstBody = firstResponse.json();
  const secondBody = secondResponse.json();

  assert.match(firstBody.matchId, /^[0-9a-f-]{36}$/i);
  assert.match(secondBody.matchId, /^[0-9a-f-]{36}$/i);
  assert.notEqual(firstBody.matchId, secondBody.matchId);
  assert.equal(firstBody.status, 'processing');
});

test('GET /api/v1/matches/:matchId/telemetry returns mock telemetry with consistent inside flags', async () => {
  const processResponse = await app.inject({
    method: 'POST',
    url: '/api/v1/matches/process',
    payload: {
      sourceUrl: 'https://example.com/matches/semifinal.mp4',
    },
  });

  const { matchId } = processResponse.json();
  const telemetryResponse = await app.inject({
    method: 'GET',
    url: `/api/v1/matches/${matchId}/telemetry`,
  });

  assert.equal(telemetryResponse.statusCode, 200);

  const telemetryBody = telemetryResponse.json();
  assert.equal(telemetryBody.matchId, matchId);
  assert.equal(telemetryBody.totalRallies, 4);
  assert.equal(telemetryBody.shots.length, 8);

  for (const shot of telemetryBody.shots) {
    const insideByCoordinates =
      shot.bounceCoordinates.x >= 0 &&
      shot.bounceCoordinates.x <= 8.23 &&
      shot.bounceCoordinates.y >= 0 &&
      shot.bounceCoordinates.y <= 23.77;

    assert.equal(shot.isInside, insideByCoordinates);
    assert.match(shot.player, /^player[12]$/);
  }
});

test('invalid payloads and IDs return 400 while unknown IDs return 404', async () => {
  const missingUrlResponse = await app.inject({
    method: 'POST',
    url: '/api/v1/matches/process',
    payload: {},
  });
  const invalidUrlResponse = await app.inject({
    method: 'POST',
    url: '/api/v1/matches/process',
    payload: { sourceUrl: 'not-a-url' },
  });
  const invalidMatchIdResponse = await app.inject({
    method: 'GET',
    url: '/api/v1/matches/not-a-uuid/telemetry',
  });
  const unknownMatchIdResponse = await app.inject({
    method: 'GET',
    url: '/api/v1/matches/123e4567-e89b-42d3-a456-426614174999/telemetry',
  });

  assert.equal(missingUrlResponse.statusCode, 400);
  assert.equal(invalidUrlResponse.statusCode, 400);
  assert.equal(invalidMatchIdResponse.statusCode, 400);
  assert.equal(unknownMatchIdResponse.statusCode, 404);
});

test('health and documentation endpoints are available', async () => {
  const healthResponse = await app.inject({
    method: 'GET',
    url: '/health',
  });
  const documentationResponse = await app.inject({
    method: 'GET',
    url: '/documentation/',
  });

  assert.equal(healthResponse.statusCode, 200);
  assert.equal(documentationResponse.statusCode, 200);
});