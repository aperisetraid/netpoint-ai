import type { BounceEvent, HitEvent, PlayerSide } from '../services/api'

/**
 * Ball flight rebuilt from the detected events for the 3D replay. Between two consecutive events
 * (hit → bounce, bounce → hit, hit → hit) the ball follows the parabola that joins both positions
 * in the measured time: a physical reconstruction, not the tracked points one by one.
 * Court metres as in the telemetry: x along the court from the far baseline, y across it, z up.
 */
export interface Point3 {
  x: number
  y: number
  z: number
}

export interface FlightSegment {
  start: Point3
  end: Point3
  startTime: number
  endTime: number
  /** Launch velocity (m/s) of the parabola. */
  velocity: Point3
  /** Player whose shot this flight belongs to (it keeps that colour after the bounce). */
  shooter: PlayerSide
  /** Index in the hits array of the shot this flight belongs to; -1 before the first hit. */
  hitIndex: number
}

export interface ShotFlight {
  hit: HitEvent
  hitIndex: number
  /** Height of the ball at contact, when the telemetry has it. */
  contactHeight: number | null
  /** Height above the net tape where the shot crosses it; negative means into the net. */
  netClearance: number | null
  /** Highest point of the flight after the contact. */
  apexHeight: number | null
}

export const GRAVITY = 9.81
export const COURT_LENGTH = 23.77
export const COURT_WIDTH = 10.97
export const NET_X = COURT_LENGTH / 2
const NET_CENTER_HEIGHT = 0.914
const NET_POST_HEIGHT = 1.07
/** Posts stand 0.914 m outside the doubles sidelines. */
const NET_POST_OFFSET = 0.914

/** Longest gap that still counts as one flight; longer ones are a missed event or a new point. */
const MAX_FLIGHT_SECONDS: Record<string, number> = {
  'hit-bounce': 2.5,
  'hit-hit': 2.5,
  'bounce-hit': 1.5,
  'bounce-bounce': 1,
}
/** Contact height assumed when the telemetry has no 3D contact point. */
const FALLBACK_CONTACT_HEIGHT = { serve: 2.6, other: 1 }

type TimedEvent =
  | { kind: 'hit'; time: number; hit: HitEvent; hitIndex: number }
  | { kind: 'bounce'; time: number; bounce: BounceEvent }

function isFiniteNumber(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

export function contactPoint(hit: HitEvent): Point3 {
  const { ball, player_position: player } = hit
  if (isFiniteNumber(ball.x) && isFiniteNumber(ball.y) && isFiniteNumber(ball.z)) {
    return { x: ball.x, y: ball.y, z: Math.max(0, ball.z) }
  }
  return {
    x: player.x,
    y: player.y,
    z: hit.type === 'serve' ? FALLBACK_CONTACT_HEIGHT.serve : FALLBACK_CONTACT_HEIGHT.other,
  }
}

function eventPoint(event: TimedEvent): Point3 {
  return event.kind === 'hit'
    ? contactPoint(event.hit)
    : { x: event.bounce.x_meters, y: event.bounce.y_meters, z: 0 }
}

/** Velocity that takes the ball from `start` to `end` in `duration` seconds under gravity. */
export function launchVelocity(start: Point3, end: Point3, duration: number): Point3 {
  return {
    x: (end.x - start.x) / duration,
    y: (end.y - start.y) / duration,
    z: (end.z - start.z) / duration + (GRAVITY * duration) / 2,
  }
}

export function buildFlightSegments(hits: HitEvent[], bounces: BounceEvent[]): FlightSegment[] {
  const events: TimedEvent[] = [
    ...hits.map((hit, hitIndex) => ({ kind: 'hit' as const, time: hit.timestamp_seconds, hit, hitIndex })),
    ...bounces.map((bounce) => ({ kind: 'bounce' as const, time: bounce.timestamp_seconds, bounce })),
  ].sort((a, b) => a.time - b.time)

  const segments: FlightSegment[] = []
  let shooter: PlayerSide | null = null
  let hitIndex = -1
  for (let index = 0; index < events.length - 1; index += 1) {
    const from = events[index]
    const to = events[index + 1]
    if (from.kind === 'hit') {
      shooter = from.hit.player
      hitIndex = from.hitIndex
    }
    const duration = to.time - from.time
    if (!(duration > 0) || duration > MAX_FLIGHT_SECONDS[`${from.kind}-${to.kind}`]) continue
    const start = eventPoint(from)
    const end = eventPoint(to)
    // A bounce with no hit before it: the ball came from the other half.
    const owner = shooter ?? (from.kind === 'bounce' && from.bounce.side === 'near' ? 'far' : 'near')
    segments.push({
      start,
      end,
      startTime: from.time,
      endTime: to.time,
      velocity: launchVelocity(start, end, duration),
      shooter: owner,
      hitIndex,
    })
  }
  return segments
}

export function positionOnSegment(segment: FlightSegment, time: number): Point3 {
  const t = Math.min(Math.max(time - segment.startTime, 0), segment.endTime - segment.startTime)
  return {
    x: segment.start.x + segment.velocity.x * t,
    y: segment.start.y + segment.velocity.y * t,
    z: Math.max(0, segment.start.z + segment.velocity.z * t - (GRAVITY * t * t) / 2),
  }
}

/** Evenly spaced points along a flight, for drawing its arc. */
export function sampleSegment(segment: FlightSegment, steps = 32): Point3[] {
  const duration = segment.endTime - segment.startTime
  return Array.from({ length: steps + 1 }, (_, step) =>
    positionOnSegment(segment, segment.startTime + (duration * step) / steps),
  )
}

/** The flight the ball is on at `time`, if any. */
export function segmentAt(segments: FlightSegment[], time: number): FlightSegment | null {
  return segments.find((segment) => time >= segment.startTime && time <= segment.endTime) ?? null
}

/** Height of the net tape at a point across the court (it sags towards the centre strap). */
export function netHeightAt(y: number): number {
  const halfSpan = COURT_WIDTH / 2 + NET_POST_OFFSET
  const fromCentre = Math.min(Math.abs(y - COURT_WIDTH / 2), halfSpan)
  return NET_CENTER_HEIGHT + ((NET_POST_HEIGHT - NET_CENTER_HEIGHT) * fromCentre) / halfSpan
}

/** Clearance over the net where the flight crosses it; null when it does not cross. */
export function netClearance(segment: FlightSegment): number | null {
  const { start, end } = segment
  if ((start.x - NET_X) * (end.x - NET_X) >= 0 || segment.velocity.x === 0) return null
  const crossing = positionOnSegment(segment, segment.startTime + (NET_X - start.x) / segment.velocity.x)
  return crossing.z - netHeightAt(crossing.y)
}

function apexHeight(segment: FlightSegment): number {
  const peakTime = Math.min(Math.max(segment.velocity.z / GRAVITY, 0), segment.endTime - segment.startTime)
  return positionOnSegment(segment, segment.startTime + peakTime).z
}

/** Per-shot figures for the replay: contact height, net clearance and apex of the first flight. */
export function describeShots(hits: HitEvent[], segments: FlightSegment[]): ShotFlight[] {
  return hits.map((hit, hitIndex) => {
    const flight = segments.find(
      (segment) => segment.hitIndex === hitIndex && segment.startTime === hit.timestamp_seconds,
    )
    const { ball } = hit
    return {
      hit,
      hitIndex,
      contactHeight: isFiniteNumber(ball.z) ? Math.max(0, ball.z) : null,
      netClearance: flight ? netClearance(flight) : null,
      apexHeight: flight ? apexHeight(flight) : null,
    }
  })
}

/** A seek lands a hair before the requested time (the video rounds it); far less than a frame. */
const SEEK_TOLERANCE_SECONDS = 0.005

/** Index of the last shot played at `time`, or -1 before the first one. */
export function currentShotIndex(hits: HitEvent[], time: number): number {
  let current = -1
  hits.forEach((hit, index) => {
    if (hit.timestamp_seconds <= time + SEEK_TOLERANCE_SECONDS) current = index
  })
  return current
}
