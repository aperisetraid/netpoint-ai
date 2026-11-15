import { ArrowRight, PlayCircle } from 'lucide-react'

interface HeroSectionProps {
  onStart: () => void
}

const heroMetrics = [
  { value: 'YOLOv8', label: 'Detección' },
  { value: 'solvePnP', label: 'Calibración' },
  { value: 'Tiempo real', label: 'Telemetría' },
]

/** Stylised court seen from above with an animated ball trajectory and bounce. */
function CourtIllustration() {
  return (
    <svg className="landing-court" viewBox="0 0 360 520" role="img" aria-label="Pista de tenis con la trayectoria de la bola">
      <defs>
        <linearGradient id="landing-trail" x1="0" y1="1" x2="1" y2="0">
          <stop offset="0" stopColor="#38bdf8" stopOpacity="0" />
          <stop offset="1" stopColor="#38bdf8" />
        </linearGradient>
      </defs>
      <rect x="20" y="20" width="320" height="480" rx="10" className="landing-court__surface" />
      <g className="landing-court__lines" fill="none">
        <rect x="52" y="52" width="256" height="416" />
        <line x1="88" y1="52" x2="88" y2="468" />
        <line x1="272" y1="52" x2="272" y2="468" />
        <line x1="88" y1="154" x2="272" y2="154" />
        <line x1="88" y1="366" x2="272" y2="366" />
        <line x1="180" y1="154" x2="180" y2="366" />
        <line x1="20" y1="260" x2="340" y2="260" className="landing-court__net" />
      </g>
      <path
        className="landing-court__path"
        d="M96 430 C 130 330, 170 290, 196 176 S 250 110, 262 84"
        fill="none"
        stroke="url(#landing-trail)"
        strokeWidth="3"
        strokeLinecap="round"
      />
      <circle className="landing-court__bounce" cx="196" cy="176" r="6" />
      <circle className="landing-court__bounce landing-court__bounce--delayed" cx="196" cy="176" r="6" />
      <circle className="landing-court__ball" cx="262" cy="84" r="6" />
      <circle className="landing-court__player" cx="96" cy="430" r="9" />
      <text className="landing-court__label" x="112" y="434">J1</text>
    </svg>
  )
}

export function HeroSection({ onStart }: HeroSectionProps) {
  return (
    <section className="landing-hero" aria-labelledby="landing-title">
      <div className="landing-hero__copy">
        <span className="landing-badge">
          <span className="landing-badge__dot" aria-hidden="true" />
          TFM · Visión por computador aplicada al tenis
        </span>
        <h1 id="landing-title">
          Analiza el tenis en <span className="landing-gradient-text">3D</span>, golpe a golpe
        </h1>
        <p className="landing-hero__subtitle">
          NetPoint AI reconstruye la pista y los jugadores a partir de un vídeo con YOLOv8, calcula la cinemática de
          los botes y convierte cada punto en estadísticas de juego y telemetría avanzada.
        </p>
        <div className="landing-hero__actions">
          <button type="button" className="landing-cta" onClick={onStart}>
            Iniciar análisis
            <ArrowRight size={18} aria-hidden="true" />
          </button>
          <a className="landing-cta landing-cta--ghost" href="#landing-quick-start">
            <PlayCircle size={18} aria-hidden="true" />
            Explorar demo
          </a>
        </div>
        <dl className="landing-metrics">
          {heroMetrics.map((metric) => (
            <div key={metric.label}>
              <dt>{metric.label}</dt>
              <dd>{metric.value}</dd>
            </div>
          ))}
        </dl>
      </div>
      <div className="landing-hero__visual">
        <div className="landing-hero__glow" aria-hidden="true" />
        <CourtIllustration />
      </div>
    </section>
  )
}
