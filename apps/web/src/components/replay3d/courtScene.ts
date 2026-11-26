import {
  BufferAttribute,
  BufferGeometry,
  CatmullRomCurve3,
  CircleGeometry,
  Color,
  CylinderGeometry,
  DirectionalLight,
  DoubleSide,
  Group,
  HemisphereLight,
  Line,
  LineBasicMaterial,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  type Object3D,
  PerspectiveCamera,
  PlaneGeometry,
  RingGeometry,
  Scene,
  SphereGeometry,
  TubeGeometry,
  Vector3,
  WebGLRenderer,
} from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'

import {
  COURT_LENGTH,
  COURT_WIDTH,
  type FlightSegment,
  NET_X,
  contactPoint,
  netHeightAt,
  positionOnSegment,
  sampleSegment,
  segmentAt,
} from '../../lib/flightPath.ts'
import type { CourtFill } from '../../lib/courtColors.ts'
import { courtPalette, sideColors } from '../../lib/palette.ts'
import { buildSwings, dominantHand } from '../../lib/playerPose.ts'
import type { BounceEvent, HitEvent, PlayerSide } from '../../services/api'
import { PlayerFigure } from './playerFigure'

export type CameraView = 'tv' | 'side' | 'top'

export interface ReplayPlayer {
  side: PlayerSide
  x: number
  y: number
}

export interface ReplayState {
  time: number
  players: ReplayPlayer[]
}

const LINE_WIDTH = 0.05
const SINGLES_INSET = 1.37
const SERVICE_DISTANCE = 6.4
/** The ball is drawn about three times its real size so it reads at broadcast distance. */
const BALL_RADIUS = 0.12
const ARC_RADIUS = 0.05
const ARC_STEPS = 48
const ARC_RADIAL = 6
const BOUNCE_PULSE_SECONDS = 0.6
const VIEW_TRANSITION_SECONDS = 0.7

/** Camera positions in scene units (x across, y up, z along the court towards the near baseline). */
const views: Record<CameraView, { position: [number, number, number]; target: [number, number, number] }> = {
  tv: { position: [0, 12, 30], target: [0, 0, 2.5] },
  side: { position: [-21, 7, 6], target: [0, 0.8, 0] },
  // Seen from straight above with the court lying across the screen, which suits a wide panel.
  top: { position: [-0.01, 34, 0], target: [0, 0, 0] },
}

/** Court metres (x along, y across, z up) → scene coordinates centred on the net. */
function toScene(x: number, y: number, z: number): Vector3 {
  return new Vector3(y - COURT_WIDTH / 2, z, x - NET_X)
}

function flatPlane(width: number, length: number, color: string, height: number): Mesh {
  const mesh = new Mesh(new PlaneGeometry(width, length), new MeshBasicMaterial({ color }))
  mesh.rotation.x = -Math.PI / 2
  mesh.position.y = height
  return mesh
}

function buildCourt(fill: CourtFill): Group {
  const court = new Group()
  court.add(flatPlane(COURT_WIDTH + 9, COURT_LENGTH + 13, fill.courtOuter, 0))
  court.add(flatPlane(COURT_WIDTH, COURT_LENGTH, fill.court, 0.001))

  const lineMaterial = new MeshBasicMaterial({ color: courtPalette.line })
  const addLine = (x1: number, y1: number, x2: number, y2: number) => {
    const length = Math.hypot(x2 - x1, y2 - y1) + LINE_WIDTH
    const along = x1 !== x2
    const mesh = new Mesh(
      new PlaneGeometry(along ? LINE_WIDTH : length, along ? length : LINE_WIDTH),
      lineMaterial,
    )
    mesh.rotation.x = -Math.PI / 2
    mesh.position.copy(toScene((x1 + x2) / 2, (y1 + y2) / 2, 0.003))
    court.add(mesh)
  }
  const near = COURT_LENGTH
  const singlesLeft = SINGLES_INSET
  const singlesRight = COURT_WIDTH - SINGLES_INSET
  addLine(0, 0, 0, COURT_WIDTH)
  addLine(near, 0, near, COURT_WIDTH)
  addLine(0, 0, near, 0)
  addLine(0, COURT_WIDTH, near, COURT_WIDTH)
  addLine(0, singlesLeft, near, singlesLeft)
  addLine(0, singlesRight, near, singlesRight)
  addLine(NET_X - SERVICE_DISTANCE, singlesLeft, NET_X - SERVICE_DISTANCE, singlesRight)
  addLine(NET_X + SERVICE_DISTANCE, singlesLeft, NET_X + SERVICE_DISTANCE, singlesRight)
  addLine(NET_X - SERVICE_DISTANCE, COURT_WIDTH / 2, NET_X + SERVICE_DISTANCE, COURT_WIDTH / 2)
  addLine(0, COURT_WIDTH / 2, 0.12, COURT_WIDTH / 2)
  addLine(near - 0.12, COURT_WIDTH / 2, near, COURT_WIDTH / 2)

  court.add(buildNet())
  return court
}

/** Net mesh whose top follows the sag from the posts to the centre strap. */
function buildNet(): Group {
  const net = new Group()
  const columns = 24
  const fromY = -0.914
  const toY = COURT_WIDTH + 0.914
  const positions: number[] = []
  const tape: Vector3[] = []
  for (let column = 0; column <= columns; column += 1) {
    const y = fromY + ((toY - fromY) * column) / columns
    const top = toScene(NET_X, y, netHeightAt(y))
    const bottom = toScene(NET_X, y, 0)
    positions.push(bottom.x, bottom.y, bottom.z, top.x, top.y, top.z)
    tape.push(top)
  }
  const indices: number[] = []
  for (let column = 0; column < columns; column += 1) {
    const a = column * 2
    indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3)
  }
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3))
  geometry.setIndex(indices)
  net.add(new Mesh(geometry, new MeshBasicMaterial({
    color: '#0b1320', transparent: true, opacity: 0.55, side: DoubleSide, depthWrite: false,
  })))
  net.add(new Line(new BufferGeometry().setFromPoints(tape), new LineBasicMaterial({ color: courtPalette.line })))

  const postMaterial = new MeshLambertMaterial({ color: '#c9d2dc' })
  for (const y of [fromY, toY]) {
    const post = new Mesh(new CylinderGeometry(0.04, 0.04, 1.07, 10), postMaterial)
    post.position.copy(toScene(NET_X, y, 1.07 / 2))
    net.add(post)
  }
  return net
}

interface Arc {
  segment: FlightSegment
  mesh: Mesh<TubeGeometry, MeshBasicMaterial>
  indexCount: number
}

interface Marker {
  time: number
  mesh: Mesh<BufferGeometry, MeshBasicMaterial>
}

/**
 * Three.js scene of the rally: court, net, players, ball and the reconstructed flight arcs.
 * The owner calls `render(state)` every animation frame with the playback time.
 */
export class CourtReplayScene {
  private readonly renderer: WebGLRenderer
  private readonly scene = new Scene()
  private readonly camera = new PerspectiveCamera(38, 1, 0.1, 200)
  private readonly controls: OrbitControls
  private readonly resizeObserver: ResizeObserver
  private readonly arcs: Arc[] = []
  private readonly bounceRings: Marker[] = []
  private readonly contacts: Marker[] = []
  private readonly ball: Mesh
  private readonly shadow: Mesh
  private readonly players: Record<PlayerSide, PlayerFigure>
  private transition: { from: Vector3; fromTarget: Vector3; to: Vector3; toTarget: Vector3; start: number } | null = null

  private readonly container: HTMLElement
  private readonly segments: FlightSegment[]

  constructor(
    container: HTMLElement,
    segments: FlightSegment[],
    hits: HitEvent[],
    bounces: BounceEvent[],
    fill: CourtFill,
  ) {
    this.container = container
    this.segments = segments
    this.renderer = new WebGLRenderer({ antialias: true, alpha: false })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.setClearColor(new Color(courtPalette.stage))
    container.appendChild(this.renderer.domElement)

    this.scene.add(new HemisphereLight('#ffffff', '#1b2a40', 2.2))
    const sun = new DirectionalLight('#ffffff', 1.4)
    sun.position.set(-8, 20, 10)
    this.scene.add(sun)
    this.scene.add(buildCourt(fill))

    for (const segment of segments) {
      const curve = new CatmullRomCurve3(sampleSegment(segment, 40).map((point) => toScene(point.x, point.y, point.z)))
      const geometry = new TubeGeometry(curve, ARC_STEPS, ARC_RADIUS, ARC_RADIAL, false)
      const mesh = new Mesh(geometry, new MeshBasicMaterial({ color: sideColors[segment.shooter], transparent: true }))
      this.arcs.push({ segment, mesh, indexCount: geometry.index?.count ?? 0 })
      this.scene.add(mesh)
    }

    const ringGeometry = new RingGeometry(0.14, 0.24, 32)
    for (const bounce of bounces) {
      const mesh = new Mesh(ringGeometry, new MeshBasicMaterial({
        color: sideColors[bounce.side], transparent: true, side: DoubleSide, depthWrite: false,
      }))
      mesh.rotation.x = -Math.PI / 2
      mesh.position.copy(toScene(bounce.x_meters, bounce.y_meters, 0.006))
      this.bounceRings.push({ time: bounce.timestamp_seconds, mesh })
      this.scene.add(mesh)
    }

    const contactGeometry = new SphereGeometry(0.06, 12, 12)
    for (const hit of hits) {
      const point = contactPoint(hit)
      const mesh = new Mesh(contactGeometry, new MeshBasicMaterial({ color: sideColors[hit.player], transparent: true }))
      mesh.position.copy(toScene(point.x, point.y, point.z))
      this.contacts.push({ time: hit.timestamp_seconds, mesh })
      this.scene.add(mesh)
    }

    this.ball = new Mesh(new SphereGeometry(BALL_RADIUS, 20, 20), new MeshBasicMaterial({ color: courtPalette.ball }))
    this.shadow = new Mesh(
      new CircleGeometry(BALL_RADIUS * 1.2, 24),
      new MeshBasicMaterial({ color: '#000000', transparent: true, opacity: 0.45, depthWrite: false }),
    )
    this.shadow.rotation.x = -Math.PI / 2
    this.scene.add(this.ball, this.shadow)

    const figure = (side: PlayerSide) => {
      const player = new PlayerFigure(side, sideColors[side], dominantHand(hits, side), buildSwings(hits, side), toScene)
      this.scene.add(player.root)
      return player
    }
    this.players = { far: figure('far'), near: figure('near') }

    this.controls = new OrbitControls(this.camera, this.renderer.domElement)
    this.controls.enableDamping = true
    this.controls.maxPolarAngle = Math.PI / 2 - 0.04
    this.controls.minDistance = 5
    this.controls.maxDistance = 60
    this.controls.addEventListener('start', () => { this.transition = null })
    this.setView('tv', false)

    this.resizeObserver = new ResizeObserver(() => this.resize())
    this.resizeObserver.observe(container)
    this.resize()
  }

  private resize(): void {
    const width = Math.max(1, this.container.clientWidth)
    const height = Math.max(1, this.container.clientHeight)
    this.renderer.setSize(width, height, false)
    this.camera.aspect = width / height
    this.camera.updateProjectionMatrix()
  }

  setView(view: CameraView, animate = true): void {
    const { position, target } = views[view]
    const to = new Vector3(...position)
    const toTarget = new Vector3(...target)
    if (!animate) {
      this.transition = null
      this.camera.position.copy(to)
      this.controls.target.copy(toTarget)
      this.controls.update()
      return
    }
    this.transition = {
      from: this.camera.position.clone(),
      fromTarget: this.controls.target.clone(),
      to,
      toTarget,
      start: performance.now(),
    }
  }

  private stepTransition(): void {
    if (!this.transition) return
    const { from, fromTarget, to, toTarget, start } = this.transition
    const progress = Math.min(1, (performance.now() - start) / (VIEW_TRANSITION_SECONDS * 1000))
    const eased = 1 - (1 - progress) ** 3
    this.camera.position.lerpVectors(from, to, eased)
    this.controls.target.lerpVectors(fromTarget, toTarget, eased)
    if (progress >= 1) this.transition = null
  }

  render({ time, players }: ReplayState): void {
    for (const { segment, mesh, indexCount } of this.arcs) {
      const duration = segment.endTime - segment.startTime
      if (time >= segment.endTime) {
        mesh.material.opacity = 0.85
        mesh.geometry.setDrawRange(0, Infinity)
      } else if (time >= segment.startTime) {
        const steps = Math.ceil(((time - segment.startTime) / duration) * ARC_STEPS)
        mesh.material.opacity = 1
        mesh.geometry.setDrawRange(0, Math.min(indexCount, steps * ARC_RADIAL * 6))
      } else {
        // The rest of the rally stays as a faint guide.
        mesh.material.opacity = 0.12
        mesh.geometry.setDrawRange(0, Infinity)
      }
    }

    for (const { time: bounceTime, mesh } of this.bounceRings) {
      const since = time - bounceTime
      mesh.visible = since >= 0
      const pulse = since >= 0 && since < BOUNCE_PULSE_SECONDS ? 1 - since / BOUNCE_PULSE_SECONDS : 0
      mesh.scale.setScalar(1 + pulse * 1.6)
      mesh.material.opacity = 0.95 - pulse * 0.5
    }
    for (const { time: hitTime, mesh } of this.contacts) {
      mesh.visible = time >= hitTime
    }

    const segment = segmentAt(this.segments, time)
    this.ball.visible = segment !== null
    this.shadow.visible = segment !== null
    if (segment) {
      const point = positionOnSegment(segment, time)
      this.ball.position.copy(toScene(point.x, point.y, point.z + BALL_RADIUS))
      this.shadow.position.copy(toScene(point.x, point.y, 0.008))
      const lift = Math.min(point.z / 4, 1)
      this.shadow.scale.setScalar(1 + lift * 0.6)
      ;(this.shadow.material as MeshBasicMaterial).opacity = 0.5 - lift * 0.3
    }

    for (const side of ['far', 'near'] as const) {
      const player = players.find((candidate) => candidate.side === side)
      this.players[side].update(player ?? null, time)
    }

    this.stepTransition()
    this.controls.update()
    this.renderer.render(this.scene, this.camera)
  }

  dispose(): void {
    this.resizeObserver.disconnect()
    this.controls.dispose()
    this.scene.traverse((object: Object3D) => {
      if (object instanceof Mesh || object instanceof Line) {
        object.geometry.dispose()
        const materials = Array.isArray(object.material) ? object.material : [object.material]
        for (const material of materials) material.dispose()
      }
    })
    this.renderer.dispose()
    this.renderer.domElement.remove()
  }
}
