import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { load as loadYaml } from 'js-yaml';

import { buildApp } from './server.js';

const pythonFrames = [
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
        z_meters: null,
      },
    ],
  },
];

const pythonTelemetry = {
  version: 2,
  video: { fps: 30, width: 1280, height: 720, frame_count: 1 },
  court: { length_meters: 23.77, width_meters: 10.97, calibrated: false },
  frames: pythonFrames,
  events: { bounces: [], hits: [] },
};

const pythonRequests: Array<{ url: string; payload: { youtubeUrl: string; matchId: string; title?: string } }> = [];

const app = await buildApp({
  fetchImpl: async (input, init) => {
    const payload = JSON.parse(String(init?.body)) as {
      youtubeUrl: string;
      matchId: string;
      title?: string;
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
      payload: { youtubeUrl: payload.sourceUrl, matchId: firstBody.matchId, title: payload.title },
    },
    {
      url: 'http://localhost:8000/process-video',
      payload: { youtubeUrl: payload.sourceUrl, matchId: secondBody.matchId, title: payload.title },
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

const libraryMatchId = '123e4567-e89b-42d3-a456-426614174020';
const librarySummary = {
  id: libraryMatchId,
  title: 'Final ATP - Set 1',
  createdAt: '2026-11-15T10:00:00+00:00',
  source: 'upload',
  videoFilename: 'final.mp4',
  hasVideo: true,
  fps: 25,
  width: 1920,
  height: 1080,
  frameCount: 447,
  durationSeconds: 17.88,
  calibrated: true,
  hitCount: 6,
  bounceCount: 3,
  maxSpeedKmh: 121.4,
};

test('GET /api/v1/matches lists the analyses stored by the vision service', async () => {
  const libraryApp = await buildApp({
    fetchImpl: async (input) => {
      assert.equal(String(input), 'http://localhost:8000/library/matches');
      return new Response(JSON.stringify([librarySummary, { ...librarySummary, id: 'x', extra: true }]));
    },
  });

  try {
    const response = await libraryApp.inject({ method: 'GET', url: '/api/v1/matches' });
    assert.equal(response.statusCode, 200);
    const [first, second] = response.json();
    assert.deepEqual(first, librarySummary);
    assert.equal('extra' in second, false);
  } finally {
    await libraryApp.close();
  }
});

test('GET /api/v1/matches/:matchId loads a stored analysis without reprocessing', async () => {
  const requested: string[] = [];
  const libraryApp = await buildApp({
    fetchImpl: async (input) => {
      requested.push(String(input));
      return new Response(
        JSON.stringify({ matchId: libraryMatchId, title: 'Final ATP - Set 1', telemetry: pythonTelemetry }),
      );
    },
  });

  try {
    const response = await libraryApp.inject({ method: 'GET', url: `/api/v1/matches/${libraryMatchId}` });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), {
      matchId: libraryMatchId,
      title: 'Final ATP - Set 1',
      telemetry: pythonTelemetry,
    });
    assert.deepEqual(requested, [`http://localhost:8000/library/matches/${libraryMatchId}`]);
  } finally {
    await libraryApp.close();
  }
});

test('library endpoints map vision errors to 400, 404 and 502', async () => {
  const status = { current: 404 };
  const libraryApp = await buildApp({
    fetchImpl: async () => new Response('{}', { status: status.current }),
  });
  const offlineApp = await buildApp({
    fetchImpl: async () => {
      throw new TypeError('connect ECONNREFUSED');
    },
  });

  try {
    const invalid = await libraryApp.inject({ method: 'GET', url: '/api/v1/matches/not-a-uuid' });
    const missing = await libraryApp.inject({ method: 'GET', url: `/api/v1/matches/${libraryMatchId}` });
    status.current = 500;
    const failing = await libraryApp.inject({ method: 'GET', url: '/api/v1/matches' });
    const offline = await offlineApp.inject({ method: 'GET', url: '/api/v1/matches' });

    assert.equal(invalid.statusCode, 400);
    assert.equal(missing.statusCode, 404);
    assert.equal(failing.statusCode, 502);
    assert.equal(offline.statusCode, 502);
  } finally {
    await libraryApp.close();
    await offlineApp.close();
  }
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
  const inspectedTelemetry = {
    ...pythonTelemetry,
    video: { fps: null, width: 1280, height: 720, frame_count: 2 },
    court: { ...pythonTelemetry.court, calibrated: true },
    frames: [{
      ...pythonFrames[0],
      court_corners: [[100, 50], [1100, 50], [1200, 650], [50, 650]],
      detections: [
        { ...pythonFrames[0].detections[0], carried_forward: true },
        { ...pythonFrames[0].detections[1], x_meters: 12.5, y_meters: 4.1, z_meters: 0.9 },
      ],
    }, {
      ...pythonFrames[0],
      frame_index: 1,
      court_corners: null,
    }],
    events: {
      bounces: [{
        timestamp_seconds: 0.52,
        frame_index: 15,
        x_meters: 6.6,
        y_meters: 5.8,
        side: 'far',
        confidence: 0.9,
        method: 'fit3d',
      }],
      hits: [{
        timestamp_seconds: 0.1,
        frame_index: 3,
        player: 'near',
        type: 'forehand',
        speed_kmh: null,
        point_index: 0,
        ball: { x: 21.5, y: 5.5, z: null },
        player_position: { x: 22.5, y: 5.6 },
        confidence: 0.5,
      }],
    },
  };
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

test('POST /api/v1/matches/process returns 502 for telemetry without frames and events', async () => {
  const legacyApp = await buildApp({
    fetchImpl: async () => new Response(JSON.stringify({ telemetry: pythonFrames })),
  });
  try {
    const response = await legacyApp.inject({
      method: 'POST',
      url: '/api/v1/matches/process',
      payload: { sourceUrl: 'https://example.com/video.mp4' },
    });
    assert.equal(response.statusCode, 502);
  } finally {
    await legacyApp.close();
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