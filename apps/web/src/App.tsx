import { useEffect, useMemo, useState } from 'react'

import { CourtMap } from './components/court/CourtMap'
import { IngestPanel } from './components/ingest/IngestPanel'
import { PlayerNamesDialog, type PlayerNames } from './components/ingest/PlayerNamesDialog'
import { FrameInspector } from './components/inspector/FrameInspector'
import { LandingView } from './components/landing/LandingView'
import { type Theme, WorkspaceHeader } from './components/layout/WorkspaceHeader'
import { MatchStatsPanel } from './components/stats/MatchStatsPanel'
import { VideoPlayer } from './components/video/VideoPlayer'
import { type AnalysisRequest, useMatchAnalysis } from './hooks/useMatchAnalysis'
import { findFrameAt } from './lib/frameLookup.ts'
import { getMatchVideoUrl } from './services/api'
import './App.css'

function App() {
  const [theme, setTheme] = useState<Theme>(() =>
    window.localStorage.getItem('netpoint-theme') === 'light' ? 'light' : 'dark',
  )
  const [view, setView] = useState<'landing' | 'analysis'>('landing')
  const [playerNames, setPlayerNames] = useState<PlayerNames>({ far: '', near: '' })
  const [pendingRequest, setPendingRequest] = useState<AnalysisRequest | null>(null)
  // Playback position at the rate of the video's own events; the canvas overlay keeps its own clock.
  const [currentTime, setCurrentTime] = useState(0)
  const [isVideoPlaying, setIsVideoPlaying] = useState(false)
  const { analysis, errorMessage, isSubmitting, progress, start } = useMatchAnalysis()

  useEffect(() => {
    window.localStorage.setItem('netpoint-theme', theme)
  }, [theme])

  const telemetry = analysis?.telemetry ?? null
  const currentFrame = useMemo(
    () => (telemetry ? findFrameAt(telemetry.frames, currentTime) : undefined),
    [telemetry, currentTime],
  )
  const visibleBounces = useMemo(
    () => (telemetry && currentFrame
      ? telemetry.events.bounces.filter((bounce) => bounce.timestamp_seconds <= currentTime)
      : []),
    [telemetry, currentFrame, currentTime],
  )

  function handlePlayerNames(names: PlayerNames) {
    setPlayerNames(names)
    setCurrentTime(0)
    setIsVideoPlaying(false)
    if (pendingRequest) void start(pendingRequest)
    setPendingRequest(null)
    setView('analysis')
  }

  return (
    <main className="app-shell" data-theme={theme}>
      <PlayerNamesDialog
        open={pendingRequest !== null}
        onCancel={() => setPendingRequest(null)}
        onConfirm={handlePlayerNames}
      />
      {view === 'landing' ? (
        <LandingView
          theme={theme}
          onThemeChange={setTheme}
          onStart={() => setView('analysis')}
          onSelectVideo={setPendingRequest}
        />
      ) : (
      <div className="app-layout">
        <WorkspaceHeader
          title={analysis?.title ?? 'Centro de análisis'}
          status={analysis ? 'completed' : isSubmitting ? 'processing' : 'idle'}
          frameCount={telemetry ? telemetry.frames.length : null}
          theme={theme}
          onThemeChange={setTheme}
          onHome={() => setView('landing')}
        />

        <IngestPanel
          isSubmitting={isSubmitting}
          progress={progress}
          errorMessage={errorMessage}
          isCompleted={analysis !== null}
          onSubmit={setPendingRequest}
        />

        <section className="analysis-grid" aria-label="Revisión del partido">
          <CourtMap
            hasAnalysis={analysis !== null}
            frame={currentFrame}
            bounces={visibleBounces}
            playerNames={playerNames}
          />

          <section className="workspace-panel source-panel analysis-panel--video">
            <div className="panel-heading">
              <div>
                <span className="eyebrow">REPRODUCCIÓN</span>
                <h2>Video fuente</h2>
              </div>
              {analysis?.title ? <span className="source-title">{analysis.title}</span> : null}
            </div>
            <VideoPlayer
              key={analysis?.matchId ?? 'empty'}
              sourceUrl={analysis ? getMatchVideoUrl(analysis.matchId) : ''}
              telemetry={telemetry}
              onTimeChange={setCurrentTime}
              onPlaybackChange={setIsVideoPlaying}
            />
          </section>

          <div className="analysis-panel--frames">
            <FrameInspector analysis={analysis} frame={currentFrame} isPlaying={isVideoPlaying} />
          </div>

          <MatchStatsPanel telemetry={telemetry} currentTime={currentTime} playerNames={playerNames} />
        </section>
      </div>
      )}
    </main>
  )
}

export default App
