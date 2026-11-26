/** Whether this build is the public read-only demo: stored matches only, no new analyses. */
export function parseDemoMode(value: unknown): boolean {
  return value === true || value === '1' || value === 'true'
}
