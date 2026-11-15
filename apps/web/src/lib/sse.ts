/** Parses complete `data:` events out of an SSE buffer and returns the incomplete remainder. */
export function drainSseBuffer<T>(buffer: string, onEvent: (event: T) => void): string {
  const chunks = buffer.replace(/\r\n/g, '\n').split('\n\n')
  const rest = chunks.pop() ?? ''
  for (const chunk of chunks) {
    const data = chunk
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n')
    if (!data) continue
    try {
      onEvent(JSON.parse(data) as T)
    } catch {
      // A malformed event is skipped; the turn still ends with `done` or `error`.
    }
  }
  return rest
}
