const steps = [
  {
    title: 'Sube el vídeo',
    text: 'Un clip de un partido grabado desde el fondo de la pista, como lo vería la cámara de televisión. Archivo o enlace.',
  },
  {
    title: 'Lo procesamos',
    text: 'Se calibra la pista y se siguen jugadores y bola fotograma a fotograma para localizar cada bote y cada golpe.',
  },
  {
    title: 'Explora y pregunta',
    text: 'Reproduce el partido con los datos encima, revisa las estadísticas y pregunta al coach qué funcionó y qué no.',
  },
]

/** The three steps from video to analysis; a real sequence, hence the numbers. */
export function HowItWorks() {
  return (
    <section className="landing-section" id="como-funciona" aria-labelledby="how-title">
      <h2 id="how-title" className="display landing-section__title">Cómo funciona</h2>
      <ol className="landing-steps">
        {steps.map((step, index) => (
          <li key={step.title}>
            <span className="landing-steps__number" aria-hidden="true">{index + 1}</span>
            <h3 className="heading">{step.title}</h3>
            <p>{step.text}</p>
          </li>
        ))}
      </ol>
    </section>
  )
}
