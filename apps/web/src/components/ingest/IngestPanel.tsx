import { useRef, useState } from 'react'
import { AlertTriangle, CheckCircle2, Link2, RefreshCw, Upload, Video } from 'lucide-react'

import type { AnalysisRequest } from '../../hooks/useMatchAnalysis'
import type { MatchProgressResponse } from '../../services/api'

interface IngestPanelProps {
  isSubmitting: boolean
  progress: MatchProgressResponse
  errorMessage: string | null
  isCompleted: boolean
  onSubmit: (request: AnalysisRequest) => void
}

const maximumVideoSizeBytes = 1024 * 1024 * 1024
const allowedExtensions = ['mp4', 'm4v', 'mov', 'avi', 'mkv', 'webm']

/** Source form: a video URL (YouTube or direct) or an uploaded file, plus processing feedback. */
export function IngestPanel({ isSubmitting, progress, errorMessage, isCompleted, onSubmit }: IngestPanelProps) {
  const [inputMode, setInputMode] = useState<'url' | 'file'>('url')
  const [sourceUrl, setSourceUrl] = useState('')
  const [selectedVideo, setSelectedVideo] = useState<File | null>(null)
  const [title, setTitle] = useState('')
  const [fileError, setFileError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const visibleError = fileError ?? errorMessage

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (isSubmitting) return
    const trimmedTitle = title.trim() || undefined
    if (inputMode === 'file') {
      if (selectedVideo) onSubmit({ file: selectedVideo, title: trimmedTitle })
    } else if (sourceUrl.trim()) {
      onSubmit({ sourceUrl: sourceUrl.trim(), title: trimmedTitle })
    }
  }

  function handleFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0]
    event.currentTarget.value = ''
    if (!file) return
    const extension = file.name.split('.').at(-1)?.toLowerCase()
    if (!allowedExtensions.includes(extension ?? '')) {
      setFileError('Formato no compatible. Selecciona MP4, M4V, MOV, AVI, MKV o WebM.')
      return
    }
    if (file.size > maximumVideoSizeBytes) {
      setFileError('El archivo supera el límite de 1 GB.')
      return
    }
    setSelectedVideo(file)
    setFileError(null)
  }

  return (
    <section className="ingest-panel" aria-label="Iniciar análisis">
      <div className="ingest-panel__heading">
        <div>
          <span className="eyebrow">FUENTE</span>
          <h2>Nuevo análisis</h2>
        </div>
        <div className="source-toggle" role="group" aria-label="Origen del video">
          <button type="button" aria-pressed={inputMode === 'url'} onClick={() => setInputMode('url')}>
            <Link2 size={16} /> URL
          </button>
          <button type="button" aria-pressed={inputMode === 'file'} onClick={() => setInputMode('file')}>
            <Upload size={16} /> Archivo
          </button>
        </div>
      </div>

      <form className={`ingest-form ingest-form--${inputMode}`} onSubmit={handleSubmit} noValidate>
        {inputMode === 'url' ? (
          <label className="field">
            <span>URL del video</span>
            <input
              type="url"
              required
              value={sourceUrl}
              onChange={(event) => setSourceUrl(event.target.value)}
              placeholder="https://..."
            />
          </label>
        ) : (
          <div className="file-field">
            <input
              ref={fileInputRef}
              className="sr-only"
              type="file"
              accept="video/mp4,video/webm,video/quicktime,video/x-msvideo,video/x-matroska,.m4v,.mkv"
              aria-label="Seleccionar archivo de video"
              onChange={handleFileChange}
            />
            <span className="field-label">Archivo de video</span>
            <button className="file-picker" type="button" onClick={() => fileInputRef.current?.click()}>
              <Upload size={17} />
              {selectedVideo ? 'Cambiar archivo' : 'Seleccionar video'}
            </button>
            <span className="file-meta">
              {selectedVideo
                ? `${selectedVideo.name} · ${(selectedVideo.size / (1024 * 1024)).toFixed(1)} MB`
                : 'MP4, M4V, MOV, AVI, MKV o WebM · máx. 1 GB'}
            </span>
          </div>
        )}

        <label className="field field--title">
          <span>Título</span>
          <input
            type="text"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="Final ATP · Set 1"
          />
        </label>

        <button
          className="analyze-button"
          type="submit"
          disabled={isSubmitting || (inputMode === 'url' ? sourceUrl.trim().length === 0 : !selectedVideo)}
        >
          {isSubmitting ? <RefreshCw size={17} className="animate-spin" /> : <Video size={17} />}
          {isSubmitting ? 'Analizando' : 'Analizar'}
        </button>
      </form>

      {isSubmitting ? (
        <div className="processing-status" role="status" aria-live="polite">
          <span>Fotogramas procesados</span>
          <strong>
            {progress.processedFrames.toLocaleString('es-ES')}
            {progress.totalFrames !== null ? ` / ${progress.totalFrames.toLocaleString('es-ES')}` : ''}
          </strong>
        </div>
      ) : null}

      {visibleError ? (
        <div className="notice notice--error" role="alert">
          <AlertTriangle size={18} />
          <div>
            <strong>No se pudo completar el análisis</strong>
            <span>{visibleError}</span>
          </div>
        </div>
      ) : null}

      {isCompleted ? (
        <div className="notice notice--success" role="status">
          <CheckCircle2 size={18} />
          <strong>Procesamiento completado</strong>
        </div>
      ) : null}
    </section>
  )
}
