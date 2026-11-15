import type { HitEvent, PlayerSide, ShotType } from '../services/api'

export const shotTypes = [
  ['serve', 'Saque'],
  ['volley', 'Volea'],
  ['forehand', 'Derecha'],
  ['backhand', 'Revés'],
] as const satisfies readonly (readonly [ShotType, string])[]

export const shotTypeLabels: Record<ShotType, string> = Object.fromEntries(shotTypes) as Record<ShotType, string>
export const playerSides: readonly PlayerSide[] = ['far', 'near']

export interface ShotSummary {
  totalShots: number
  measuredShots: number
  maxSpeedKmh: number | null
  averageSpeedKmh: number | null
  byType: Record<ShotType, number>
}

export interface MatchShotSummary {
  match: ShotSummary & { pointCount: number }
  byPlayer: Record<PlayerSide, ShotSummary>
}

function summarize(hits: HitEvent[]): ShotSummary {
  const byType: Record<ShotType, number> = { serve: 0, volley: 0, forehand: 0, backhand: 0 }
  let measuredShots = 0
  let speedSum = 0
  let maxSpeedKmh: number | null = null
  for (const hit of hits) {
    byType[hit.type]++
    if (typeof hit.speed_kmh === 'number' && Number.isFinite(hit.speed_kmh)) {
      measuredShots++
      speedSum += hit.speed_kmh
      maxSpeedKmh = maxSpeedKmh === null ? hit.speed_kmh : Math.max(maxSpeedKmh, hit.speed_kmh)
    }
  }
  return {
    totalShots: hits.length,
    measuredShots,
    maxSpeedKmh,
    averageSpeedKmh: measuredShots ? speedSum / measuredShots : null,
    byType,
  }
}

export function summarizeShots(hits: HitEvent[]): MatchShotSummary {
  return {
    match: { ...summarize(hits), pointCount: new Set(hits.map((hit) => hit.point_index)).size },
    byPlayer: {
      far: summarize(hits.filter((hit) => hit.player === 'far')),
      near: summarize(hits.filter((hit) => hit.player === 'near')),
    },
  }
}
