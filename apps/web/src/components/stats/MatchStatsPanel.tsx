import { useMemo } from 'react'
import { ChartNoAxesCombined, Gauge, ListOrdered } from 'lucide-react'

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
}

/** Match summary, shots per player, the hit log and detection coverage. */
export function MatchStatsPanel({ telemetry, currentTime, playerNames }: MatchStatsPanelProps) {
  const statistics = useMemo(() => telemetry && {
    coverage: calculateMatchStatistics(telemetry.frames),
    shots: summarizeShots(telemetry.events.hits),
  }, [telemetry])
  const playerLabel = (side: PlayerSide) => playerNames[side] || (side === 'far' ? 'Fondo' : 'Cámara')

  return (
    <section className="workspace-panel stats-panel analysis-panel--stats" aria-label="Estadísticas del partido">
      <div className="panel-heading">
        <div>
          <span className="eyebrow">PARTIDO</span>
          <h2>Estadísticas</h2>
        </div>
      </div>
      {telemetry && statistics ? (
        <div className="match-stats">
          <div className="match-stats__summary">
            <div className="match-stats__metric">
              <span className="match-stats__metric-label">Duración</span>
              <strong className="match-stats__metric-value">{formatTime(statistics.coverage.durationSeconds)}</strong>
            </div>
            <div className="match-stats__metric">
              <span className="match-stats__metric-label">Botes</span>
              <strong className="match-stats__metric-value">{telemetry.events.bounces.length.toLocaleString('es-ES')}</strong>
            </div>
            <div className="match-stats__metric">
              <span
                className="match-stats__metric-label"
                title="Estimación por cambios de trayectoria cerca de un jugador; no confirma el contacto con la raqueta."
              >
                Golpes estimados
              </span>
              <strong className="match-stats__metric-value">{statistics.shots.match.totalShots.toLocaleString('es-ES')}</strong>
            </div>
            <div className="match-stats__metric">
              <span
                className="match-stats__metric-label"
                title="Estimada con el ajuste 3D de la trayectoria cuando es posible; si no, con la proyección de la pelota sobre la pista, que puede sobrestimar golpes altos."
              >
                Vel. máxima
              </span>
              <strong className="match-stats__metric-value">{formatSpeed(statistics.shots.match.maxSpeedKmh)}</strong>
            </div>
          </div>
          <div className="match-stats__coverage">
            <div className="match-stats__coverage-heading">
              <h3><Gauge size={16} /> Golpes por jugador</h3>
              <span>{statistics.shots.match.pointCount.toLocaleString('es-ES')} puntos</span>
            </div>
            <ShotTable summary={statistics.shots} playerLabel={playerLabel} />
          </div>
          <div className="match-stats__coverage">
            <div className="match-stats__coverage-heading">
              <h3><ListOrdered size={16} /> Registro de golpes</h3>
              <span>{statistics.shots.match.measuredShots}/{statistics.shots.match.totalShots} con velocidad</span>
            </div>
            <ShotLog hits={telemetry.events.hits} currentTime={currentTime} playerLabel={playerLabel} />
          </div>
          <div className="match-stats__coverage">
            <div className="match-stats__coverage-heading">
              <h3><ChartNoAxesCombined size={16} /> Cobertura</h3>
              <span>frames detectados</span>
            </div>
            <CoverageRow label={playerLabel('far')} detectedFrames={statistics.coverage.farPlayerFrames}
              totalFrames={statistics.coverage.frameCount} kind="player" />
            <CoverageRow label={playerLabel('near')} detectedFrames={statistics.coverage.nearPlayerFrames}
              totalFrames={statistics.coverage.frameCount} kind="player" />
            <CoverageRow label="Pelota" detectedFrames={statistics.coverage.ballFrames}
              totalFrames={statistics.coverage.frameCount} kind="ball" />
          </div>
        </div>
      ) : (
        <div className="match-stats__empty">
          <ChartNoAxesCombined size={24} strokeWidth={1.5} />
          <span>Analiza un partido para ver sus estadísticas</span>
        </div>
      )}
    </section>
  )
}
