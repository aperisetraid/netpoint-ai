import { Home } from 'lucide-react'

import { type Theme, ThemeToggle } from './ThemeToggle'

export type { Theme }

interface WorkspaceHeaderProps {
  title: string
  status: 'idle' | 'processing' | 'completed'
  frameCount: number | null
  theme: Theme
  onThemeChange: (theme: Theme) => void
  onHome: () => void
}

const statusLabels = { idle: 'En espera', processing: 'En curso', completed: 'Procesado' } as const

export function WorkspaceHeader({ title, status, frameCount, theme, onThemeChange, onHome }: WorkspaceHeaderProps) {
  return (
    <header className="workspace-header">
      <button type="button" className="workspace-brand workspace-brand--home" onClick={onHome} title="Volver al inicio">
        <Home size={15} aria-hidden="true" />
        <span>NETPOINT <strong>AI</strong></span>
      </button>
      <div className="workspace-title">
        <span className="eyebrow">ANÁLISIS DE PARTIDO</span>
        <h1>{title}</h1>
      </div>

      <div className="workspace-stats">
        <div className="workspace-stat">
          <span className="workspace-stat__label">Estado</span>
          <strong className={status === 'processing' ? 'is-live' : ''}>{statusLabels[status]}</strong>
        </div>
        <div className="workspace-stat">
          <span className="workspace-stat__label">Frames</span>
          <strong>{frameCount === null ? '--' : frameCount.toLocaleString('es-ES')}</strong>
        </div>
      </div>
      <ThemeToggle theme={theme} onThemeChange={onThemeChange} />
    </header>
  )
}
