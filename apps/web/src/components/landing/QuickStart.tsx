import { useRef, useState } from 'react'
import { AlertTriangle, FileVideo, LoaderCircle, Play, UploadCloud } from 'lucide-react'

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
      <div className="landing-section__heading">
        <span className="eyebrow">ACCESO RÁPIDO</span>
        <h2 id="landing-quick-title">Empieza con tu vídeo o con un partido de prueba</h2>
      </div>

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
          <span className="landing-dropzone__icon">
            <UploadCloud size={28} aria-hidden="true" />
          </span>
          <strong>Arrastra tu vídeo aquí</strong>
          <span>MP4, M4V, MOV, AVI, MKV o WebM · máx. 1 GB</span>
          <button type="button" className="landing-cta landing-cta--small" onClick={() => fileInputRef.current?.click()}>
            Seleccionar archivo
          </button>
        </div>

        <ul className="landing-demos" aria-label="Partidos de prueba">
          {demoMatches.map((demo) => {
            const isLoading = loadingDemoId === demo.id
            return (
              <li key={demo.id}>
                <button
                  type="button"
                  className="landing-demo"
                  disabled={loadingDemoId !== null}
                  onClick={() => void loadDemo(demo)}
                >
                  <span className="landing-demo__icon">
                    <FileVideo size={22} aria-hidden="true" />
                  </span>
                  <span className="landing-demo__text">
                    <strong>{demo.title}</strong>
                    <span>{demo.description}</span>
                  </span>
                  <span className="landing-demo__action">
                    {isLoading ? (
                      <LoaderCircle size={18} className="animate-spin" aria-label="Cargando" />
                    ) : (
                      <Play size={18} aria-hidden="true" />
                    )}
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      </div>

      {errorMessage ? (
        <div className="notice notice--error landing-quick__error" role="alert">
          <AlertTriangle size={18} />
          <span>{errorMessage}</span>
        </div>
      ) : null}
    </section>
  )
}
