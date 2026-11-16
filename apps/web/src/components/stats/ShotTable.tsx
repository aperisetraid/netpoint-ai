import { formatSpeed } from '../../lib/format.ts'
import { type MatchShotSummary, playerSides, shotTypes } from '../../lib/shotSummary.ts'
import type { PlayerSide } from '../../services/api'

interface ShotTableProps {
  summary: MatchShotSummary
  playerLabel: (side: PlayerSide) => string
}

export function ShotTable({ summary, playerLabel }: ShotTableProps) {
  return (
    <div className="shot-table__wrapper">
      <table className="shot-table">
        <thead>
          <tr>
            <th scope="col">Jugador</th>
            {shotTypes.map(([type, label]) => <th key={type} scope="col">{label}</th>)}
            <th scope="col">Máx.</th>
            <th scope="col">Media</th>
          </tr>
        </thead>
        <tbody>
          {playerSides.map((side) => {
            const player = summary.byPlayer[side]
            return (
              <tr key={side}>
                <th scope="row" title={playerLabel(side)}>
                  <span className="shot-table__player">
                    <i className={`swatch swatch--${side}`} aria-hidden="true" />
                    {playerLabel(side)}
                  </span>
                </th>
                {shotTypes.map(([type]) => <td key={type}>{player.byType[type]}</td>)}
                <td>{formatSpeed(player.maxSpeedKmh)}</td>
                <td>{formatSpeed(player.averageSpeedKmh)}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
