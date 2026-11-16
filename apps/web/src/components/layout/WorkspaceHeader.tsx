import { ChevronDown, Plus, Sparkles } from 'lucide-react'

import { AppNav } from './AppNav'
import type { Theme } from './ThemeToggle'

export type { Theme }

interface WorkspaceHeaderProps {
  title: string
  status: 'idle' | 'processing' | 'completed'
  frameCount: number | null
  theme: Theme
  sourceOpen: boolean
  coachOpen: boolean
  /** The coach needs an analysed match to talk about. */
  coachEnabled: boolean
  onThemeChange: (theme: Theme) => void
  onToggleSource: () => void
  onToggleCoach: () => void
  onHome: () => void
  onLibrary: () => void
}

const statusLabels = { idle: 'Sin partido', processing: 'Analizando', completed: 'Analizado' } as const

export function WorkspaceHeader({
  title, status, frameCount, theme, sourceOpen, coachOpen, coachEnabled,
  onThemeChange, onToggleSource, onToggleCoach, onHome, onLibrary,
}: WorkspaceHeaderProps) {
  return (
    <AppNav
      theme={theme}
      onThemeChange={onThemeChange}
      onHome={onHome}
      links={(
        <>
          <button type="button" aria-current="page">Análisis</button>
          <button type="button" onClick={onLibrary}>Biblioteca</button>
        </>
      )}
      actions={(
        <>
          <button
            type="button"
            className="btn btn--secondary coach-trigger"
            aria-pressed={coachOpen}
            aria-controls="side-panel"
            disabled={!coachEnabled}
            onClick={onToggleCoach}
            title={coachEnabled ? 'Conversar con el coach sobre este partido' : 'Analiza o abre un partido para hablar con el coach'}
          >
            <Sparkles size={15} aria-hidden="true" />
            <span>Coach</span>
          </button>
          <button
            type="button"
            className="btn btn--primary source-trigger"
            aria-expanded={sourceOpen}
            aria-controls="source-popover"
            onClick={onToggleSource}
          >
            <Plus size={15} aria-hidden="true" />
            <span>Nuevo análisis</span>
            <ChevronDown size={14} aria-hidden="true" className="source-trigger__chevron" />
          </button>
        </>
      )}
    >
      <h1 className="workspace-title" title={title}>{title}</h1>
      <span className={`status-pill status-pill--${status}`}>
        <i aria-hidden="true" />
        {statusLabels[status]}
        {frameCount !== null ? <span className="status-pill__count">{frameCount.toLocaleString('es-ES')} fotogramas</span> : null}
      </span>
    </AppNav>
  )
}
