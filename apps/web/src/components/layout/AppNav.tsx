import type { ReactNode } from 'react'

import { type Theme, ThemeToggle } from './ThemeToggle'
import './AppNav.css'

interface AppNavProps {
  theme: Theme
  onThemeChange: (theme: Theme) => void
  /** Brand click; omitted on the landing page, where the brand is not a link. */
  onHome?: () => void
  /** Content between the brand and the links (the workspace puts the match title here). */
  children?: ReactNode
  /** Section links, rendered inside the <nav>. */
  links?: ReactNode
  /** Buttons on the right, before the theme toggle. */
  actions?: ReactNode
}

/** One top bar for every view: brand, optional context, section links, actions and theme. */
export function AppNav({ theme, onThemeChange, onHome, children, links, actions }: AppNavProps) {
  const brand = (
    <>
      <svg className="app-nav__mark" viewBox="0 0 32 32" aria-hidden="true">
        <rect width="32" height="32" rx="7" />
        <path d="M9 4.5h14v23H9zM9 16h14M12 10h8v12h-8M16 10v12" />
        <circle cx="22.5" cy="9" r="3.4" />
      </svg>
      <span>NetPoint</span>
    </>
  )

  return (
    <header className="app-nav">
      {onHome ? (
        <button type="button" className="app-nav__brand" onClick={onHome} aria-label="NetPoint AI, volver al inicio">
          {brand}
        </button>
      ) : (
        <span className="app-nav__brand" aria-label="NetPoint AI">{brand}</span>
      )}
      {children ? <div className="app-nav__context">{children}</div> : <div className="app-nav__spacer" />}
      {links ? <nav className="app-nav__links" aria-label="Secciones">{links}</nav> : null}
      {actions ? <div className="app-nav__actions">{actions}</div> : null}
      <ThemeToggle theme={theme} onThemeChange={onThemeChange} />
    </header>
  )
}
