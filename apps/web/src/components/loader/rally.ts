/** Deterministic rally model: every position is a pure function of time, so the sprites never drift out of sync. */

export const hitInterval = 1.1
const swingWindow = 0.14
const flashDuration = 0.16
const netClearance = 9
const bounceClearance = 4
const bouncePoint = 0.72

export interface RallyGeometry {
  leftX: number
  rightX: number
  yMin: number
  yMax: number
  /** Horizontal distance between a player's centre and the racket contact point. */
  reach: number
}

export type Side = 'left' | 'right'

export interface BallState {
  x: number
  y: number
  /** Height above the ground; the shadow stays at `y`. */
  z: number
}

export function createGeometry(width: number, height: number): RallyGeometry {
  return { leftX: 14, rightX: width - 15, yMin: 16, yMax: height - 16, reach: 5 }
}

const lerp = (from: number, to: number, amount: number) => from + (to - from) * amount
const clamp01 = (value: number) => Math.min(1, Math.max(0, value))
const smoothstep = (value: number) => value * value * (3 - 2 * value)
const isLeftHit = (index: number) => index % 2 === 0

function hitY(geometry: RallyGeometry, index: number): number {
  return lerp(geometry.yMin, geometry.yMax, 0.5 + 0.45 * Math.sin(index * 2.4 + 1))
}

function racketX(geometry: RallyGeometry, index: number): number {
  return isLeftHit(index) ? geometry.leftX + geometry.reach : geometry.rightX - geometry.reach
}

export function ballAt(geometry: RallyGeometry, time: number): BallState {
  const slot = time / hitInterval
  const index = Math.floor(slot)
  const progress = slot - index
  const z = progress < bouncePoint
    ? netClearance * Math.sin((Math.PI * progress) / bouncePoint)
    : bounceClearance * Math.sin((Math.PI * (progress - bouncePoint)) / (1 - bouncePoint))
  return {
    x: lerp(racketX(geometry, index), racketX(geometry, index + 1), progress),
    y: lerp(hitY(geometry, index), hitY(geometry, index + 1), progress),
    z,
  }
}

export function playerAt(geometry: RallyGeometry, side: Side, time: number): { y: number; swing: number } {
  const index = Math.floor(time / hitInterval)
  const previousHit = isLeftHit(index) === (side === 'left') ? index : index - 1
  const nextHit = previousHit + 2
  const moveStart = (previousHit + 0.3) * hitInterval
  const moveEnd = (nextHit - 0.12) * hitInterval
  const progress = smoothstep(clamp01((time - moveStart) / (moveEnd - moveStart)))
  const nearestHit = Math.min(Math.abs(time - previousHit * hitInterval), Math.abs(time - nextHit * hitInterval))
  return {
    y: lerp(hitY(geometry, previousHit), hitY(geometry, nextHit), progress),
    swing: Math.max(0, 1 - nearestHit / swingWindow),
  }
}

/** Contact spark shown right after each racket hit. */
export function hitFlashAt(geometry: RallyGeometry, time: number): { x: number; y: number; age: number } | null {
  const slot = time / hitInterval
  const index = Math.floor(slot)
  const age = (slot - index) * hitInterval
  return age < flashDuration ? { x: racketX(geometry, index), y: hitY(geometry, index), age } : null
}
