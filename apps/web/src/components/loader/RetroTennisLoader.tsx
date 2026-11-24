import { useEffect, useRef, useState } from 'react'

import type { MatchProgressResponse } from '../../services/api'
import { drawRally } from './drawRally'
import './loader.css'

const pixelScale = 2
const courtRows = 70
const minimumColumns = 120
const messageIntervalMilliseconds = 2600

const statusMessages = [
  'Detectando líneas de pista…',
  'Calibrando cámara con solvePnP…',
  'Detectando jugadores con YOLOv8…',
  'Rastreando trayectoria de pelota…',
  'Detectando botes y golpes…',
  'Reconstruyendo física 3D…',
]

/** Canvas drawn on a low-resolution pixel grid and upscaled by an integer factor, so it stays crisp at any width. */
function PixelCourt() {
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const container = containerRef.current
    const canvas = canvasRef.current
    const context = canvas?.getContext('2d')
    if (!container || !canvas || !context) return

    let frameId = 0
    const startedAt = performance.now()

    const resize = () => {
      const columns = Math.max(minimumColumns, Math.floor(container.clientWidth / pixelScale))
      if (canvas.width !== columns) canvas.width = columns
      canvas.style.width = `${columns * pixelScale}px`
    }
    // The animation is the only sign that work is going on, so it runs even when the system asks
    // for reduced motion; a frozen loader reads as a hung page.
    const tick = (now: number) => {
      drawRally(context, (now - startedAt) / 1000)
      frameId = window.requestAnimationFrame(tick)
    }

    canvas.height = courtRows
    resize()
    const observer = new ResizeObserver(resize)
    observer.observe(container)
    frameId = window.requestAnimationFrame(tick)

    return () => {
      observer.disconnect()
      window.cancelAnimationFrame(frameId)
    }
  }, [])

  return (
    <div ref={containerRef} className="retro-loader__court">
      <canvas ref={canvasRef} role="img" aria-label="Animación de dos jugadores de tenis en pixel art" />
    </div>
  )
}

interface RetroTennisLoaderProps {
  progress: MatchProgressResponse
}

/** Pixel-art tennis rally with the real frame counter and rotating technical status lines. */
export function RetroTennisLoader({ progress }: RetroTennisLoaderProps) {
  const [messageIndex, setMessageIndex] = useState(0)
  const { processedFrames, totalFrames } = progress
  const hasTotal = totalFrames !== null && totalFrames > 0
  const percentage = hasTotal ? Math.min(100, Math.round((processedFrames / totalFrames) * 100)) : null

  useEffect(() => {
    const timer = window.setInterval(
      () => setMessageIndex((index) => (index + 1) % statusMessages.length),
      messageIntervalMilliseconds,
    )
    return () => window.clearInterval(timer)
  }, [])

  return (
    <div className="retro-loader">
      <h2 className="retro-loader__title">Analizando el partido</h2>
      <div className="retro-loader__screen">
        <PixelCourt />
      </div>

      <div
        className={`retro-loader__bar${percentage === null ? ' is-indeterminate' : ''}`}
        role="progressbar"
        aria-label="Fotogramas procesados"
        aria-valuemin={0}
        aria-valuemax={hasTotal ? totalFrames : undefined}
        aria-valuenow={hasTotal ? processedFrames : undefined}
      >
        <div className="retro-loader__fill" style={percentage === null ? undefined : { width: `${percentage}%` }} />
      </div>

      <div className="retro-loader__counter">
        <span>Fotogramas procesados</span>
        <strong>
          {processedFrames.toLocaleString('es-ES')}
          {hasTotal ? ` / ${totalFrames.toLocaleString('es-ES')}` : ''}
        </strong>
      </div>

      <p className="retro-loader__message" aria-hidden="true">
        <span key={messageIndex}>&gt; {statusMessages[messageIndex]}</span>
        <i className="retro-loader__cursor" />
      </p>
    </div>
  )
}
