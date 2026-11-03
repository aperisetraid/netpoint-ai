import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { load as loadYaml } from 'js-yaml';

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

test('POST /api/v1/matches/process accepts a client-generated match ID', async () => {
  const matchId = '123e4567-e89b-42d3-a456-426614174010';
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/matches/process',
    payload: { sourceUrl: 'https://example.com/match.mp4', matchId },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.json().matchId, matchId);
  assert.equal(pythonRequests.at(-1)?.payload.matchId, matchId);
});

test('GET /api/v1/matches/:matchId/progress proxies frame counts from Python', async () => {
  const matchId = '123e4567-e89b-42d3-a456-426614174011';
  const progressApp = await buildApp({
    fetchImpl: async (input) => {
      assert.equal(String(input), `http://localhost:8000/matches/${matchId}/progress`);
      return new Response(JSON.stringify({ processedFrames: 25, totalFrames: 447 }));
    },
  });

  try {
    const response = await progressApp.inject({
      method: 'GET',
      url: `/api/v1/matches/${matchId}/progress`,
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { processedFrames: 25, totalFrames: 447 });
  } finally {
    await progressApp.close();
  }
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

test('OpenAPI contract has no unresolved $ref', async () => {
  const specUrl = new URL('../../../../packages/openapi-spec/openapi.yaml', import.meta.url);
  const spec = loadYaml(await readFile(specUrl, 'utf8')) as Record<string, unknown>;

  const unresolved: string[] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (node === null || typeof node !== 'object') {
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === '$ref' && typeof value === 'string') {
        const target = value
          .replace(/^#\//, '')
          .split('/')
          .reduce<unknown>(
            (current, segment) => (current as Record<string, unknown> | undefined)?.[segment],
            spec,
          );
        if (target === undefined) {
          unresolved.push(value);
        }
      } else {
        visit(value);
      }
    }
  };
  visit(spec);

  assert.deepEqual(unresolved, []);
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

test('process and telemetry endpoints preserve frame inspection metadata', async () => {
  const inspectedTelemetry = [{
    ...pythonTelemetry[0],
    image_width: 1280,
    image_height: 720,
    court_corners: [[100, 50], [1100, 50], [1200, 650], [50, 650]],
    detections: [{ ...pythonTelemetry[0].detections[0], carried_forward: true }],
  }, {
    ...pythonTelemetry[0],
    frame_index: 1,
    image_width: 1280,
    image_height: 720,
    court_corners: null,
  }];
  const inspectionApp = await buildApp({
    fetchImpl: async () => new Response(JSON.stringify({ telemetry: inspectedTelemetry })),
  });
  try {
    const response = await inspectionApp.inject({
      method: 'POST',
      url: '/api/v1/matches/process',
      payload: { sourceUrl: 'https://example.com/video.mp4' },
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json().telemetry, inspectedTelemetry);
    const saved = await inspectionApp.inject({
      method: 'GET',
      url: `/api/v1/matches/${response.json().matchId}/telemetry`,
    });
    assert.equal(saved.statusCode, 200);
    assert.deepEqual(saved.json().telemetry, inspectedTelemetry);
  } finally {
    await inspectionApp.close();
  }
});

test('POST /api/v1/matches/upload streams an allowed video and stores its telemetry', async () => {
  const videoBytes = Buffer.from('small video test payload');
  const forwarded: { url?: string; filename?: string; matchId?: string; bytes: Buffer[] } = { bytes: [] };
  const uploadApp = await buildApp({
    fetchImpl: async (input, init) => {
      forwarded.url = String(input);
      forwarded.filename = new Headers(init?.headers).get('X-Video-Filename') ?? undefined;
      forwarded.matchId = new Headers(init?.headers).get('X-Match-Id') ?? undefined;
      for await (const chunk of init?.body as AsyncIterable<Uint8Array>) {
        forwarded.bytes.push(Buffer.from(chunk));
      }
      return new Response(JSON.stringify({ telemetry: pythonTelemetry }));
    },
  });

  try {
    const response = await uploadApp.inject({
      method: 'POST',
      url: '/api/v1/matches/upload',
      headers: {
        'content-type': 'application/octet-stream',
        'x-video-filename': 'final%20match.mp4',
        'x-match-id': '123e4567-e89b-42d3-a456-426614174012',
        'x-title': 'Final%20ATP',
      },
      payload: videoBytes,
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().matchId, '123e4567-e89b-42d3-a456-426614174012');
    assert.equal(forwarded.url, 'http://localhost:8000/process-upload');
    assert.equal(forwarded.filename, 'final%20match.mp4');
    assert.equal(forwarded.matchId, '123e4567-e89b-42d3-a456-426614174012');
    assert.deepEqual(Buffer.concat(forwarded.bytes), videoBytes);

    const telemetry = await uploadApp.inject({
      method: 'GET',
      url: `/api/v1/matches/${response.json().matchId}/telemetry`,
    });
    assert.equal(telemetry.statusCode, 200);
    assert.deepEqual(telemetry.json().telemetry, pythonTelemetry);
  } finally {
    await uploadApp.close();
  }
});

test('upload endpoint rejects unsupported file extensions', async () => {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/matches/upload',
    headers: {
      'content-type': 'application/octet-stream',
      'x-video-filename': 'payload.exe',
    },
    payload: Buffer.from('not a video'),
  });
  assert.equal(response.statusCode, 415);
});