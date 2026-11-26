import { useRef, useState } from 'react'
import { AlertTriangle, LoaderCircle, Play, UploadCloud } from 'lucide-react'

import type { AnalysisRequest } from '../../hooks/useMatchAnalysis'
import { validateVideoFile, videoAcceptAttribute } from '../../lib/videoFile'
import { type DemoMatch, demoMatches } from './demoMatches'

interface QuickStartProps {
  onSelect: (request: AnalysisRequest) => void
}

/** Drag-and-drop zone plus the bundled demo clips, so analysis can start straight from the landing page. */
export function QuickStart({ onSelect }: QuickStartProps) {
  const [isDragging, setIsDragging] = useState(false)
  const [loadingDemoId, setLoadingDemoId] = useState<string | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  function submitFile(file: File | undefined) {
    if (!file) return
    const validationError = validateVideoFile(file)
    setErrorMessage(validationError)
    if (!validationError) onSelect({ file, title: file.name.replace(/\.[^.]+$/, '') })
  }

  async function loadDemo(demo: DemoMatch) {
    if (loadingDemoId) return
    setLoadingDemoId(demo.id)
    setErrorMessage(null)
    try {
      const response = await fetch(demo.url)
      if (!response.ok) throw new Error(String(response.status))
      const blob = await response.blob()
      onSelect({ file: new File([blob], demo.fileName, { type: blob.type || 'video/mp4' }), title: demo.title })
    } catch {
      setErrorMessage(`No se pudo cargar el vídeo de ${demo.title}.`)
    } finally {
      setLoadingDemoId(null)
    }
  }

  function handleDrop(event: React.DragEvent<HTMLDivElement>) {
    event.preventDefault()
    setIsDragging(false)
    submitFile(event.dataTransfer.files[0])
  }

  return (
    <section className="landing-section" id="landing-quick-start" aria-labelledby="landing-quick-title">
      <h2 id="landing-quick-title" className="display landing-section__title">Empieza aquí</h2>

      <div className="landing-quick">
        <div
          className={`landing-dropzone${isDragging ? ' is-dragging' : ''}`}
          onDragOver={(event) => {
            event.preventDefault()
            setIsDragging(true)
          }}
          onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setIsDragging(false)
          }}
          onDrop={handleDrop}
        >
          <input
            ref={fileInputRef}
            className="sr-only"
            type="file"
            accept={videoAcceptAttribute}
            aria-label="Seleccionar archivo de vídeo"
            onChange={(event) => {
              submitFile(event.currentTarget.files?.[0])
              event.currentTarget.value = ''
            }}
          />
          <UploadCloud size={32} strokeWidth={1.4} aria-hidden="true" />
          <strong className="heading">Arrastra tu vídeo aquí</strong>
          <span>MP4, M4V, MOV, AVI, MKV o WebM, hasta 1 GB</span>
          <button type="button" className="btn btn--primary" onClick={() => fileInputRef.current?.click()}>
            Elegir un archivo
          </button>
        </div>

        {demoMatches.length ? (
        <div className="landing-demos">
          <h3 className="heading">O prueba con un partido de ejemplo</h3>
          <ul aria-label="Partidos de ejemplo">
            {demoMatches.map((demo) => {
              const isLoading = loadingDemoId === demo.id
              return (
                <li key={demo.id}>
                  <button
                    type="button"
                    className="landing-demo"
                    disabled={loadingDemoId !== null}
                    aria-busy={isLoading}
                    onClick={() => void loadDemo(demo)}
                  >
                    <span className="landing-demo__text">
                      <strong>{demo.title}</strong>
                      <span>{demo.description}</span>
                    </span>
                    <span className="landing-demo__action" aria-hidden="true">
                      {isLoading ? <LoaderCircle size={18} className="animate-spin" /> : <Play size={16} fill="currentColor" />}
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        </div>
        ) : null}
      </div>

      {errorMessage ? (
        <div className="notice notice--error landing-quick__error" role="alert">
          <AlertTriangle size={16} aria-hidden="true" />
          <span>{errorMessage}</span>
        </div>
      ) : null}
    </section>
  )
}
