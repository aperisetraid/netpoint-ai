/** Index of the last entry whose time is at or before `time`, or -1; `times` must be ascending. */
export function findIndexAtOrBefore(times: ArrayLike<number>, time: number): number {
  let low = 0
  let high = times.length
  while (low < high) {
    const middle = (low + high) >> 1
    if (times[middle] <= time) low = middle + 1
    else high = middle
  }
  return low - 1
}

export function findFrameAt<Frame extends { timestamp_seconds: number }>(
  frames: Frame[],
  time: number,
): Frame | undefined {
  let low = 0
  let high = frames.length
  while (low < high) {
    const middle = (low + high) >> 1
    if (frames[middle].timestamp_seconds <= time) low = middle + 1
    else high = middle
  }
  return frames[low - 1]
}

/**
 * Playback time that shows the frame `step` positions away from `frameIndex` (-1 previous, +1 next),
 * or null at either end. It is the middle of that frame, not its start: a seek lands a hair before the
 * requested time, which would show the frame before it.
 */
export function frameStepTime<Frame extends { frame_index: number; timestamp_seconds: number }>(
  frames: Frame[],
  frameIndex: number,
  step: number,
): number | null {
  const position = frames.findIndex((frame) => frame.frame_index === frameIndex)
  const target = position + step
  if (position < 0 || target < 0 || target >= frames.length) return null
  const start = frames[target].timestamp_seconds
  const next = frames[target + 1]?.timestamp_seconds
  const previous = frames[target - 1]?.timestamp_seconds
  const duration = next !== undefined ? next - start : previous !== undefined ? start - previous : 0
  return start + duration / 2
}
