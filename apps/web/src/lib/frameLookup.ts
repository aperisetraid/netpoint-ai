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
