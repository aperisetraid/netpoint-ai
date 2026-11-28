import { lazy, Suspense, useState } from 'react'

import type { AnalysisResult } from '../../hooks/useMatchAnalysis'
import type { BounceEvent, FrameTelemetry, MatchTelemetry } from '../../services/api'
import { CourtMap } from '../court/CourtMap'
import type { PlayerNames } from '../ingest/PlayerNamesDialog'
import { FrameInspector } from '../inspector/FrameInspector'
import { MatchStatsPanel } from '../stats/MatchStatsPanel'

// three.js only downloads when the 3D tab is first opened.
const Replay3DPanel = lazy(() => import('../replay3d/Replay3DPanel'))

type SidebarTab = 'summary' | 'shots' | '3d' | 'frame'

interface AnalysisSidebarProps {
  analysis: AnalysisResult | null
  telemetry: MatchTelemetry | null
  frame?: FrameTelemetry
  bounces: BounceEvent[]
  currentTime: number
  isPlaying: boolean
  playerNames: PlayerNames
  getVideoTime: () => number | null
  onSeek: (seconds: number) => void
}

const tabs: { id: SidebarTab; label: string }[] = [
  { id: '3d', label: '3D' },
  { id: 'summary', label: 'Resumen' },
  { id: 'shots', label: 'Golpes' },
  { id: 'frame', label: 'Fotograma' },
]

/** Tactical side panel: 2D court map on top, tabbed statistics below. */
export function AnalysisSidebar({
  analysis, telemetry, frame, bounces, currentTime, isPlaying, playerNames, getVideoTime, onSeek,
}: AnalysisSidebarProps) {
  const [tab, setTab] = useState<SidebarTab>('3d')

  return (
    <aside className={`sidebar${tab === '3d' ? ' sidebar--replay' : ''}`} aria-label="Panel táctico">
      {/* The 3D replay has its own top-down view, so it takes the whole column. */}
      {tab === '3d' ? null : (
        <CourtMap
          hasAnalysis={analysis !== null}
          frame={frame}
          bounces={bounces}
          playerNames={playerNames}
          colors={telemetry?.court.colors}
        />
      )}

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
            <FrameInspector analysis={analysis} frame={frame} isPlaying={isPlaying} onSeek={onSeek} playerNames={playerNames} />
          ) : tab === '3d' ? (
            telemetry ? (
              <Suspense fallback={<p className="replay3d-loading">Cargando la vista 3D…</p>}>
                <Replay3DPanel
                  telemetry={telemetry}
                  currentTime={currentTime}
                  isPlaying={isPlaying}
                  getVideoTime={getVideoTime}
                  playerNames={playerNames}
                  onSeek={onSeek}
                />
              </Suspense>
            ) : (
              <p className="replay3d-loading">Abre un partido para ver el punto en 3D.</p>
            )
          ) : (
            <MatchStatsPanel telemetry={telemetry} currentTime={currentTime} playerNames={playerNames} view={tab} />
          )}
        </div>
      </section>
    </aside>
  )
}
