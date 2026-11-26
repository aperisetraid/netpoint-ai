import {
  CapsuleGeometry,
  CircleGeometry,
  CylinderGeometry,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  Quaternion,
  SphereGeometry,
  TorusGeometry,
  Vector3,
} from 'three'

import {
  type Aim,
  type Hand,
  playerShift,
  RACKET_REACH,
  racketAim,
  SHOULDER_HEIGHT,
  type Swing,
} from '../../lib/playerPose.ts'
import { courtPalette } from '../../lib/palette.ts'
import type { PlayerSide } from '../../services/api'

const SHOULDER_HALF_WIDTH = 0.24
const ARM_RADIUS = 0.055
const ARM_LENGTH = 0.55
const HAND_DROP = ARM_LENGTH + ARM_RADIUS * 2
const HEAD_RADIUS = 0.14
const HEAD_STRETCH = 1.3
/** Sized so the head centre sits at `RACKET_REACH` from the shoulder, as the pose assumes. */
const HANDLE_LENGTH = RACKET_REACH - HAND_DROP - HEAD_RADIUS * HEAD_STRETCH
/** How much of the arm's turn the shoulders follow, and their limit. */
const TORSO_FOLLOW = 0.35
const TORSO_MAX_TURN = 0.6
/** The racket arm is modelled hanging down; the pose rotates it from there. */
const ARM_AXIS = new Vector3(0, -1, 0)

/**
 * Stylised player: legs, torso, head and a racket arm that swings at each hit. Built in the player's
 * own frame (right +x, up +y, facing −z) and turned to face the net; one unit is one metre.
 */
export class PlayerFigure {
  readonly root = new Group()
  private readonly torso = new Group()
  private readonly racketArm = new Group()
  private readonly hand: Hand
  private readonly swings: Swing[]
  private readonly toScene: (x: number, y: number, z: number) => Vector3
  private readonly direction = new Vector3()
  private readonly rotation = new Quaternion()

  constructor(
    side: PlayerSide,
    color: string,
    hand: Hand,
    swings: Swing[],
    toScene: (x: number, y: number, z: number) => Vector3,
  ) {
    this.hand = hand
    this.swings = swings
    this.toScene = toScene
    // Facing the net: the near player looks down −z already, the far one is turned round.
    this.root.rotation.y = side === 'far' ? Math.PI : 0

    const body = new MeshLambertMaterial({ color })
    for (const offset of [-0.15, 0.15]) {
      const leg = new Mesh(new CapsuleGeometry(0.075, 0.72, 4, 10), body)
      leg.position.set(offset, 0.435, 0)
      leg.rotation.z = offset * 0.5
      this.root.add(leg)
    }

    const chest = new Mesh(new CapsuleGeometry(0.17, 0.42, 4, 14), body)
    chest.position.y = 1.15
    const head = new Mesh(new SphereGeometry(0.12, 16, 12), body)
    head.position.y = 1.72
    const freeArm = new Mesh(new CapsuleGeometry(ARM_RADIUS, ARM_LENGTH, 4, 10), body)
    freeArm.position.set(-hand * (SHOULDER_HALF_WIDTH + 0.04), SHOULDER_HEIGHT - 0.3, -0.08)
    freeArm.rotation.set(0.35, 0, -hand * 0.2)
    this.torso.add(chest, head, freeArm)

    const arm = new Mesh(new CapsuleGeometry(ARM_RADIUS, ARM_LENGTH, 4, 10), body)
    arm.position.y = -HAND_DROP / 2
    const frame = new MeshLambertMaterial({ color: courtPalette.line })
    const handle = new Mesh(new CylinderGeometry(0.02, 0.02, HANDLE_LENGTH, 8), frame)
    handle.position.y = -HAND_DROP - HANDLE_LENGTH / 2
    const headCentre = -HAND_DROP - HANDLE_LENGTH - HEAD_RADIUS * HEAD_STRETCH
    const rim = new Mesh(new TorusGeometry(HEAD_RADIUS, 0.014, 6, 28), frame)
    rim.scale.y = HEAD_STRETCH
    rim.position.y = headCentre
    const strings = new Mesh(
      new CircleGeometry(HEAD_RADIUS, 28),
      new MeshBasicMaterial({ color: courtPalette.line, transparent: true, opacity: 0.22, side: DoubleSide, depthWrite: false }),
    )
    strings.scale.y = HEAD_STRETCH
    strings.position.y = headCentre
    this.racketArm.add(arm, handle, rim, strings)

    const base = new Mesh(
      new CircleGeometry(0.42, 28),
      new MeshBasicMaterial({ color, transparent: true, opacity: 0.25, depthWrite: false }),
    )
    base.rotation.x = -Math.PI / 2
    base.position.y = 0.005

    this.root.add(this.torso, this.racketArm, base)
    this.root.visible = false
    this.pose(racketAim(swings, hand, -Infinity))
  }

  /**
   * Places the player at its detected court position (eased towards the ball around each contact) and
   * sets the swing for `time`; null hides it (not detected in this frame).
   */
  update(position: { x: number; y: number } | null, time: number): void {
    this.root.visible = position !== null
    if (!position) return
    const shift = playerShift(this.swings, time)
    this.root.position.copy(this.toScene(position.x + shift.x, position.y + shift.y, 0))
    this.pose(racketAim(this.swings, this.hand, time))
  }

  private pose({ yaw, pitch }: Aim): void {
    // The shoulders turn part of the way with the arm (positive yaw is to the right, i.e. −y rotation).
    const turn = Math.max(-TORSO_MAX_TURN, Math.min(TORSO_MAX_TURN, yaw * TORSO_FOLLOW))
    this.torso.rotation.y = -turn
    const shoulderX = this.hand * SHOULDER_HALF_WIDTH
    this.racketArm.position.set(shoulderX * Math.cos(turn), SHOULDER_HEIGHT, shoulderX * Math.sin(turn))

    this.direction.set(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch))
    this.racketArm.quaternion.copy(this.rotation.setFromUnitVectors(ARM_AXIS, this.direction))
  }
}
