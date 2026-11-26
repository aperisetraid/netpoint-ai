import type { AnalysisRequest } from '../../hooks/useMatchAnalysis'
import { AppNav } from '../layout/AppNav'
import type { Theme } from '../layout/ThemeToggle'
import { FeatureGrid } from './FeatureGrid'
import { HeroSection } from './HeroSection'
import { HowItWorks } from './HowItWorks'
import { QuickStart } from './QuickStart'
import './Landing.css'

interface LandingViewProps {
  theme: Theme
  onThemeChange: (theme: Theme) => void
  /** Opens the analysis workspace without a video. */
  onStart: () => void
  /** Starts an analysis from a dropped file or a demo clip. */
  onSelectVideo: (request: AnalysisRequest) => void
  /** Opens the library of already analysed matches. */
  onLibrary: () => void
  /** Public read-only demo: no uploads, the library is the way in. */
  demo?: boolean
}

export function LandingView({ theme, onThemeChange, onStart, onSelectVideo, onLibrary, demo = false }: LandingViewProps) {
  return (
    <div className="landing">
      <AppNav
        theme={theme}
        onThemeChange={onThemeChange}
        links={(
          <>
            <a href="#como-funciona">Cómo funciona</a>
            {demo ? null : <a href="#landing-quick-start">Demo</a>}
            <button type="button" onClick={onLibrary}>Biblioteca</button>
          </>
        )}
        actions={(
          <button type="button" className="btn btn--primary" onClick={demo ? onLibrary : onStart}>
            {demo ? 'Ver partidos analizados' : 'Analizar un vídeo'}
          </button>
        )}
      />

      <HeroSection onStart={onStart} demo={demo} />
      <HowItWorks />
      <FeatureGrid />
      {demo ? null : <QuickStart onSelect={onSelectVideo} />}

      <footer className="landing-footer">
        <span>NetPoint AI</span>
        <a href="#landing-title">Volver arriba</a>
      </footer>
    </div>
  )
}
