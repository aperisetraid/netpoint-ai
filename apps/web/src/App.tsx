import { useEffect, useMemo, useState } from 'react'

import { IngestPanel } from './components/ingest/IngestPanel'
import { PlayerNamesDialog, type PlayerNames } from './components/ingest/PlayerNamesDialog'
import { LandingView } from './components/landing/LandingView'
import { LibraryView } from './components/library/LibraryView'
import { AnalysisSidebar } from './components/layout/AnalysisSidebar'
import { type Theme, WorkspaceHeader } from './components/layout/WorkspaceHeader'
import { ProcessingOverlay } from './components/loader/ProcessingOverlay'
import { VideoPlayer } from './components/video/VideoPlayer'
import { type AnalysisRequest, useMatchAnalysis } from './hooks/useMatchAnalysis'
import { findFrameAt } from './lib/frameLookup.ts'
import { getMatchVideoUrl } from './services/api'
import './App.css'
import './Workspace.css'

function App() {
  const [theme, setTheme] = useState<Theme>(() =>
    window.localStorage.getItem('netpoint-theme') === 'light' ? 'light' : 'dark',
  )
  const [view, setView] = useState<'landing' | 'library' | 'analysis'>('landing')
  const [playerNames, setPlayerNames] = useState<PlayerNames>({ far: '', near: '' })
  const [pendingRequest, setPendingRequest] = useState<AnalysisRequest | null>(null)
  // Playback position at the rate of the video's own events; the canvas overlay keeps its own clock.
  const [currentTime, setCurrentTime] = useState(0)
  const [isVideoPlaying, setIsVideoPlaying] = useState(false)
  const { analysis, errorMessage, isSubmitting, progress, start, openSaved } = useMatchAnalysis()
  // Source menu: open by default while there is nothing to show, collapsed once a match is loaded.
  const [sourceOpen, setSourceOpen] = useState<boolean | null>(null)
  const showSource = !isSubmitting && (sourceOpen ?? (analysis === null || errorMessage !== null))

  useEffect(() => {
    window.localStorage.setItem('netpoint-theme', theme)
  }, [theme])

  useEffect(() => {
    if (!showSource) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSourceOpen(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [showSource])

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

  async function handleOpenSaved(matchId: string) {
    await openSaved(matchId)
    setPlayerNames({ far: '', near: '' })
    setCurrentTime(0)
    setIsVideoPlaying(false)
    setSourceOpen(false)
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
          onLibrary={() => setView('library')}
        />
      ) : view === 'library' ? (
        <LibraryView
          theme={theme}
          onThemeChange={setTheme}
          onHome={() => setView('landing')}
          onWorkspace={() => setView('analysis')}
          onOpen={handleOpenSaved}
        />
      ) : (
      <div className="workspace">
        <div className="workspace-top">
          <WorkspaceHeader
            title={analysis?.title ?? 'Centro de análisis'}
            status={analysis ? 'completed' : isSubmitting ? 'processing' : 'idle'}
            frameCount={telemetry ? telemetry.frames.length : null}
            theme={theme}
            sourceOpen={showSource}
            onThemeChange={setTheme}
            onToggleSource={() => setSourceOpen(!showSource)}
            onHome={() => setView('landing')}
            onLibrary={() => setView('library')}
          />

          {/* Floating source menu: it overlays the workspace instead of taking vertical space. */}
          {showSource ? <div className="source-backdrop" onClick={() => setSourceOpen(false)} aria-hidden="true" /> : null}
          <div id="source-popover" className="source-popover" data-open={showSource} inert={!showSource}>
            <IngestPanel
              isSubmitting={isSubmitting}
              errorMessage={errorMessage}
              isCompleted={analysis !== null}
              onSubmit={(request) => {
                setSourceOpen(false)
                setPendingRequest(request)
              }}
            />
          </div>
        </div>

        <div className="workspace-body" aria-busy={isSubmitting}>
          {/* Inert while analysing: no double submits and no reading of partial data. */}
          <div className="workspace-main" inert={isSubmitting}>
            <section className="stage" aria-label="Reproducción del partido">
              <VideoPlayer
                key={analysis?.matchId ?? 'empty'}
                sourceUrl={analysis ? getMatchVideoUrl(analysis.matchId) : ''}
                telemetry={telemetry}
                onTimeChange={setCurrentTime}
                onPlaybackChange={setIsVideoPlaying}
                onRequestSource={() => setSourceOpen(true)}
              />
            </section>

            <AnalysisSidebar
              analysis={analysis}
              telemetry={telemetry}
              frame={currentFrame}
              bounces={visibleBounces}
              currentTime={currentTime}
              isPlaying={isVideoPlaying}
              playerNames={playerNames}
            />
          </div>
          <ProcessingOverlay active={isSubmitting} progress={progress} />
        </div>
      </div>
      )}
    </main>
  )
}

export default App
