import test1Url from '../../../../../assets/Test 1 - Trim.mp4?url'
import test2Url from '../../../../../assets/Test 2 - Trim.mp4?url'

export interface DemoMatch {
  id: string
  title: string
  description: string
  fileName: string
  url: string
}

/** Clips shipped in the repository `assets` folder. */
export const demoMatches: DemoMatch[] = [
  {
    id: 'test-1',
    title: 'Test 1',
    description: 'Intercambio de fondo con saque y botes en pista.',
    fileName: 'Test 1 - Trim.mp4',
    url: test1Url,
  },
  {
    id: 'test-2',
    title: 'Test 2',
    description: 'Secuencia de juego con golpes y cambios de dirección.',
    fileName: 'Test 2 - Trim.mp4',
    url: test2Url,
  },
]
