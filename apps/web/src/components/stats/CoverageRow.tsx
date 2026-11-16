interface CoverageRowProps {
  label: string
  detectedFrames: number
  totalFrames: number
  /** Which entity the row measures; it picks the swatch and bar colour. */
  kind: 'far' | 'near' | 'ball'
}

export function CoverageRow({ label, detectedFrames, totalFrames, kind }: CoverageRowProps) {
  const percentage = totalFrames ? Math.round((detectedFrames / totalFrames) * 100) : 0

  return (
    <div className="match-stats__coverage-row">
      <span className="match-stats__coverage-label" title={label}>
        <i className={`swatch swatch--${kind}`} aria-hidden="true" />
        <span>{label}</span>
      </span>
      <div
        className={`match-stats__bar match-stats__bar--${kind}`}
        role="progressbar"
        aria-label={`Cobertura de ${label}`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percentage}
      >
        <span style={{ width: `${percentage}%` }} />
      </div>
      <strong>{percentage}%</strong>
      <span className="match-stats__coverage-count">
        {detectedFrames.toLocaleString('es-ES')}/{totalFrames.toLocaleString('es-ES')}
      </span>
    </div>
  )
}
