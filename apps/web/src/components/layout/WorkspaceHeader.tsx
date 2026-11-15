import { ChevronDown, Home, Library, Plus } from 'lucide-react'

import { type Theme, ThemeToggle } from './ThemeToggle'

export type { Theme }

interface WorkspaceHeaderProps {
  title: string
  status: 'idle' | 'processing' | 'completed'
  frameCount: number | null
  theme: Theme
  sourceOpen: boolean
  onThemeChange: (theme: Theme) => void
  onToggleSource: () => void
  onHome: () => void
  onLibrary: () => void
}

const statusLabels = { idle: 'En espera', processing: 'Procesando', completed: 'Procesado' } as const

export function WorkspaceHeader({
  title, status, frameCount, theme, sourceOpen, onThemeChange, onToggleSource, onHome, onLibrary,
}: WorkspaceHeaderProps) {
  return (
    <header className="workspace-header">
      <button type="button" className="workspace-brand workspace-brand--home" onClick={onHome} title="Volver al inicio">
        <Home size={15} aria-hidden="true" />
        <span>NETPOINT <strong>AI</strong></span>
      </button>

      <div className="workspace-title">
        <h1>{title}</h1>
        <span className={`status-pill status-pill--${status}`}>
          <i aria-hidden="true" />
          {statusLabels[status]}
          {frameCount !== null ? <em>· {frameCount.toLocaleString('es-ES')} frames</em> : null}
        </span>
      </div>

      <button type="button" className="library-link" onClick={onLibrary} title="Partidos analizados">
        <Library size={15} aria-hidden="true" />
        <span>Biblioteca</span>
      </button>
      <button
        type="button"
        className="source-trigger"
        aria-expanded={sourceOpen}
        aria-controls="source-popover"
        onClick={onToggleSource}
      >
        <Plus size={15} aria-hidden="true" />
        <span>Nuevo análisis</span>
        <ChevronDown size={14} aria-hidden="true" className="source-trigger__chevron" />
      </button>
      <ThemeToggle theme={theme} onThemeChange={onThemeChange} />
    </header>
  )
}
