export interface DemoMatch {
  id: string
  title: string
  description: string
  fileName: string
  url: string
}

// The clips live in the repository-level `apps/assets` folder, which is not in git: a clean
// checkout (a CI or hosting build) has none, so they are optional instead of imported directly.
const clipUrls = import.meta.glob<string>(
  ['../../../../assets/Test - Trim.mp4', '../../../../assets/Test corto.mp4'],
  { query: '?url', import: 'default', eager: true },
)

const clips: Omit<DemoMatch, 'url'>[] = [
  {
    id: 'test-1',
    title: 'Intercambio desde el fondo',
    description: 'Intercambio de fondo con saque y botes en pista.',
    fileName: 'Test - Trim.mp4',
  },
  {
    id: 'test-2',
    title: 'Clip corto de juego',
    description: 'Secuencia breve de juego con golpes y botes.',
    fileName: 'Test corto.mp4',
  },
]

/** Clips shipped in the repository `apps/assets` folder, when it is present. */
export const demoMatches: DemoMatch[] = clips.flatMap((clip) => {
  const url = clipUrls[`../../../../assets/${clip.fileName}`]
  return url ? [{ ...clip, url }] : []
})
