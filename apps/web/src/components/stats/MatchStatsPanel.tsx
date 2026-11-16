import { useMemo } from 'react'
import { ChartNoAxesCombined } from 'lucide-react'

import { formatSpeed, formatTime } from '../../lib/format.ts'
import { calculateMatchStatistics } from '../../lib/matchStatistics.ts'
import { summarizeShots } from '../../lib/shotSummary.ts'
import type { MatchTelemetry, PlayerSide } from '../../services/api'
import type { PlayerNames } from '../ingest/PlayerNamesDialog'
import { CoverageRow } from './CoverageRow'
import { ShotLog } from './ShotLog'
import { ShotTable } from './ShotTable'

interface MatchStatsPanelProps {
  telemetry: MatchTelemetry | null
  currentTime: number
  playerNames: PlayerNames
  /** `summary`: key figures and detection coverage. `shots`: per-player table and hit log. */
  view: 'summary' | 'shots'
}

/** Match statistics, rendered as the content of a tab of the side panel. */
export function MatchStatsPanel({ telemetry, currentTime, playerNames, view }: MatchStatsPanelProps) {
  const statistics = useMemo(() => telemetry && {
    coverage: calculateMatchStatistics(telemetry.frames),
    shots: summarizeShots(telemetry.events.hits),
  }, [telemetry])
  const playerLabel = (side: PlayerSide) => playerNames[side] || (side === 'far' ? 'Fondo' : 'Cámara')

  if (!telemetry || !statistics) {
    return (
      <div className="match-stats__empty">
        <ChartNoAxesCombined size={22} strokeWidth={1.5} aria-hidden="true" />
        <span>Analiza un partido para ver sus estadísticas.</span>
      </div>
    )
  }

  if (view === 'shots') {
    return (
      <div className="match-stats">
        <section className="match-stats__section">
          <div className="match-stats__section-heading">
            <h3>Golpes por jugador</h3>
            <span>{statistics.shots.match.pointCount.toLocaleString('es-ES')} puntos</span>
          </div>
          <ShotTable summary={statistics.shots} playerLabel={playerLabel} />
        </section>
        <section className="match-stats__section">
          <div className="match-stats__section-heading">
            <h3>Registro de golpes</h3>
            <span>{statistics.shots.match.measuredShots} de {statistics.shots.match.totalShots} con velocidad</span>
          </div>
          <ShotLog hits={telemetry.events.hits} currentTime={currentTime} playerLabel={playerLabel} />
        </section>
      </div>
    )
  }

  return (
    <div className="match-stats">
      <div className="match-stats__summary">
        <div className="figure">
          <strong className="figure__value">{formatTime(statistics.coverage.durationSeconds)}</strong>
          <span className="figure__label">Duración</span>
        </div>
        <div className="figure">
          <strong className="figure__value">{telemetry.events.bounces.length.toLocaleString('es-ES')}</strong>
          <span className="figure__label">Botes</span>
        </div>
        <div className="figure">
          <strong className="figure__value">{statistics.shots.match.totalShots.toLocaleString('es-ES')}</strong>
          <span
            className="figure__label"
            title="Estimación por cambios de trayectoria cerca de un jugador; no confirma el contacto con la raqueta."
          >
            Golpes estimados
          </span>
        </div>
        <div className="figure">
          <strong className="figure__value">{formatSpeed(statistics.shots.match.maxSpeedKmh)}</strong>
          <span
            className="figure__label"
            title="Estimada con el ajuste 3D de la trayectoria cuando es posible; si no, con la proyección de la pelota sobre la pista, que puede sobrestimar golpes altos."
          >
            Velocidad máxima
          </span>
        </div>
      </div>
      <section className="match-stats__section">
        <div className="match-stats__section-heading">
          <h3>Cobertura de detección</h3>
          <span>fotogramas detectados</span>
        </div>
        <CoverageRow label={playerLabel('far')} detectedFrames={statistics.coverage.farPlayerFrames}
          totalFrames={statistics.coverage.frameCount} kind="far" />
        <CoverageRow label={playerLabel('near')} detectedFrames={statistics.coverage.nearPlayerFrames}
          totalFrames={statistics.coverage.frameCount} kind="near" />
        <CoverageRow label="Pelota" detectedFrames={statistics.coverage.ballFrames}
          totalFrames={statistics.coverage.frameCount} kind="ball" />
      </section>
    </div>
  )
}
