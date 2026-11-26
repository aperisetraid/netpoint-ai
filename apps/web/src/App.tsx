import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { CoachPanel } from './components/coach/CoachPanel'
import { IngestPanel } from './components/ingest/IngestPanel'
import { PlayerNamesDialog, type PlayerNames } from './components/ingest/PlayerNamesDialog'
import { LandingView } from './components/landing/LandingView'
import { LibraryView } from './components/library/LibraryView'
import { AnalysisSidebar } from './components/layout/AnalysisSidebar'
import { type Theme, WorkspaceHeader } from './components/layout/WorkspaceHeader'
import { ProcessingOverlay } from './components/loader/ProcessingOverlay'
import { VideoPlayer, type VideoPlayerHandle } from './components/video/VideoPlayer'
import { type AnalysisRequest, useMatchAnalysis } from './hooks/useMatchAnalysis'
import { findFrameAt } from './lib/frameLookup.ts'
import { getMatchVideoUrl } from './services/api'
import { demoMode } from './config'
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
  const [coachOpen, setCoachOpen] = useState(false)
  const playerRef = useRef<VideoPlayerHandle>(null)
  const { analysis, errorMessage, isSubmitting, progress, start, openSaved } = useMatchAnalysis()
  // Source menu: open by default while there is nothing to show, collapsed once a match is loaded.
  const [sourceOpen, setSourceOpen] = useState<boolean | null>(null)
  // The public demo never analyses new videos, so the source menu stays closed.
  const showSource = !demoMode && !isSubmitting && (sourceOpen ?? (analysis === null || errorMessage !== null))

  useEffect(() => {
    window.localStorage.setItem('netpoint-theme', theme)
    // Tokens live on <html>, so the page background and the dialog backdrop follow the theme too.
    document.documentElement.dataset.theme = theme
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

  const getVideoTime = useCallback(() => playerRef.current?.getTime() ?? null, [])

  // Timestamp links from the coach move the video; on stacked layouts the player is brought into view.
  const seekVideo = useCallback((seconds: number) => {
    playerRef.current?.seekTo(seconds)
    if (window.matchMedia('(max-width: 1100px)').matches) {
      document.querySelector('.stage')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
  }, [])

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
          onStart={() => setView(demoMode ? 'library' : 'analysis')}
          onSelectVideo={setPendingRequest}
          onLibrary={() => setView('library')}
          demo={demoMode}
        />
      ) : view === 'library' ? (
        <LibraryView
          theme={theme}
          onThemeChange={setTheme}
          onHome={() => setView('landing')}
          onWorkspace={() => setView('analysis')}
          onOpen={handleOpenSaved}
          allowNewAnalysis={!demoMode}
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
            coachOpen={coachOpen}
            coachEnabled={analysis !== null && !isSubmitting}
            onThemeChange={setTheme}
            onToggleSource={() => setSourceOpen(!showSource)}
            onToggleCoach={() => setCoachOpen(!coachOpen)}
            onHome={() => setView('landing')}
            onLibrary={() => setView('library')}
            allowNewAnalysis={!demoMode}
            showCoach={!demoMode}
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
                ref={playerRef}
                key={analysis?.matchId ?? 'empty'}
                sourceUrl={analysis ? getMatchVideoUrl(analysis.matchId) : ''}
                telemetry={telemetry}
                onTimeChange={setCurrentTime}
                onPlaybackChange={setIsVideoPlaying}
                onRequestSource={() => setSourceOpen(true)}
              />
            </section>

            {/* Both panels stay mounted: closing the coach mid-answer does not cut the answer off. */}
            <div id="side-panel" className="side-stack" data-view={coachOpen && analysis ? 'coach' : 'analysis'}>
              <div className="side-stack__pane" inert={coachOpen && analysis !== null}>
                <AnalysisSidebar
                  analysis={analysis}
                  telemetry={telemetry}
                  frame={currentFrame}
                  bounces={visibleBounces}
                  currentTime={currentTime}
                  isPlaying={isVideoPlaying}
                  playerNames={playerNames}
                  getVideoTime={getVideoTime}
                  onSeek={seekVideo}
                />
              </div>
              {demoMode ? null : (
                <div className="side-stack__pane side-stack__pane--coach" inert={!coachOpen || analysis === null}>
                  <CoachPanel
                    matchId={isSubmitting ? null : analysis?.matchId ?? null}
                    playerNames={playerNames}
                    currentTime={currentTime}
                    hasVideo={analysis !== null}
                    onSeek={seekVideo}
                    onClose={() => setCoachOpen(false)}
                  />
                </div>
              )}
            </div>
          </div>
          <ProcessingOverlay active={isSubmitting} progress={progress} />
        </div>
      </div>
      )}
    </main>
  )
}

export default App
