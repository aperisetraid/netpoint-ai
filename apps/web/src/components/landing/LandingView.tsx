import type { AnalysisRequest } from '../../hooks/useMatchAnalysis'
import { type Theme, ThemeToggle } from '../layout/ThemeToggle'
import { FeatureGrid } from './FeatureGrid'
import { HeroSection } from './HeroSection'
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
      <header className="landing-nav">
        <span className="landing-nav__brand">
          NETPOINT <strong>AI</strong>
        </span>
        <nav className="landing-nav__links" aria-label="Secciones">
          <a href="#landing-features">Características</a>
          <a href="#landing-quick-start">Demo</a>
          <button type="button" onClick={onLibrary}>Biblioteca</button>
        </nav>
        <ThemeToggle theme={theme} onThemeChange={onThemeChange} />
      </header>

      <HeroSection onStart={onStart} />
      <div id="landing-features">
        <FeatureGrid />
      </div>
      <QuickStart onSelect={onSelectVideo} />

      <footer className="landing-footer">
        <span>NetPoint AI · Trabajo Fin de Máster</span>
        <span>React · Fastify · YOLOv8 · OpenCV</span>
      </footer>
    </div>
  )
}
