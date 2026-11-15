import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, ArrowRight, FolderOpen, Plus, RefreshCw, Search } from 'lucide-react'

import { type LibrarySort, filterLibrary, librarySortLabels } from '../../lib/libraryFilter.ts'
import { ApiError, type LibraryMatch, listLibraryMatches } from '../../services/api'
import { type Theme, ThemeToggle } from '../layout/ThemeToggle'
import { MatchCard } from './MatchCard'
import './Library.css'

interface LibraryViewProps {
  theme: Theme
  onThemeChange: (theme: Theme) => void
  onHome: () => void
  /** Goes to the workspace (with the current analysis, if any). */
  onWorkspace: () => void
  /** Loads a stored analysis; rejects when it cannot be read. */
  onOpen: (matchId: string) => Promise<void>
}

type LoadState = 'loading' | 'ready' | 'error'

function errorText(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback
}

/** Grid of the analyses already stored: pick one to load it without reprocessing the video. */
export function LibraryView({ theme, onThemeChange, onHome, onWorkspace, onOpen }: LibraryViewProps) {
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
    listLibraryMatches().then(
      (result) => {
        if (!current) return
        setMatches(result)
        setState('ready')
      },
      (error: unknown) => {
        if (!current) return
        setLoadError(errorText(error, 'No se pudo cargar la biblioteca.'))
        setState('error')
      },
    )
    return () => { current = false }
  }, [reloadKey])

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
      <header className="library-nav">
        <button type="button" className="library-nav__brand" onClick={onHome} title="Volver al inicio">
          NETPOINT <strong>AI</strong>
        </button>
        <nav className="library-nav__tabs" aria-label="Secciones">
          <button type="button" onClick={onWorkspace}>Análisis</button>
          <button type="button" aria-current="page">Biblioteca</button>
        </nav>
        <ThemeToggle theme={theme} onThemeChange={onThemeChange} />
      </header>

      <section className="library-head" aria-labelledby="library-title">
        <div>
          <span className="eyebrow">HISTORIAL</span>
          <h1 id="library-title">Biblioteca de partidos</h1>
          <p>Abre un análisis guardado al instante: la telemetría y el vídeo ya están procesados.</p>
        </div>
        <button type="button" className="library-action" onClick={onWorkspace}>
          <Plus size={16} aria-hidden="true" /> Nuevo análisis
        </button>
      </section>

      <div className="library-toolbar">
        <label className="library-search">
          <Search size={16} aria-hidden="true" />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Buscar por título o archivo"
            aria-label="Buscar partidos"
          />
        </label>
        <label className="library-sort">
          <span>Ordenar</span>
          <select value={sort} onChange={(event) => setSort(event.target.value as LibrarySort)}>
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
        <div className="library-notice" role="alert">
          <AlertTriangle size={17} aria-hidden="true" /> {openError}
        </div>
      ) : null}

      {state === 'loading' ? (
        <ul className="library-grid" aria-busy="true" aria-label="Cargando partidos">
          {Array.from({ length: 6 }, (_, index) => (
            <li key={index} className="match-skeleton" style={{ '--card-index': index } as React.CSSProperties}>
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
          <button type="button" className="library-action" onClick={retry}>
            <RefreshCw size={15} aria-hidden="true" /> Reintentar
          </button>
        </div>
      ) : null}

      {state === 'ready' && matches.length === 0 ? (
        <div className="library-empty">
          <FolderOpen size={32} strokeWidth={1.4} aria-hidden="true" />
          <h2>Aún no hay partidos analizados</h2>
          <p>Cuando analices un vídeo aparecerá aquí para que puedas reabrirlo sin recalcularlo.</p>
          <button type="button" className="library-action" onClick={onWorkspace}>
            Analizar un vídeo <ArrowRight size={15} aria-hidden="true" />
          </button>
        </div>
      ) : null}

      {state === 'ready' && matches.length > 0 && visible.length === 0 ? (
        <div className="library-empty">
          <Search size={30} strokeWidth={1.4} aria-hidden="true" />
          <h2>Sin resultados</h2>
          <p>Ningún partido coincide con «{query.trim()}».</p>
          <button type="button" className="library-action" onClick={() => setQuery('')}>Limpiar búsqueda</button>
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
