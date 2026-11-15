import { Agent, fetch as undiciFetch } from 'undici';

/**
 * Analysing a video takes minutes and the vision service only answers when it finishes.
 * Node's default fetch gives up after 5 minutes without response headers (headersTimeout),
 * which surfaced as a 502 while the analysis was still running. Both timeouts are disabled here;
 * progress is tracked separately through the progress endpoint.
 */
const longRunningAgent = new Agent({ headersTimeout: 0, bodyTimeout: 0 });

export const longRunningFetch = ((input, init) =>
  undiciFetch(input as Parameters<typeof undiciFetch>[0], {
    ...(init as Parameters<typeof undiciFetch>[1]),
    dispatcher: longRunningAgent,
  })) as typeof fetch;
