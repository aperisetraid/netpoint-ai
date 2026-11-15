export type Point = [number, number]
export type Homography = [number, number, number, number, number, number, number, number, number]

const courtLengthMeters = 23.77
const courtWidthMeters = 10.97

export interface ContainRect {
  x: number
  y: number
  scale: number
}

/** Where media of the given size lands inside a box that letterboxes it (`object-fit: contain`). */
export function containRect(
  boxWidth: number,
  boxHeight: number,
  mediaWidth: number,
  mediaHeight: number,
): ContainRect {
  if (boxWidth <= 0 || boxHeight <= 0 || mediaWidth <= 0 || mediaHeight <= 0) {
    return { x: 0, y: 0, scale: 0 }
  }
  const scale = Math.min(boxWidth / mediaWidth, boxHeight / mediaHeight)
  return {
    x: (boxWidth - mediaWidth * scale) / 2,
    y: (boxHeight - mediaHeight * scale) / 2,
    scale,
  }
}

/** Homography taking each `source` point to its `target`; null when the points are degenerate. */
export function solveHomography(source: Point[], target: Point[]): Homography | null {
  const rows: number[][] = []
  for (let index = 0; index < 4; index++) {
    const [x, y] = source[index]
    const [u, v] = target[index]
    rows.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u])
    rows.push([0, 0, 0, x, y, 1, -v * x, -v * y, v])
  }

  for (let column = 0; column < 8; column++) {
    let pivot = column
    for (let row = column + 1; row < 8; row++) {
      if (Math.abs(rows[row][column]) > Math.abs(rows[pivot][column])) pivot = row
    }
    if (Math.abs(rows[pivot][column]) < 1e-10) return null
    ;[rows[column], rows[pivot]] = [rows[pivot], rows[column]]
    for (let row = 0; row < 8; row++) {
      if (row === column) continue
      const factor = rows[row][column] / rows[column][column]
      for (let index = column; index < 9; index++) rows[row][index] -= factor * rows[column][index]
    }
  }
  const solution = rows.map((row, index) => row[8] / row[index])
  return [...solution, 1] as Homography
}

/** Court meters (x along the length, far baseline at 0) to image pixels, from TL, TR, BR, BL corners. */
export function courtToImageHomography(corners: Point[] | null | undefined): Homography | null {
  if (!corners || corners.length !== 4) return null
  return solveHomography(
    [[0, 0], [0, courtWidthMeters], [courtLengthMeters, courtWidthMeters], [courtLengthMeters, 0]],
    corners,
  )
}

export function applyHomography(homography: Homography, x: number, y: number): Point {
  const w = homography[6] * x + homography[7] * y + homography[8]
  return [
    (homography[0] * x + homography[1] * y + homography[2]) / w,
    (homography[3] * x + homography[4] * y + homography[5]) / w,
  ]
}
