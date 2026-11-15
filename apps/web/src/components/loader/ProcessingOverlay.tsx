import { useEffect, useState } from 'react'

import type { MatchProgressResponse } from '../../services/api'
import { RetroTennisLoader } from './RetroTennisLoader'
import './loader.css'

const fadeOutMilliseconds = 320

interface ProcessingOverlayProps {
  active: boolean
  progress: MatchProgressResponse
}

/** Blurs the workspace while `active`, then fades out and unmounts once processing ends. */
export function ProcessingOverlay({ active, progress }: ProcessingOverlayProps) {
  const [mounted, setMounted] = useState(active)
  if (active && !mounted) setMounted(true)

  useEffect(() => {
    if (active || !mounted) return
    const timer = window.setTimeout(() => setMounted(false), fadeOutMilliseconds)
    return () => window.clearTimeout(timer)
  }, [active, mounted])

  if (!mounted) return null

  return (
    <div
      className={`processing-overlay${active ? '' : ' is-leaving'}`}
      role="status"
      aria-label="Analizando el vídeo"
    >
      <div className="processing-overlay__card">
        <RetroTennisLoader progress={progress} />
      </div>
    </div>
  )
}
