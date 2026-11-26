/** Sample bounces for the illustration (court centimetres, top-down, far half on top). */
const sampleBounces = [
  { x: 300, y: 520, side: 'far' },
  { x: 760, y: 1930, side: 'near' },
  { x: 420, y: 760, side: 'far' },
  { x: 870, y: 1700, side: 'near' },
  { x: 180, y: 300, side: 'far' },
] as const

const moreFeatures = [
  {
    title: 'Estadísticas por jugador',
    text: 'Golpes por tipo (saque, derecha, revés y volea), velocidad máxima y media, y cuánto del partido se detectó a cada jugador y a la bola.',
  },
  {
    title: 'Inspector de fotogramas',
    text: 'Pausa el vídeo y comprueba qué vio el modelo en ese instante: la pista calibrada, los jugadores y la bola, con su confianza.',
  },
  {
    title: 'Biblioteca de partidos',
    text: 'Cada análisis queda guardado. Vuelve a abrirlo cuando quieras, sin procesar el vídeo otra vez.',
  },
]

function BounceMap() {
  return (
    <svg className="spread-court" viewBox="-80 -80 1257 2537" role="img"
      aria-label="Ejemplo de mapa de pista con cinco botes numerados">
      <rect x="-80" y="-80" width="1257" height="2537" rx="24" className="spread-court__apron" />
      <rect x="0" y="0" width="1097" height="2377" className="spread-court__surface" />
      <path className="spread-court__lines"
        d="M0 0H1097V2377H0ZM137 0V2377M960 0V2377M137 548.5H960M137 1828.5H960M548.5 548.5V1828.5" />
      <path className="spread-court__net" d="M-40 1188.5H1137" />
      {sampleBounces.map((bounce, index) => (
        <g key={index} className={`spread-court__bounce spread-court__bounce--${bounce.side}`}>
          <circle cx={bounce.x} cy={bounce.y} r="70" />
          <text x={bounce.x} y={bounce.y + 22} textAnchor="middle">{index + 1}</text>
        </g>
      ))}
    </svg>
  )
}

/** What the analysis gives you: an asymmetric spread rather than a row of identical cards. */
export function FeatureGrid({ demo = false }: { demo?: boolean }) {
  return (
    <section className="landing-section" aria-labelledby="features-title">
      <h2 id="features-title" className="display landing-section__title">Qué obtienes</h2>

      <div className="spread">
        <article className="spread__map">
          <BounceMap />
          <div className="spread__copy">
            <h3 className="heading">Cada bote, en su sitio</h3>
            <p>
              Los botes se proyectan sobre un plano real de la pista, numerados en el orden en que ocurren y con el
              color del campo donde caen. Mientras ves el vídeo, el mapa avanza con él.
            </p>
          </div>
        </article>

        <article className="spread__coach">
          <div className="spread__copy">
            <h3 className="heading">Un coach que ha visto el partido</h3>
            <p>Pregunta en lenguaje natural. Responde con los datos del análisis y te lleva al momento exacto del vídeo.</p>
            {demo ? <p>No está activo en esta demo pública: requiere la instalación local.</p> : null}
          </div>
          <figure className="spread-chat" aria-label="Ejemplo de conversación con el coach">
            <p className="spread-chat__question">¿Dónde pierdo más puntos con el revés?</p>
            <div className="spread-chat__answer">
              <p>
                Tus reveses caen cortos: <strong>4 de 6</strong> botan antes de la línea de saque rival, lo que deja
                atacar a tu oponente. El más claro, en <span className="timecode">0:42</span>.
              </p>
              <p>Prioridad: profundidad cruzada con margen sobre la red.</p>
            </div>
            <figcaption>Ejemplo ilustrativo</figcaption>
          </figure>
        </article>
      </div>

      <dl className="spread-list">
        {moreFeatures.map((feature) => (
          <div key={feature.title}>
            <dt className="heading">{feature.title}</dt>
            <dd>{feature.text}</dd>
          </div>
        ))}
      </dl>
    </section>
  )
}
