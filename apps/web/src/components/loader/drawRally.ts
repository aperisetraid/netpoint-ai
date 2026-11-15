import { ballAt, createGeometry, hitFlashAt, playerAt, type RallyGeometry, type Side } from './rally'

const palette = {
  background: '#0c1110',
  surface: '#17221c',
  stripe: '#1b2620',
  line: 'rgba(225, 239, 223, 0.6)',
  net: '#edf2e8',
  lime: '#bef264',
  limeDark: '#7fa844',
  racket: '#c9e795',
  ball: '#38bdf8',
  ballHighlight: '#e0f2fe',
  skin: '#d9c39a',
  hair: '#26352b',
  shadow: 'rgba(0, 0, 0, 0.38)',
}

const playerColors: Record<Side, { shirt: string; shorts: string }> = {
  left: { shirt: '#bef264', shorts: '#2d4a2a' },
  right: { shirt: '#d7e5cf', shorts: '#3d5a3c' },
}

const sprite = [
  '..hhh..',
  '..sss..',
  '..sss..',
  '.bbbbb.',
  'sbbbbbs',
  '.bbbbb.',
  '..ddd..',
  '..l.l..',
  '..l.l..',
]
const trailLength = 5
const trailStep = 0.032

function drawCourt(ctx: CanvasRenderingContext2D, width: number, height: number) {
  ctx.fillStyle = palette.background
  ctx.fillRect(0, 0, width, height)

  const left = 4
  const right = width - 5
  const top = 4
  const bottom = height - 5
  for (let x = left; x <= right; x += 12) {
    ctx.fillStyle = ((x - left) / 12) % 2 === 0 ? palette.surface : palette.stripe
    ctx.fillRect(x, top, Math.min(12, right - x + 1), bottom - top + 1)
  }

  ctx.fillStyle = palette.line
  const middle = Math.round(width / 2)
  const serviceOffset = Math.round(width * 0.22)
  const alley = 8
  ctx.fillRect(left, top, right - left + 1, 1)
  ctx.fillRect(left, bottom, right - left + 1, 1)
  ctx.fillRect(left, top, 1, bottom - top + 1)
  ctx.fillRect(right, top, 1, bottom - top + 1)
  ctx.fillRect(left, top + alley, right - left + 1, 1)
  ctx.fillRect(left, bottom - alley, right - left + 1, 1)
  ctx.fillRect(middle - serviceOffset, top + alley, 1, bottom - top - alley * 2 + 1)
  ctx.fillRect(middle + serviceOffset, top + alley, 1, bottom - top - alley * 2 + 1)
  ctx.fillRect(middle - serviceOffset, Math.round((top + bottom) / 2), serviceOffset * 2, 1)

  ctx.fillStyle = palette.net
  for (let y = top; y <= bottom; y += 4) ctx.fillRect(middle, y, 1, 2)
}

function drawPlayer(ctx: CanvasRenderingContext2D, geometry: RallyGeometry, side: Side, time: number) {
  const { y: rawY, swing } = playerAt(geometry, side, time)
  const direction = side === 'left' ? 1 : -1
  const x = Math.round(side === 'left' ? geometry.leftX : geometry.rightX)
  const y = Math.round(rawY)
  const colors = playerColors[side]
  const pixelColors: Record<string, string> = {
    h: palette.hair,
    s: palette.skin,
    b: colors.shirt,
    d: colors.shorts,
    l: palette.skin,
  }

  ctx.fillStyle = palette.shadow
  ctx.fillRect(x - 3, y + 4, 7, 1)
  sprite.forEach((row, rowIndex) => {
    for (let column = 0; column < row.length; column++) {
      const color = pixelColors[row[column]]
      if (!color) continue
      ctx.fillStyle = color
      ctx.fillRect(x - 3 + column, y - 5 + rowIndex, 1, 1)
    }
  })

  // Offsets are given for a player facing right and mirrored for the other side.
  const place = (offsetX: number, offsetY: number, width: number, height: number) => {
    ctx.fillRect(direction > 0 ? x + offsetX : x - offsetX - width + 1, y + offsetY, width, height)
  }
  ctx.fillStyle = palette.limeDark
  if (swing < 0.5) {
    place(4, -1, 1, 3)
    ctx.fillStyle = palette.racket
    place(3, -6, 3, 5)
    ctx.fillStyle = palette.surface
    place(4, -5, 1, 3)
  } else {
    place(4, 0, 2, 1)
    ctx.fillStyle = palette.racket
    place(5, -2, 5, 3)
    ctx.fillStyle = palette.surface
    place(6, -1, 3, 1)
  }
}

function drawBall(ctx: CanvasRenderingContext2D, geometry: RallyGeometry, time: number) {
  for (let step = trailLength; step >= 1; step--) {
    const past = ballAt(geometry, time - step * trailStep)
    ctx.globalAlpha = 0.5 - step * 0.08
    ctx.fillStyle = palette.ball
    const size = step > 3 ? 1 : 2
    ctx.fillRect(Math.round(past.x), Math.round(past.y - past.z), size, size)
  }
  ctx.globalAlpha = 1

  const ball = ballAt(geometry, time)
  const x = Math.round(ball.x)
  ctx.fillStyle = palette.shadow
  ctx.fillRect(x, Math.round(ball.y) + 1, 3, 1)
  const y = Math.round(ball.y - ball.z)
  ctx.fillStyle = palette.ball
  ctx.fillRect(x, y, 2, 2)
  ctx.fillStyle = palette.ballHighlight
  ctx.fillRect(x, y, 1, 1)
}

function drawHitFlash(ctx: CanvasRenderingContext2D, geometry: RallyGeometry, time: number) {
  const flash = hitFlashAt(geometry, time)
  if (!flash) return
  const distance = 2 + Math.round(flash.age * 18)
  const x = Math.round(flash.x)
  const y = Math.round(flash.y)
  ctx.fillStyle = palette.lime
  ctx.fillRect(x - distance, y, 1, 1)
  ctx.fillRect(x + distance, y, 1, 1)
  ctx.fillRect(x, y - distance, 1, 1)
  ctx.fillRect(x, y + distance, 1, 1)
}

/** Draws one frame of the pixel-art rally at `time` seconds into the canvas' own pixel grid. */
export function drawRally(ctx: CanvasRenderingContext2D, time: number) {
  const { width, height } = ctx.canvas
  const geometry = createGeometry(width, height)
  ctx.imageSmoothingEnabled = false
  drawCourt(ctx, width, height)
  drawPlayer(ctx, geometry, 'left', time)
  drawPlayer(ctx, geometry, 'right', time)
  drawHitFlash(ctx, geometry, time)
  drawBall(ctx, geometry, time)
}
