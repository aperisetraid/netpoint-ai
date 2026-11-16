import { useRef, useState } from 'react'
import { AlertTriangle, CheckCircle2, Link2, RefreshCw, Upload, Video } from 'lucide-react'

import type { AnalysisRequest } from '../../hooks/useMatchAnalysis'
import { validateVideoFile, videoAcceptAttribute } from '../../lib/videoFile'

interface IngestPanelProps {
  isSubmitting: boolean
  errorMessage: string | null
  isCompleted: boolean
  onSubmit: (request: AnalysisRequest) => void
}

/** Source form: a video URL (YouTube or direct) or an uploaded file, plus the final result notice. */
export function IngestPanel({ isSubmitting, errorMessage, isCompleted, onSubmit }: IngestPanelProps) {
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
    const validationError = validateVideoFile(file)
    if (validationError) {
      setFileError(validationError)
      return
    }
    setSelectedVideo(file)
    setFileError(null)
  }

  return (
    <section className="ingest-panel" aria-labelledby="ingest-title">
      <div className="ingest-panel__heading">
        <h2 id="ingest-title">Nuevo análisis</h2>
        <div className="segmented" role="group" aria-label="Origen del vídeo">
          <button type="button" aria-pressed={inputMode === 'url'} onClick={() => setInputMode('url')}>
            <Link2 size={14} aria-hidden="true" /> Enlace
          </button>
          <button type="button" aria-pressed={inputMode === 'file'} onClick={() => setInputMode('file')}>
            <Upload size={14} aria-hidden="true" /> Archivo
          </button>
        </div>
      </div>

      <form className="ingest-form" onSubmit={handleSubmit} noValidate>
        {inputMode === 'url' ? (
          <label className="field">
            <span>Enlace al vídeo (YouTube o directo)</span>
            <input
              className="field__control"
              type="url"
              required
              value={sourceUrl}
              onChange={(event) => setSourceUrl(event.target.value)}
              placeholder="https://…"
            />
          </label>
        ) : (
          <div className="file-field">
            <input
              ref={fileInputRef}
              className="sr-only"
              type="file"
              accept={videoAcceptAttribute}
              aria-label="Seleccionar archivo de vídeo"
              onChange={handleFileChange}
            />
            <span className="field-label">Archivo de vídeo</span>
            <button className="file-picker" type="button" onClick={() => fileInputRef.current?.click()}>
              <Upload size={16} aria-hidden="true" />
              {selectedVideo ? 'Cambiar archivo' : 'Elegir vídeo'}
            </button>
            <span className="file-meta">
              {selectedVideo
                ? `${selectedVideo.name} · ${(selectedVideo.size / (1024 * 1024)).toFixed(1)} MB`
                : 'MP4, M4V, MOV, AVI, MKV o WebM, hasta 1 GB'}
            </span>
          </div>
        )}

        <label className="field">
          <span>Título (opcional)</span>
          <input
            className="field__control"
            type="text"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="Final del torneo, set 1"
          />
        </label>

        <button
          className="btn btn--primary"
          type="submit"
          disabled={isSubmitting || (inputMode === 'url' ? sourceUrl.trim().length === 0 : !selectedVideo)}
        >
          {isSubmitting ? <RefreshCw size={16} className="animate-spin" aria-hidden="true" /> : <Video size={16} aria-hidden="true" />}
          {isSubmitting ? 'Analizando' : 'Analizar'}
        </button>
      </form>

      {visibleError ? (
        <div className="notice notice--error" role="alert">
          <AlertTriangle size={16} aria-hidden="true" />
          <div>
            <strong>No se pudo completar el análisis</strong>
            <span>{visibleError}</span>
          </div>
        </div>
      ) : null}

      {isCompleted ? (
        <div className="notice notice--success" role="status">
          <CheckCircle2 size={16} aria-hidden="true" />
          <strong>Análisis completado</strong>
        </div>
      ) : null}
    </section>
  )
}
