import { type RefObject, useCallback, useEffect, useState } from 'react'

/**
 * Full screen for one element: the browser's Fullscreen API when it is available, otherwise (iPhone
 * Safari, an iframe that refuses it) `expanded` is set so the element can cover the window with CSS.
 * Escape leaves either mode.
 */
export function useFullscreen(ref: RefObject<HTMLElement | null>) {
  const [fullscreen, setFullscreen] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const enlarged = fullscreen || expanded

  useEffect(() => {
    const sync = () => setFullscreen(document.fullscreenElement !== null && document.fullscreenElement === ref.current)
    document.addEventListener('fullscreenchange', sync)
    return () => document.removeEventListener('fullscreenchange', sync)
  }, [ref])

  useEffect(() => {
    if (!expanded) return
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setExpanded(false)
    }
    window.addEventListener('keydown', close)
    return () => window.removeEventListener('keydown', close)
  }, [expanded])

  const toggle = useCallback(async () => {
    const element = ref.current
    if (!element) return
    if (enlarged) {
      if (document.fullscreenElement) await document.exitFullscreen().catch(() => undefined)
      setExpanded(false)
      return
    }
    if (document.fullscreenEnabled && element.requestFullscreen) {
      try {
        await element.requestFullscreen()
        return
      } catch {
        // Refused (iframe, policy): fall back to covering the window.
      }
    }
    setExpanded(true)
  }, [ref, enlarged])

  return { enlarged, expanded, toggle }
}
