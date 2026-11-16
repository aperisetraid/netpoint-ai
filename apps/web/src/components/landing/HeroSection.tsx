interface HeroSectionProps {
  onStart: () => void
}

/**
 * Full-width hard court seen from the broadcast camera. One rally plays once on load:
 * the ball leaves the camera-side player, bounces in the far half (numbered, in that half's
 * colour, as on the workspace court map) and reaches the far player.
 * Court units are centimetres: 2377 × 1097, doubles lines.
 */
function CourtScene() {
  return (
    <svg className="hero-court" viewBox="-160 -110 2697 1317" role="img"
      aria-label="Pista de tenis con la trayectoria de una bola y su bote marcado">
      <rect x="-160" y="-110" width="2697" height="1317" className="hero-court__apron" />
      <rect x="0" y="0" width="2377" height="1097" className="hero-court__surface" />
      <g className="hero-court__lines">
        <rect x="0" y="0" width="2377" height="1097" />
        <path d="M0 137H2377M0 960H2377M548.5 137V960M1828.5 137V960M548.5 548.5H1828.5M0 548.5H22M2355 548.5H2377" />
      </g>
      <path d="M1188.5 -60V1157" className="hero-court__net" />

      <path className="hero-court__path" pathLength={1} d="M70 800 Q 820 330 1690 420 Q 2000 445 2270 330" />
      <circle className="hero-court__ripple" cx="1690" cy="420" r="40" />
      <g className="hero-court__bounce">
        <circle cx="1690" cy="420" r="46" />
        <text x="1690" y="440" textAnchor="middle">1</text>
      </g>
      <circle className="hero-court__player hero-court__player--near" cx="40" cy="820" r="40" />
      <circle className="hero-court__player hero-court__player--far" cx="2400" cy="250" r="40" />
      <circle className="hero-court__ball" cx="2270" cy="330" r="20" />
    </svg>
  )
}

export function HeroSection({ onStart }: HeroSectionProps) {
  return (
    <section className="landing-hero" aria-labelledby="landing-title">
      <h1 id="landing-title" className="display landing-hero__title">El partido, leído golpe a golpe.</h1>
      <div className="landing-hero__row">
        <p className="landing-hero__lede">
          Sube un vídeo de tenis. NetPoint localiza a los jugadores, la bola y la pista, marca cada bote y cada
          golpe, y un coach te explica qué pasó y qué entrenar.
        </p>
        <div className="landing-hero__actions">
          <button type="button" className="btn btn--primary btn--lg" onClick={onStart}>
            Analizar un vídeo
          </button>
          <a className="btn btn--secondary btn--lg" href="#landing-quick-start">
            Probar una demo
          </a>
        </div>
      </div>
      <div className="landing-hero__court">
        <CourtScene />
      </div>
    </section>
  )
}
