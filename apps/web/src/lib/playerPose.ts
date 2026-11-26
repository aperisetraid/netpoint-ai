import type { HitEvent, PlayerSide, ShotType } from '../services/api'
import { contactPoint, type Point3 } from './flightPath.ts'

/**
 * Racket arm pose for the stylised players of the 3D replay. The telemetry only has where each player
 * stands, not their posture, so the swing is a stand-in: it is timed to every detected hit and, with
 * the player eased towards the ball around the contact, the racket passes through the measured
 * contact point.
 *
 * Angles live in the player's own frame, facing the net: yaw is 0 straight ahead and positive to the
 * player's right; pitch is 0 level and positive upwards.
 */
export interface Aim {
  yaw: number
  pitch: number
}

/** +1 right-handed, -1 left-handed. */
export type Hand = 1 | -1

export interface Swing {
  time: number
  type: ShotType
  /** Arm direction at the contact. */
  contact: Aim
  /** How far (court metres) the player must move for the racket to meet the ball at the contact. */
  shift: { x: number; y: number }
}

export const SHOULDER_HEIGHT = 1.42
/** Shoulder to the centre of the racket head with the arm straight (the 3D figure is built to it). */
export const RACKET_REACH = 1.14
/** Ready position: racket in front, slightly to the dominant side. */
const REST_YAW = 0.35
const REST_PITCH = -0.55

/** Seconds before and after the contact that the swing takes, per phase. */
const PHASES = { prepare: 0.55, backswing: 0.22, follow: 0.22, recover: 0.6 }
const VOLLEY_TIME_SCALE = 0.6
/**
 * The contact point and the player position carry metres of error, so some contacts land behind the
 * player; the arm never turns further than a shoulder can.
 */
const MAX_CONTACT_YAW = 2
const CONTACT_PITCH_RANGE = [-1.2, 1.45] as const
/** Larger gaps between the player and the ball are bad data, not a stretch. */
const MAX_SHIFT = 2.5
/** The player eases towards the contact over this long before and after it. */
const SHIFT_SECONDS = 0.5

/** Direction the player faces (towards the net) and their right, in court metres (x along, y across). */
export function playerFrame(side: PlayerSide): { forward: [number, number]; right: [number, number] } {
  return side === 'far' ? { forward: [1, 0], right: [0, -1] } : { forward: [-1, 0], right: [0, 1] }
}

/** Lateral (to the right) and forward offsets of a court point from the player. */
function localOffset(side: PlayerSide, from: { x: number; y: number }, to: { x: number; y: number }) {
  const { forward, right } = playerFrame(side)
  const dx = to.x - from.x
  const dy = to.y - from.y
  return { lateral: dx * right[0] + dy * right[1], forward: dx * forward[0] + dy * forward[1] }
}

/** Arm direction from the player's shoulder to a point, in the player's frame. */
export function aimAt(side: PlayerSide, player: { x: number; y: number }, point: Point3): Aim {
  const { lateral, forward } = localOffset(side, player, point)
  return {
    yaw: Math.atan2(lateral, forward),
    pitch: Math.atan2(point.z - SHOULDER_HEIGHT, Math.hypot(lateral, forward)),
  }
}

/**
 * Dominant hand from where the forehands and backhands were struck: a forehand lands on the racket
 * side, a backhand on the other. Right-handed when the hits do not tell.
 */
export function dominantHand(hits: HitEvent[], side: PlayerSide): Hand {
  let votes = 0
  for (const hit of hits) {
    if (hit.player !== side || (hit.type !== 'forehand' && hit.type !== 'backhand')) continue
    const { lateral } = localOffset(side, hit.player_position, contactPoint(hit))
    if (Math.abs(lateral) < 0.15) continue
    votes += Math.sign(lateral) * (hit.type === 'forehand' ? 1 : -1)
  }
  return votes < 0 ? -1 : 1
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}

export function buildSwings(hits: HitEvent[], side: PlayerSide): Swing[] {
  return hits
    .filter((hit) => hit.player === side)
    .map((hit) => {
      const point = contactPoint(hit)
      const player = hit.player_position
      const yaw = clamp(aimAt(side, player, point).yaw, -MAX_CONTACT_YAW, MAX_CONTACT_YAW)
      // The arm is straight at the contact: its height fixes the pitch, the rest is how far away to stand.
      const pitch = clamp(Math.asin(clamp((point.z - SHOULDER_HEIGHT) / RACKET_REACH, -1, 1)), ...CONTACT_PITCH_RANGE)
      const horizontal = RACKET_REACH * Math.cos(pitch)
      const { forward, right } = playerFrame(side)
      const lateral = Math.sin(yaw) * horizontal
      const ahead = Math.cos(yaw) * horizontal
      let shiftX = point.x - (player.x + right[0] * lateral + forward[0] * ahead)
      let shiftY = point.y - (player.y + right[1] * lateral + forward[1] * ahead)
      const length = Math.hypot(shiftX, shiftY)
      if (length > MAX_SHIFT) {
        shiftX *= MAX_SHIFT / length
        shiftY *= MAX_SHIFT / length
      }
      return { time: hit.timestamp_seconds, type: hit.type, contact: { yaw, pitch }, shift: { x: shiftX, y: shiftY } }
    })
}

export function restAim(hand: Hand): Aim {
  return { yaw: hand * REST_YAW, pitch: REST_PITCH }
}

/** Backswing and follow-through around the contact, by shot type. */
function swingKeys(swing: Swing, hand: Hand): { back: Aim; follow: Aim } {
  const { yaw, pitch } = swing.contact
  if (swing.type === 'serve') {
    // Racket dropped behind the back, up to the contact, then down across the body.
    return { back: { yaw: hand * 2.4, pitch: -0.6 }, follow: { yaw: -hand * 1, pitch: -1.1 } }
  }
  // The swing comes from behind on the side of the contact and finishes across the body.
  const sideOfContact = Math.abs(yaw) > 0.1 ? Math.sign(yaw) : hand
  if (swing.type === 'volley') {
    return {
      back: { yaw: yaw + sideOfContact * 0.5, pitch: pitch + 0.1 },
      follow: { yaw: yaw - sideOfContact * 0.4, pitch: pitch - 0.15 },
    }
  }
  return {
    back: { yaw: yaw + sideOfContact * 1.5, pitch: pitch + 0.15 },
    follow: { yaw: yaw - sideOfContact * 1.7, pitch: pitch + 0.7 },
  }
}

function smoothstep(value: number): number {
  const t = Math.min(1, Math.max(0, value))
  return t * t * (3 - 2 * t)
}

function blend(from: Aim, to: Aim, amount: number): Aim {
  const t = smoothstep(amount)
  return { yaw: from.yaw + (to.yaw - from.yaw) * t, pitch: from.pitch + (to.pitch - from.pitch) * t }
}

/** Racket arm direction at `time`: the ready position, or the phase of the swing in progress. */
export function racketAim(swings: Swing[], hand: Hand, time: number): Aim {
  const rest = restAim(hand)
  let closest: Swing | null = null
  for (const swing of swings) {
    if (!closest || Math.abs(swing.time - time) < Math.abs(closest.time - time)) closest = swing
  }
  if (!closest) return rest

  const scale = closest.type === 'volley' ? VOLLEY_TIME_SCALE : 1
  const prepare = PHASES.prepare * scale
  const backswing = PHASES.backswing * scale
  const follow = PHASES.follow * scale
  const recover = PHASES.recover * scale
  const since = time - closest.time
  if (since < -prepare || since > follow + recover) return rest

  const { back, follow: through } = swingKeys(closest, hand)
  if (since < -backswing) return blend(rest, back, (since + prepare) / (prepare - backswing))
  if (since < 0) return blend(back, closest.contact, (since + backswing) / backswing)
  if (since < follow) return blend(closest.contact, through, since / follow)
  return blend(through, rest, (since - follow) / recover)
}

/** Offset to add to the detected position at `time`: the full shift at a contact, none away from hits. */
export function playerShift(swings: Swing[], time: number): { x: number; y: number } {
  let x = 0
  let y = 0
  for (const swing of swings) {
    const weight = smoothstep(1 - Math.abs(time - swing.time) / SHIFT_SECONDS)
    x += swing.shift.x * weight
    y += swing.shift.y * weight
  }
  return { x, y }
}
