import { Activity, Box, CircleDot, Trophy } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

interface Feature {
  icon: LucideIcon
  title: string
  description: string
  tag: string
}

const features: Feature[] = [
  {
    icon: Box,
    title: 'Reconstrucción 3D',
    description:
      'Calibra la cámara con solvePnP a partir de las líneas de la pista y proyecta jugadores y bola al plano métrico.',
    tag: 'solvePnP',
  },
  {
    icon: CircleDot,
    title: 'Detección de botes',
    description:
      'Analiza la cinemática de la trayectoria para localizar cada bote y situarlo sobre el mapa 2D de la pista.',
    tag: 'Cinemática',
  },
  {
    icon: Trophy,
    title: 'Saques y golpes',
    description:
      'Clasifica saques, derechas, reveses y voleas por jugador, con cobertura de pista y registro cronológico.',
    tag: 'Estadísticas',
  },
  {
    icon: Activity,
    title: 'Telemetría en tiempo real',
    description:
      'Sincroniza posiciones, confianzas y eventos con la reproducción del vídeo y el inspector de fotogramas.',
    tag: 'Telemetría',
  },
]

export function FeatureGrid() {
  return (
    <section className="landing-section" aria-labelledby="landing-features-title">
      <div className="landing-section__heading">
        <span className="eyebrow">VALOR TÉCNICO</span>
        <h2 id="landing-features-title">Del vídeo al dato, en un único pipeline</h2>
      </div>
      <ul className="landing-features">
        {features.map(({ icon: Icon, title, description, tag }) => (
          <li key={title} className="landing-feature">
            <span className="landing-feature__icon">
              <Icon size={22} aria-hidden="true" />
            </span>
            <span className="landing-feature__tag">{tag}</span>
            <h3>{title}</h3>
            <p>{description}</p>
          </li>
        ))}
      </ul>
    </section>
  )
}
