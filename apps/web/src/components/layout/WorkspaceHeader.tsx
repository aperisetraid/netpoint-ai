import { Moon, Sun } from 'lucide-react'

export type Theme = 'light' | 'dark'

interface WorkspaceHeaderProps {
  title: string
  status: 'idle' | 'processing' | 'completed'
  frameCount: number | null
  theme: Theme
  onThemeChange: (theme: Theme) => void
}

const statusLabels = { idle: 'En espera', processing: 'En curso', completed: 'Procesado' } as const

export function WorkspaceHeader({ title, status, frameCount, theme, onThemeChange }: WorkspaceHeaderProps) {
  return (
    <header className="workspace-header">
      <div className="workspace-brand">
        <span>NETPOINT <strong>AI</strong></span>
      </div>
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
      <div className="theme-toggle" role="group" aria-label="Tema de la interfaz">
        <button
          type="button"
          aria-label="Modo claro"
          aria-pressed={theme === 'light'}
          title="Modo claro"
          onClick={() => onThemeChange('light')}
        >
          <Sun size={17} />
        </button>
        <button
          type="button"
          aria-label="Modo oscuro"
          aria-pressed={theme === 'dark'}
          title="Modo oscuro"
          onClick={() => onThemeChange('dark')}
        >
          <Moon size={17} />
        </button>
      </div>
    </header>
  )
}
