import { useCallback, useRef, useState } from 'react'

import {
  ApiError,
  type MatchProgressResponse,
  type MatchTelemetry,
  getLibraryMatch,
  getMatchProgress,
  processMatch,
  uploadMatchVideo,
} from '../services/api'

export interface AnalysisRequest {
  /** Either a video URL or an uploaded file. */
  sourceUrl?: string
  file?: File
  title?: string
}

export interface AnalysisResult {
  matchId: string
  title?: string
  telemetry: MatchTelemetry
}

const progressPollMilliseconds = 500
const noProgress: MatchProgressResponse = { processedFrames: 0, totalFrames: null }

/** Runs one analysis at a time and exposes its progress, result and error. */
export function useMatchAnalysis() {
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [progress, setProgress] = useState<MatchProgressResponse>(noProgress)
  const requestSequenceRef = useRef(0)

  const start = useCallback(async ({ sourceUrl, file, title }: AnalysisRequest) => {
    if (!file && !sourceUrl) return
    const matchId = window.crypto.randomUUID()
    const requestSequence = ++requestSequenceRef.current
    const isCurrent = () => requestSequenceRef.current === requestSequence

    setIsSubmitting(true)
    setProgress(noProgress)
    setErrorMessage(null)
    setAnalysis(null)

    let finished = false
    const polling = (async () => {
      while (!finished) {
        try {
          const current = await getMatchProgress(matchId)
          if (!finished && isCurrent()) setProgress(current)
        } catch {
          // Progress may not be available until the video reaches the vision service.
        }
        if (!finished) await new Promise((resolve) => window.setTimeout(resolve, progressPollMilliseconds))
      }
    })()

    try {
      const response = file
        ? await uploadMatchVideo(file, title, matchId)
        : await processMatch({ sourceUrl: sourceUrl!, title, matchId })
      if (isCurrent()) {
        setAnalysis({
          matchId: response.matchId,
          title: title || file?.name,
          telemetry: response.telemetry,
        })
      }
    } catch (error) {
      if (isCurrent()) {
        setErrorMessage(
          error instanceof ApiError ? error.message : 'Ocurrió un error inesperado durante el análisis.',
        )
      }
    } finally {
      finished = true
      await polling
      if (isCurrent()) setIsSubmitting(false)
    }
  }, [])

  /** Loads an analysis stored in the library; throws an ApiError if it cannot be read. */
  const openSaved = useCallback(async (matchId: string) => {
    const saved = await getLibraryMatch(matchId)
    // A newer open or analysis must not be overwritten by a slow response.
    ++requestSequenceRef.current
    setErrorMessage(null)
    setProgress(noProgress)
    setIsSubmitting(false)
    setAnalysis({ matchId: saved.matchId, title: saved.title, telemetry: saved.telemetry })
  }, [])

  return { analysis, errorMessage, isSubmitting, progress, start, openSaved }
}
