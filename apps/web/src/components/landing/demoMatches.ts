import test1Url from '../../../../assets/Test - Trim.mp4?url'
import test2Url from '../../../../assets/Test corto.mp4?url'

export interface DemoMatch {
  id: string
  title: string
  description: string
  fileName: string
  url: string
}

/** Clips shipped in the repository `apps/assets` folder. */
export const demoMatches: DemoMatch[] = [
  {
    id: 'test-1',
    title: 'Intercambio desde el fondo',
    description: 'Intercambio de fondo con saque y botes en pista.',
    fileName: 'Test - Trim.mp4',
    url: test1Url,
  },
  {
    id: 'test-2',
    title: 'Clip corto de juego',
    description: 'Secuencia breve de juego con golpes y botes.',
    fileName: 'Test corto.mp4',
    url: test2Url,
  },
]
