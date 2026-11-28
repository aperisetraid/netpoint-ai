import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, FolderOpen, LoaderCircle, Plus, RefreshCw, Search } from 'lucide-react'

import { type LibrarySort, filterLibrary, librarySortLabels } from '../../lib/libraryFilter.ts'
import { SLOW_LOAD_MS, shouldKeepWaking, wakeRetryDelay } from '../../lib/wakeRetry.ts'
import { ApiError, type LibraryMatch, listLibraryMatches } from '../../services/api'
import { AppNav } from '../layout/AppNav'
import type { Theme } from '../layout/ThemeToggle'
import { MatchCard } from './MatchCard'
import './Library.css'

interface LibraryViewProps {
  theme: Theme
  onThemeChange: (theme: Theme) => void
  onHome: () => void
  /** Goes to the workspace (with the current analysis, if any). */
  onWorkspace: () => void
  /** False in the public demo, which only opens stored matches. */
  allowNewAnalysis?: boolean
  /** Loads a stored analysis; rejects when it cannot be read. */
  onOpen: (matchId: string) => Promise<void>
  /**
   * The public demo sleeps on free hosting: wait for it to wake (retrying, with a note) instead of failing
   * on the first request.
   */
  waitForWake?: boolean
}

type LoadState = 'loading' | 'waking' | 'ready' | 'error'

function errorText(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback
}

/** Grid of the analyses already stored: pick one to load it without reprocessing the video. */
export function LibraryView({
  theme, onThemeChange, onHome, onWorkspace, onOpen, allowNewAnalysis = true, waitForWake = false,
}: LibraryViewProps) {
  const [matches, setMatches] = useState<LibraryMatch[]>([])
  const [state, setState] = useState<LoadState>('loading')
  const [loadError, setLoadError] = useState('')
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<LibrarySort>('recent')
  const [openingId, setOpeningId] = useState<string | null>(null)
  const [openError, setOpenError] = useState<string | null>(null)

  const [reloadKey, setReloadKey] = useState(0)

  useEffect(() => {
    let current = true
    let retryTimer: number | undefined
    const startedAt = Date.now()
    // A sleeping service answers slowly too: after a few seconds, explain the wait.
    const slowTimer = waitForWake
      ? window.setTimeout(() => setState((state) => (state === 'loading' ? 'waking' : state)), SLOW_LOAD_MS)
      : undefined

    const load = (attempt: number) => {
      listLibraryMatches().then(
        (result) => {
          if (!current) return
          setMatches(result)
          setState('ready')
        },
        (error: unknown) => {
          if (!current) return
          const status = error instanceof ApiError ? error.status : undefined
          if (waitForWake && shouldKeepWaking(status, Date.now() - startedAt)) {
            setState('waking')
            retryTimer = window.setTimeout(() => load(attempt + 1), wakeRetryDelay(attempt))
            return
          }
          setLoadError(
            waitForWake
              ? 'El servidor no ha respondido. Vuelve a intentarlo en un minuto.'
              : errorText(error, 'No se pudo cargar la biblioteca.'),
          )
          setState('error')
        },
      )
    }
    load(0)
    return () => {
      current = false
      window.clearTimeout(retryTimer)
      window.clearTimeout(slowTimer)
    }
  }, [reloadKey, waitForWake])

  function retry() {
    setState('loading')
    setReloadKey((key) => key + 1)
  }

  const visible = useMemo(() => filterLibrary(matches, query, sort), [matches, query, sort])

  async function handleOpen(matchId: string) {
    if (openingId) return
    setOpeningId(matchId)
    setOpenError(null)
    try {
      await onOpen(matchId)
    } catch (error) {
      setOpenError(errorText(error, 'No se pudo abrir el partido.'))
      setOpeningId(null)
    }
  }

  return (
    <div className="library">
      <AppNav
        theme={theme}
        onThemeChange={onThemeChange}
        onHome={onHome}
        links={(
          <>
            <button type="button" onClick={onWorkspace}>Análisis</button>
            <button type="button" aria-current="page">Biblioteca</button>
          </>
        )}
        actions={allowNewAnalysis ? (
          <button type="button" className="btn btn--primary" onClick={onWorkspace}>
            <Plus size={15} aria-hidden="true" /> Nuevo análisis
          </button>
        ) : undefined}
      />

      <section className="library-head" aria-labelledby="library-title">
        <h1 id="library-title" className="display">Biblioteca</h1>
        <p>Los partidos que ya analizaste. Ábrelos al instante, sin volver a procesar el vídeo.</p>
      </section>

      <div className="library-toolbar">
        <label className="library-search">
          <Search size={16} aria-hidden="true" />
          <input
            className="field__control"
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Buscar por título o archivo"
            aria-label="Buscar partidos"
          />
        </label>
        <label className="library-sort">
          <span>Ordenar por</span>
          <select className="field__control" value={sort} onChange={(event) => setSort(event.target.value as LibrarySort)}>
            {(Object.keys(librarySortLabels) as LibrarySort[]).map((key) => (
              <option key={key} value={key}>{librarySortLabels[key]}</option>
            ))}
          </select>
        </label>
        <span className="library-count" aria-live="polite">
          {state === 'ready' ? `${visible.length} de ${matches.length}` : ''}
        </span>
      </div>

      {openError ? (
        <div className="notice notice--error library-notice" role="alert">
          <AlertTriangle size={16} aria-hidden="true" /> <span>{openError}</span>
        </div>
      ) : null}

      {state === 'waking' ? (
        <div className="notice library-notice" role="status">
          <LoaderCircle size={16} className="animate-spin" aria-hidden="true" />
          <div>
            <strong>Despertando el servidor…</strong>
            <span>
              La demo está en un alojamiento gratuito que se duerme tras un rato sin visitas. Tarda menos de un
              minuto; la biblioteca aparecerá sola.
            </span>
          </div>
        </div>
      ) : null}

      {state === 'loading' || state === 'waking' ? (
        <ul className="library-grid" aria-busy="true" aria-label="Cargando partidos">
          {Array.from({ length: 6 }, (_, index) => (
            <li key={index} className="match-skeleton">
              <span /><span /><span />
            </li>
          ))}
        </ul>
      ) : null}

      {state === 'error' ? (
        <div className="library-empty" role="alert">
          <AlertTriangle size={30} strokeWidth={1.4} aria-hidden="true" />
          <h2>No se pudo cargar la biblioteca</h2>
          <p>{loadError}</p>
          <button type="button" className="btn btn--secondary" onClick={retry}>
            <RefreshCw size={15} aria-hidden="true" /> Reintentar
          </button>
        </div>
      ) : null}

      {state === 'ready' && matches.length === 0 ? (
        <div className="library-empty">
          <FolderOpen size={32} strokeWidth={1.4} aria-hidden="true" />
          <h2>Aún no hay partidos analizados</h2>
          <p>Cuando analices un vídeo aparecerá aquí, listo para reabrirlo sin volver a procesarlo.</p>
          {allowNewAnalysis ? (
            <button type="button" className="btn btn--primary" onClick={onWorkspace}>
              Analizar un vídeo
            </button>
          ) : null}
        </div>
      ) : null}

      {state === 'ready' && matches.length > 0 && visible.length === 0 ? (
        <div className="library-empty">
          <Search size={30} strokeWidth={1.4} aria-hidden="true" />
          <h2>Sin resultados</h2>
          <p>Ningún partido coincide con «{query.trim()}».</p>
          <button type="button" className="btn btn--secondary" onClick={() => setQuery('')}>Limpiar búsqueda</button>
        </div>
      ) : null}

      {state === 'ready' && visible.length > 0 ? (
        <ul className="library-grid" aria-label="Partidos analizados">
          {visible.map((match, index) => (
            <MatchCard
              key={match.id}
              match={match}
              index={index}
              isOpening={openingId === match.id}
              disabled={openingId !== null}
              onOpen={handleOpen}
            />
          ))}
        </ul>
      ) : null}
    </div>
  )
}
