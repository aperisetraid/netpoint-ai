import assert from 'node:assert/strict';
import test from 'node:test';

import { buildApp } from './server.js';

const pythonTelemetry = [
  {
    frame_index: 0,
    timestamp_seconds: 0,
    detections: [
      {
        class: 'player',
        confidence: 0.97,
        bbox: [10, 20, 30, 40],
        x_meters: 1.2,
        y_meters: 4.5,
      },
      {
        class: 'ball',
        confidence: 0.82,
        bbox: [40, 50, 46, 56],
        x_meters: null,
        y_meters: null,
      },
    ],
  },
];

const pythonRequests: Array<{ url: string; payload: { youtubeUrl: string; matchId: string } }> = [];

const app = await buildApp({
  fetchImpl: async (input, init) => {
    const payload = JSON.parse(String(init?.body)) as {
      youtubeUrl: string;
      matchId: string;
    };
    pythonRequests.push({ url: String(input), payload });

    return new Response(JSON.stringify({ matchId: payload.matchId, telemetry: pythonTelemetry }), {
      headers: { 'content-type': 'application/json' },
    });
  },
});

test.after(async () => {
  await app.close();
});

test('POST /api/v1/matches/process forwards the video and returns Python telemetry', async () => {
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

  assert.equal(firstResponse.statusCode, 200);
  assert.equal(secondResponse.statusCode, 200);

  const firstBody = firstResponse.json();
  const secondBody = secondResponse.json();

  assert.match(firstBody.matchId, /^[0-9a-f-]{36}$/i);
  assert.match(secondBody.matchId, /^[0-9a-f-]{36}$/i);
  assert.notEqual(firstBody.matchId, secondBody.matchId);
  assert.equal(firstBody.status, 'completed');
  assert.deepEqual(firstBody.telemetry, pythonTelemetry);
  assert.deepEqual(pythonRequests.slice(0, 2), [
    {
      url: 'http://localhost:8000/process-video',
      payload: { youtubeUrl: payload.sourceUrl, matchId: firstBody.matchId },
    },
    {
      url: 'http://localhost:8000/process-video',
      payload: { youtubeUrl: payload.sourceUrl, matchId: secondBody.matchId },
    },
  ]);
});

test('GET /api/v1/matches/:matchId/telemetry returns the Python telemetry saved for the match', async () => {
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
  assert.deepEqual(telemetryBody, {
    matchId,
    telemetry: pythonTelemetry,
  });
});

test('POST /api/v1/matches/process returns 502 when the Python service fails', async () => {
  const failingApp = await buildApp({
    fetchImpl: async () => new Response('service unavailable', { status: 503 }),
  });

  try {
    const response = await failingApp.inject({
      method: 'POST',
      url: '/api/v1/matches/process',
      payload: { sourceUrl: 'https://example.com/matches/final.mp4' },
    });

    assert.equal(response.statusCode, 502);
    assert.match(response.json().message, /status 503/);
  } finally {
    await failingApp.close();
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