/**
 * The public demo runs on free hosting that puts its services to sleep after a while without visits. The
 * first request then fails (the API answers 502 while the vision service wakes) or cannot connect at all,
 * for up to a minute. Instead of an error, the library keeps retrying while it explains the wait.
 */

/** How long to keep retrying before giving up; waking both services takes about a minute. */
export const WAKE_WINDOW_MS = 120_000
/** A load still running after this long is probably a sleeping service: say so. */
export const SLOW_LOAD_MS = 4_000
const RETRY_DELAYS_MS = [2_000, 3_000, 5_000]

/** Pause before retry number `attempt` (0-based). */
export function wakeRetryDelay(attempt: number): number {
  return RETRY_DELAYS_MS[Math.min(Math.max(attempt, 0), RETRY_DELAYS_MS.length - 1)]
}

/**
 * Whether a failed load is worth retrying: no answer at all (`status` undefined) or a server error, still
 * within the wake window. A 4xx is a real answer, not a sleeping service.
 */
export function shouldKeepWaking(status: number | undefined, elapsedMs: number): boolean {
  return (status === undefined || status >= 500) && elapsedMs < WAKE_WINDOW_MS
}
