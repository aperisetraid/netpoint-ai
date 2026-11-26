const DEFAULT_VISION_BASE_URL = 'http://localhost:8000';

/**
 * Absolute URL of a vision-service endpoint. The base comes from VISION_BASE_URL so a deployment
 * can point the API at the hosted service; it is read on every call, which keeps tests simple.
 */
export function visionUrl(path: string): string {
  const base = (process.env.VISION_BASE_URL || DEFAULT_VISION_BASE_URL).replace(/\/+$/, '');
  return `${base}${path}`;
}
