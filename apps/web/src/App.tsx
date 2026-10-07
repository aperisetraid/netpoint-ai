import { useRef, useState } from 'react'
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Gauge,
  Radar,
  RefreshCw,
  Video,
} from 'lucide-react'

import {
  ApiError,
  type MatchTelemetryResponse,
  getMatchTelemetry,
  processMatch,
} from './services/api'
import './App.css'

interface AnalysisResult {
  matchId: string
  status: 'processing'
  sourceUrl: string
  title?: string
  telemetry: MatchTelemetryResponse
}

interface ShotCardProps {
  telemetry: MatchTelemetryResponse
}

const courtWidth = 8.23
const courtHeight = 23.77

function formatPercent(value: number): string {
  return `${Math.round(value)}%`
}

function formatDecimal(value: number): string {
  return value.toFixed(1)
}

function CourtVisualization({ telemetry }: ShotCardProps) {
  return (
    <svg
      viewBox="0 0 823 2377"
      className="h-full w-full"
      role="img"
      aria-label="Visualización mock de botes sobre la pista"
    >
      <rect x="16" y="16" width="791" height="2345" rx="36" className="court-frame" />
      <rect x="52" y="52" width="719" height="2273" rx="20" className="court-surface" />
      <line x1="411.5" y1="52" x2="411.5" y2="2325" className="court-line court-line--soft" />
      <line x1="52" y1="1188.5" x2="771" y2="1188.5" className="court-line" />
      <line x1="52" y1="517" x2="771" y2="517" className="court-line court-line--soft" />
      <line x1="52" y1="1860" x2="771" y2="1860" className="court-line court-line--soft" />
      <line x1="231.75" y1="52" x2="231.75" y2="2325" className="court-line" />
      <line x1="591.25" y1="52" x2="591.25" y2="2325" className="court-line" />

      {telemetry.shots.map((shot) => {
        const pointX = 52 + (shot.bounceCoordinates.x / courtWidth) * 719
        const pointY = 52 + (shot.bounceCoordinates.y / courtHeight) * 2273

        return (
          <g key={`${shot.shotNumber}-${shot.timestamp}`}>
            <circle
              cx={pointX}
              cy={pointY}
              r="26"
              className={shot.isInside ? 'shot-ring shot-ring--inside' : 'shot-ring shot-ring--outside'}
            />
            <circle
              cx={pointX}
              cy={pointY}
              r="12"
              className={shot.isInside ? 'shot-core shot-core--inside' : 'shot-core shot-core--outside'}
            />
            <text x={pointX} y={pointY + 5} textAnchor="middle" className="shot-label">
              {shot.shotNumber}
            </text>
          </g>
        )
      })}
    </svg>
  )
}

function App() {
  const [sourceUrl, setSourceUrl] = useState('https://example.com/partidos/final-mock.mp4')
  const [title, setTitle] = useState('Final ATP - Video de referencia')
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const requestSequenceRef = useRef(0)

  const shots = analysis?.telemetry.shots ?? []
  const insideShots = shots.filter((shot) => shot.isInside).length
  const averageSpeed = shots.length
    ? shots.reduce((sum, shot) => sum + shot.speedKmH, 0) / shots.length
    : 0
  const insidePercentage = shots.length ? (insideShots / shots.length) * 100 : 0

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()

    if (isSubmitting) {
      return
    }

    const trimmedSourceUrl = sourceUrl.trim()
    const trimmedTitle = title.trim()
    const requestSequence = requestSequenceRef.current + 1

    requestSequenceRef.current = requestSequence
    setIsSubmitting(true)
    setErrorMessage(null)
    setAnalysis(null)

    try {
      const processResponse = await processMatch({
        sourceUrl: trimmedSourceUrl,
        title: trimmedTitle || undefined,
      })

      if (requestSequence !== requestSequenceRef.current) {
        return
      }

      const telemetry = await getMatchTelemetry(processResponse.matchId)

      if (requestSequence !== requestSequenceRef.current) {
        return
      }

      setAnalysis({
        matchId: processResponse.matchId,
        status: processResponse.status,
        sourceUrl: trimmedSourceUrl,
        title: trimmedTitle || undefined,
        telemetry,
      })
    } catch (error) {
      if (requestSequence !== requestSequenceRef.current) {
        return
      }

      if (error instanceof ApiError) {
        setErrorMessage(error.message)
      } else {
        setErrorMessage('Ocurrió un error inesperado durante el análisis.')
      }
    } finally {
      if (requestSequence === requestSequenceRef.current) {
        setIsSubmitting(false)
      }
    }
  }

  return (
    <main className="app-shell min-h-screen bg-(--color-bg) text-(--color-foreground)">
      <div className="mx-auto flex min-h-screen max-w-7xl flex-col gap-6 px-4 py-5 sm:px-6 lg:px-8">
        <header className="panel-surface grid gap-4 rounded-[28px] border border-white/10 px-5 py-5 shadow-2xl shadow-black/30 sm:px-8 sm:py-7 lg:grid-cols-[1.4fr_0.9fr]">
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-3 text-[0.72rem] font-semibold uppercase tracking-[0.28em] text-lime-300/85">
              <span className="rounded-full border border-lime-400/30 bg-lime-400/10 px-3 py-1">NetPoint AI</span>
              <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-white/60">
                Telemetría mock inmediata
              </span>
            </div>

            <div className="space-y-3">
              <h1 className="max-w-3xl text-3xl font-semibold tracking-[-0.04em] text-white sm:text-4xl lg:text-[3.1rem]">
                Panel operativo para procesar partidos y revisar botes en segundos.
              </h1>
              <p className="max-w-2xl text-sm leading-6 text-white/70 sm:text-base">
                Ingresa una URL válida, dispara el procesamiento y revisa velocidad, porcentaje
                dentro y la distribución de tiros sobre una pista simulada.
              </p>
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-1">
            <article className="rounded-3xl border border-white/8 bg-black/20 p-4">
              <div className="flex items-center gap-2 text-xs uppercase tracking-[0.22em] text-white/45">
                <Activity className="h-4 w-4 text-lime-300" />
                Estado
              </div>
              <p className="mt-3 text-2xl font-semibold text-white">
                {analysis ? 'Procesado' : isSubmitting ? 'Ejecutando' : 'En espera'}
              </p>
            </article>
            <article className="rounded-3xl border border-white/8 bg-black/20 p-4">
              <div className="flex items-center gap-2 text-xs uppercase tracking-[0.22em] text-white/45">
                <Radar className="h-4 w-4 text-lime-300" />
                Rallies
              </div>
              <p className="mt-3 text-2xl font-semibold text-white">
                {analysis?.telemetry.totalRallies ?? '00'}
              </p>
            </article>
            <article className="rounded-3xl border border-white/8 bg-black/20 p-4">
              <div className="flex items-center gap-2 text-xs uppercase tracking-[0.22em] text-white/45">
                <Gauge className="h-4 w-4 text-lime-300" />
                Velocidad media
              </div>
              <p className="mt-3 text-2xl font-semibold text-white">
                {analysis ? `${formatDecimal(averageSpeed)} km/h` : '--'}
              </p>
            </article>
          </div>
        </header>

        <section className="grid gap-6 lg:grid-cols-[0.95fr_1.05fr]">
          <section className="panel-surface rounded-[28px] border border-white/10 p-5 shadow-xl shadow-black/25 sm:p-6">
            <div className="mb-5 flex items-center justify-between gap-3">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.24em] text-white/45">
                  Ingesta
                </p>
                <h2 className="mt-2 text-xl font-semibold text-white">Analizar Partido</h2>
              </div>
              <div className="rounded-full border border-lime-400/25 bg-lime-400/10 px-3 py-1 text-xs font-medium text-lime-200">
                Entorno local
              </div>
            </div>

            <form className="space-y-4" onSubmit={handleSubmit} noValidate>
              <label className="block">
                <span className="mb-2 block text-sm font-medium text-white/78">URL del video</span>
                <input
                  type="url"
                  required
                  value={sourceUrl}
                  onChange={(event) => setSourceUrl(event.target.value)}
                  placeholder="https://..."
                  className="w-full rounded-2xl border border-white/10 bg-black/25 px-4 py-3 text-sm text-white outline-none transition focus:border-lime-400/60 focus:ring-2 focus:ring-lime-400/20"
                />
              </label>

              <label className="block">
                <span className="mb-2 block text-sm font-medium text-white/78">Título operativo</span>
                <input
                  type="text"
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  placeholder="Final ATP - Set 1"
                  className="w-full rounded-2xl border border-white/10 bg-black/25 px-4 py-3 text-sm text-white outline-none transition focus:border-lime-400/60 focus:ring-2 focus:ring-lime-400/20"
                />
              </label>

              <button
                type="submit"
                disabled={isSubmitting || sourceUrl.trim().length === 0}
                className="inline-flex w-full items-center justify-center gap-2 rounded-2xl bg-lime-300 px-4 py-3 text-sm font-semibold text-zinc-950 transition hover:bg-lime-200 disabled:cursor-not-allowed disabled:bg-lime-100/50"
              >
                {isSubmitting ? (
                  <>
                    <RefreshCw className="h-4 w-4 animate-spin" />
                    Analizando...
                  </>
                ) : (
                  <>
                    <Video className="h-4 w-4" />
                    Analizar Partido
                  </>
                )}
              </button>
            </form>

            <div className="mt-5 rounded-3xl border border-dashed border-white/10 bg-black/20 p-4 text-sm text-white/60">
              La respuesta del backend es mock. No se infiere vídeo real ni visión computacional en este flujo.
            </div>

            {errorMessage ? (
              <div
                className="mt-5 flex items-start gap-3 rounded-3xl border border-rose-400/25 bg-rose-500/10 p-4 text-sm text-rose-100"
                role="alert"
              >
                <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-rose-300" />
                <div>
                  <p className="font-semibold">No se pudo completar el análisis</p>
                  <p className="mt-1 text-rose-100/85">{errorMessage}</p>
                </div>
              </div>
            ) : null}

            {analysis ? (
              <div className="mt-5 rounded-3xl border border-lime-400/20 bg-lime-400/8 p-4 text-sm text-lime-100">
                <div className="flex items-start gap-3">
                  <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-lime-300" />
                  <div>
                    <p className="font-semibold">Procesamiento aceptado</p>
                    <p className="mt-1 break-all text-lime-100/80">Match ID: {analysis.matchId}</p>
                    <p className="mt-1 text-lime-100/75">Estado: {analysis.status}</p>
                  </div>
                </div>
              </div>
            ) : null}
          </section>

          <section className="grid gap-6">
            <section className="panel-surface rounded-[28px] border border-white/10 p-5 shadow-xl shadow-black/25 sm:p-6">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.24em] text-white/45">
                    Resumen
                  </p>
                  <h2 className="mt-2 text-xl font-semibold text-white">Métricas del partido</h2>
                </div>
                <div className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-white/55">
                  Datos derivados de shots
                </div>
              </div>

              <div className="mt-5 grid gap-3 sm:grid-cols-3">
                <article className="rounded-3xl border border-white/8 bg-black/25 p-4">
                  <p className="text-xs uppercase tracking-[0.22em] text-white/45">Total shots</p>
                  <p className="mt-3 text-3xl font-semibold text-white">{analysis ? shots.length : '--'}</p>
                </article>
                <article className="rounded-3xl border border-white/8 bg-black/25 p-4">
                  <p className="text-xs uppercase tracking-[0.22em] text-white/45">Dentro</p>
                  <p className="mt-3 text-3xl font-semibold text-white">
                    {analysis ? formatPercent(insidePercentage) : '--'}
                  </p>
                </article>
                <article className="rounded-3xl border border-white/8 bg-black/25 p-4">
                  <p className="text-xs uppercase tracking-[0.22em] text-white/45">Velocidad media</p>
                  <p className="mt-3 text-3xl font-semibold text-white">
                    {analysis ? `${formatDecimal(averageSpeed)} km/h` : '--'}
                  </p>
                </article>
              </div>

              {!analysis && !isSubmitting && !errorMessage ? (
                <div className="mt-5 rounded-3xl border border-dashed border-white/10 bg-white/4 p-5 text-sm text-white/55">
                  Carga una URL y ejecuta el análisis para ver el resumen táctico del partido.
                </div>
              ) : null}

              {isSubmitting ? (
                <div className="mt-5 flex items-center gap-3 rounded-3xl border border-white/10 bg-black/20 p-5 text-sm text-white/70">
                  <RefreshCw className="h-5 w-5 animate-spin text-lime-300" />
                  Recuperando telemetría del partido...
                </div>
              ) : null}
            </section>

            <section className="grid gap-6 xl:grid-cols-[1.1fr_0.9fr]">
              <section className="panel-surface overflow-hidden rounded-[28px] border border-white/10 p-5 shadow-xl shadow-black/25 sm:p-6">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-[0.24em] text-white/45">
                      Pista simulada
                    </p>
                    <h2 className="mt-2 text-xl font-semibold text-white">Mapa de botes</h2>
                  </div>
                  <span className="rounded-full border border-lime-400/25 bg-lime-400/10 px-3 py-1 text-xs text-lime-200">
                    Mock
                  </span>
                </div>

                <div className="mt-5 aspect-4/5 rounded-[26px] border border-white/8 bg-[linear-gradient(180deg,rgba(34,197,94,0.08),rgba(0,0,0,0))] p-3">
                  {analysis ? (
                    <CourtVisualization telemetry={analysis.telemetry} />
                  ) : (
                    <div className="court-placeholder flex h-full items-center justify-center rounded-[22px] border border-dashed border-white/10 text-center text-sm text-white/45">
                      El mapa de botes aparecerá cuando el backend devuelva la telemetría.
                    </div>
                  )}
                </div>
              </section>

              <section className="panel-surface rounded-[28px] border border-white/10 p-5 shadow-xl shadow-black/25 sm:p-6">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-[0.24em] text-white/45">
                      Feed operativo
                    </p>
                    <h2 className="mt-2 text-xl font-semibold text-white">Últimos tiros</h2>
                  </div>
                  {analysis ? (
                    <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-white/55">
                      {analysis.title ?? 'Sin título'}
                    </span>
                  ) : null}
                </div>

                <div className="mt-5 grid gap-3">
                  {analysis ? (
                    analysis.telemetry.shots.map((shot) => (
                      <article
                        key={`${shot.shotNumber}-${shot.timestamp}`}
                        className="rounded-3xl border border-white/8 bg-black/20 p-4"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <p className="text-sm font-semibold text-white">Shot {shot.shotNumber}</p>
                            <p className="mt-1 text-xs uppercase tracking-[0.18em] text-white/45">
                              {shot.player} · {formatDecimal(shot.timestamp)}s
                            </p>
                          </div>
                          <span
                            className={`rounded-full px-3 py-1 text-xs font-medium ${
                              shot.isInside
                                ? 'border border-lime-400/25 bg-lime-400/10 text-lime-200'
                                : 'border border-rose-400/25 bg-rose-500/10 text-rose-100'
                            }`}
                          >
                            {shot.isInside ? 'Dentro' : 'Fuera'}
                          </span>
                        </div>

                        <dl className="mt-4 grid grid-cols-2 gap-3 text-sm text-white/72">
                          <div>
                            <dt className="text-[0.68rem] uppercase tracking-[0.18em] text-white/40">
                              Velocidad
                            </dt>
                            <dd className="mt-1 font-medium text-white">{formatDecimal(shot.speedKmH)} km/h</dd>
                          </div>
                          <div>
                            <dt className="text-[0.68rem] uppercase tracking-[0.18em] text-white/40">
                              Bote
                            </dt>
                            <dd className="mt-1 font-medium text-white">
                              X {formatDecimal(shot.bounceCoordinates.x)} · Y {formatDecimal(shot.bounceCoordinates.y)}
                            </dd>
                          </div>
                        </dl>
                      </article>
                    ))
                  ) : (
                    <div className="rounded-3xl border border-dashed border-white/10 bg-white/4 p-5 text-sm text-white/55">
                      Sin tiros para mostrar todavía.
                    </div>
                  )}
                </div>
              </section>
            </section>

            <section className="panel-surface rounded-[28px] border border-white/10 p-5 shadow-xl shadow-black/25 sm:p-6">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.24em] text-white/45">
                    Video simulado
                  </p>
                  <h2 className="mt-2 text-xl font-semibold text-white">Canal de inspección</h2>
                </div>
                <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-white/55">
                  Fuente local configurable por env
                </span>
              </div>

              <div className="mt-5 grid gap-4 lg:grid-cols-[1.15fr_0.85fr]">
                <div className="relative overflow-hidden rounded-[28px] border border-white/8 bg-[radial-gradient(circle_at_top,rgba(163,230,53,0.18),transparent_40%),linear-gradient(180deg,#141414,#0a0a0a)] p-5">
                  <div className="absolute inset-0 bg-[linear-gradient(120deg,transparent,rgba(255,255,255,0.06),transparent)] opacity-50" />
                  <div className="relative flex aspect-video flex-col justify-between rounded-[22px] border border-white/8 bg-black/35 p-5">
                    <div className="flex items-center justify-between">
                      <span className="rounded-full border border-lime-400/25 bg-lime-400/10 px-3 py-1 text-xs font-medium text-lime-200">
                        Overlay mock
                      </span>
                      <span className="text-xs uppercase tracking-[0.2em] text-white/40">Sin stream real</span>
                    </div>
                    <div>
                      <p className="text-lg font-semibold text-white">{analysis?.title ?? 'Esperando análisis'}</p>
                      <p className="mt-2 break-all text-sm text-white/58">
                        {analysis?.sourceUrl ?? 'Ingresa una fuente para iniciar el pipeline local.'}
                      </p>
                    </div>
                  </div>
                </div>

                <div className="grid gap-3 rounded-[28px] border border-white/8 bg-black/20 p-4">
                  <div className="rounded-3xl border border-white/8 bg-white/4 p-4">
                    <p className="text-xs uppercase tracking-[0.2em] text-white/40">Shots dentro</p>
                    <p className="mt-2 text-2xl font-semibold text-white">
                      {analysis ? `${insideShots}/${shots.length}` : '--'}
                    </p>
                  </div>
                  <div className="rounded-3xl border border-white/8 bg-white/4 p-4">
                    <p className="text-xs uppercase tracking-[0.2em] text-white/40">Respuesta backend</p>
                    <p className="mt-2 text-sm text-white/72">
                      {analysis
                        ? 'POST /process + GET /telemetry completados correctamente.'
                        : 'Esperando respuesta del backend local.'}
                    </p>
                  </div>
                  <div className="rounded-3xl border border-white/8 bg-white/4 p-4">
                    <p className="text-xs uppercase tracking-[0.2em] text-white/40">Match ID</p>
                    <p className="mt-2 break-all text-sm text-white/72">{analysis?.matchId ?? '--'}</p>
                  </div>
                </div>
              </div>
            </section>
          </section>
        </section>
      </div>
    </main>
  )
}

export default App
