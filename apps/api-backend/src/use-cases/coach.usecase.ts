import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';

import { longRunningFetch } from '../infrastructure/long-running-fetch.js';
import { visionUrl } from '../infrastructure/vision-url.js';
import { MatchNotFoundError } from './get-telemetry.usecase.js';
import { VisionServiceError } from './process-match.usecase.js';

export type CoachPerspective = 'far' | 'near' | 'coach';

export interface CoachMessageRequest {
  message: string;
  players?: { far?: string; near?: string };
  perspective?: CoachPerspective | null;
  currentTime?: number | null;
}

const COACH_REFUSALS = [401, 409, 422, 429] as const;
export type CoachRefusal = (typeof COACH_REFUSALS)[number];

/**
 * A request the vision service refused for a reason the user can act on: a missing or wrong access
 * code, the daily cap, a turn still running or incompatible data.
 */
export class CoachRequestError extends Error {
  constructor(
    message: string,
    readonly status: CoachRefusal,
  ) {
    super(message);
    this.name = 'CoachRequestError';
  }
}

export interface CoachDependencies {
  fetchImpl?: typeof fetch;
}

/**
 * Gateway to the vision service's coach. The conversation and the match data live next to the
 * analysis in Python; this layer validates, maps errors and passes the SSE stream through untouched.
 */
export class CoachUseCase {
  private readonly fetchImpl: typeof fetch;

  constructor({ fetchImpl = longRunningFetch }: CoachDependencies = {}) {
    this.fetchImpl = fetchImpl;
  }

  async getSession(matchId: string): Promise<unknown> {
    const response = await this.request(matchId, '', { method: 'GET' }, undefined);
    try {
      return await response.json();
    } catch {
      throw new VisionServiceError('The Python vision service returned invalid JSON.');
    }
  }

  async reset(matchId: string, accessCode?: string): Promise<void> {
    await this.request(matchId, '', { method: 'DELETE' }, accessCode);
  }

  /** Opens the coach's event stream; the caller forwards it to the browser as it arrives. */
  async streamMessage(matchId: string, body: CoachMessageRequest, accessCode?: string): Promise<Readable> {
    const response = await this.request(
      matchId,
      '/messages',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify(body),
      },
      accessCode,
    );
    if (!response.body) {
      throw new VisionServiceError('The Python vision service returned an empty stream.');
    }
    return Readable.fromWeb(response.body as unknown as WebReadableStream<Uint8Array>);
  }

  private async request(
    matchId: string,
    path: string,
    init: RequestInit,
    accessCode: string | undefined,
  ): Promise<Response> {
    const headers = new Headers(init.headers);
    if (accessCode) headers.set('X-Access-Code', accessCode);
    let response: Response;
    try {
      response = await this.fetchImpl(visionUrl(`/coach/${encodeURIComponent(matchId)}${path}`), {
        ...init,
        headers,
      });
    } catch {
      throw new VisionServiceError('Could not connect to the Python vision service.');
    }

    if (response.ok) {
      return response;
    }
    if (response.status === 404) {
      throw new MatchNotFoundError(matchId);
    }
    if ((COACH_REFUSALS as readonly number[]).includes(response.status)) {
      throw new CoachRequestError(await readDetail(response), response.status as CoachRefusal);
    }
    throw new VisionServiceError(`The Python vision service returned status ${response.status}.`);
  }
}

async function readDetail(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as { detail?: unknown };
    if (typeof payload.detail === 'string') {
      return payload.detail;
    }
  } catch {
    // Fall through to the generic message.
  }
  return 'The coach could not accept this request.';
}
