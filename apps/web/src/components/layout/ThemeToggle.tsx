import { Moon, Sun } from 'lucide-react'

export type Theme = 'light' | 'dark'

interface ThemeToggleProps {
  theme: Theme
  onThemeChange: (theme: Theme) => void
}

export function ThemeToggle({ theme, onThemeChange }: ThemeToggleProps) {
  return (
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
  )
}
