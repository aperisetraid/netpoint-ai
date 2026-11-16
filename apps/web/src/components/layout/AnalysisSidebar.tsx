import { useState } from 'react'

import type { AnalysisResult } from '../../hooks/useMatchAnalysis'
import type { BounceEvent, FrameTelemetry, MatchTelemetry } from '../../services/api'
import { CourtMap } from '../court/CourtMap'
import type { PlayerNames } from '../ingest/PlayerNamesDialog'
import { FrameInspector } from '../inspector/FrameInspector'
import { MatchStatsPanel } from '../stats/MatchStatsPanel'

type SidebarTab = 'summary' | 'shots' | 'frame'

interface AnalysisSidebarProps {
  analysis: AnalysisResult | null
  telemetry: MatchTelemetry | null
  frame?: FrameTelemetry
  bounces: BounceEvent[]
  currentTime: number
  isPlaying: boolean
  playerNames: PlayerNames
}

const tabs: { id: SidebarTab; label: string }[] = [
  { id: 'summary', label: 'Resumen' },
  { id: 'shots', label: 'Golpes' },
  { id: 'frame', label: 'Fotograma' },
]

/** Tactical side panel: 2D court map on top, tabbed statistics below. */
export function AnalysisSidebar({
  analysis, telemetry, frame, bounces, currentTime, isPlaying, playerNames,
}: AnalysisSidebarProps) {
  const [tab, setTab] = useState<SidebarTab>('summary')

  return (
    <aside className="sidebar" aria-label="Panel táctico">
      <CourtMap hasAnalysis={analysis !== null} frame={frame} bounces={bounces} playerNames={playerNames} />

      <section className="sidebar__stats panel" aria-label="Estadísticas del partido">
        <div className="tabs" role="tablist" aria-label="Vista de datos">
          {tabs.map(({ id, label }) => (
            <button
              key={id}
              type="button"
              role="tab"
              id={`tab-${id}`}
              aria-selected={tab === id}
              aria-controls={`tabpanel-${id}`}
              onClick={() => setTab(id)}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="sidebar__scroll" role="tabpanel" id={`tabpanel-${tab}`} aria-labelledby={`tab-${tab}`}>
          {tab === 'frame' ? (
            <FrameInspector analysis={analysis} frame={frame} isPlaying={isPlaying} />
          ) : (
            <MatchStatsPanel telemetry={telemetry} currentTime={currentTime} playerNames={playerNames} view={tab} />
          )}
        </div>
      </section>
    </aside>
  )
}
