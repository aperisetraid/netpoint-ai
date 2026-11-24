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
}

export function LandingView({ theme, onThemeChange, onStart, onSelectVideo, onLibrary }: LandingViewProps) {
  return (
    <div className="landing">
      <AppNav
        theme={theme}
        onThemeChange={onThemeChange}
        links={(
          <>
            <a href="#como-funciona">Cómo funciona</a>
            <a href="#landing-quick-start">Demo</a>
            <button type="button" onClick={onLibrary}>Biblioteca</button>
          </>
        )}
        actions={<button type="button" className="btn btn--primary" onClick={onStart}>Analizar un vídeo</button>}
      />

      <HeroSection onStart={onStart} />
      <HowItWorks />
      <FeatureGrid />
      <QuickStart onSelect={onSelectVideo} />

      <footer className="landing-footer">
        <span>NetPoint AI</span>
        <a href="#landing-title">Volver arriba</a>
      </footer>
    </div>
  )
}
