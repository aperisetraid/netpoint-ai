import { useEffect, useMemo, useRef, type RefObject } from 'react'

import { findIndexAtOrBefore } from '../../lib/frameLookup.ts'
import type { MatchTelemetry } from '../../services/api'
import { bounceMarkSeconds, drawBounce } from './overlay/bounceRipples.ts'
import { containRect, courtToImageHomography, type Homography } from './overlay/geometry.ts'
import { drawHitLabel, hitAnchor, hitLabelSeconds } from './overlay/hitLabels.ts'
import { buildBallTrack, drawTrail, trailAt } from './overlay/trail.ts'

interface MatchCanvasOverlayProps {
  videoRef: RefObject<HTMLVideoElement | null>
  telemetry: MatchTelemetry
}

interface VideoClock {
  mediaTime: number
  displayedAt: number
}

/** How long a presented-frame timestamp is trusted to extrapolate the playback position. */
const maximumClockAgeMilliseconds = 250

/**
 * Canvas drawn over the video with the ball trail, bounce ripples and hit labels.
 * It repaints from its own animation loop, reading the playback position straight from the
 * video element, so React never re-renders while the video plays.
 */
export function MatchCanvasOverlay({ videoRef, telemetry }: MatchCanvasOverlayProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  const scene = useMemo(() => {
    const homographies = new Map<string, Homography | null>()
    return {
      track: buildBallTrack(telemetry.frames),
      bounces: [...telemetry.events.bounces].sort((a, b) => a.timestamp_seconds - b.timestamp_seconds),
      hits: [...telemetry.events.hits].sort((a, b) => a.timestamp_seconds - b.timestamp_seconds),
      // Calibrations repeat across frames, so each distinct set of corners is solved only once.
      courtToImage(frameIndex: number): Homography | null {
        for (let index = frameIndex; index >= 0; index--) {
          const corners = telemetry.frames[index].court_corners
          if (!corners) continue
          const key = corners.flat().join(',')
          if (!homographies.has(key)) homographies.set(key, courtToImageHomography(corners))
          return homographies.get(key) ?? null
        }
        return null
      },
    }
  }, [telemetry])

  useEffect(() => {
    const video = videoRef.current
    const canvas = canvasRef.current
    const context = canvas?.getContext('2d')
    if (!video || !canvas || !context) return

    const { frames, video: source } = telemetry
    const bounceTimes = scene.bounces.map((bounce) => bounce.timestamp_seconds)
    const hitTimes = scene.hits.map((hit) => hit.timestamp_seconds)
    let animationRequest = 0
    let videoFrameRequest = 0
    let clock: VideoClock | null = null

    function playbackTime(): number {
      if (video!.paused || video!.seeking || !clock) return video!.currentTime
      const elapsed = performance.now() - clock.displayedAt
      if (elapsed < 0 || elapsed > maximumClockAgeMilliseconds) return video!.currentTime
      return clock.mediaTime + (elapsed / 1000) * video!.playbackRate
    }

    function draw() {
      const pixelRatio = window.devicePixelRatio || 1
      const width = canvas!.clientWidth
      const height = canvas!.clientHeight
      if (canvas!.width !== Math.round(width * pixelRatio) || canvas!.height !== Math.round(height * pixelRatio)) {
        canvas!.width = Math.round(width * pixelRatio)
        canvas!.height = Math.round(height * pixelRatio)
      }
      context!.setTransform(1, 0, 0, 1, 0, 0)
      context!.clearRect(0, 0, canvas!.width, canvas!.height)

      const imageWidth = source.width || video!.videoWidth
      const imageHeight = source.height || video!.videoHeight
      const rect = containRect(width, height, imageWidth, imageHeight)
      if (!rect.scale) return
      // From here on everything is drawn in the pixel coordinates of the analysed video.
      context!.setTransform(
        rect.scale * pixelRatio, 0, 0, rect.scale * pixelRatio, rect.x * pixelRatio, rect.y * pixelRatio,
      )
      const unit = 1 / rect.scale
      const time = playbackTime()
      const frameIndex = findIndexAtOrBefore(scene.track.times, time)

      const courtToImage = frameIndex >= 0 ? scene.courtToImage(frameIndex) : null
      if (courtToImage) {
        for (let index = findIndexAtOrBefore(bounceTimes, time); index >= 0; index--) {
          const age = time - bounceTimes[index]
          if (age > bounceMarkSeconds) break
          drawBounce(context!, courtToImage, scene.bounces[index], age, unit)
        }
      }

      drawTrail(context!, trailAt(scene.track, time, imageWidth), unit)

      for (let index = findIndexAtOrBefore(hitTimes, time); index >= 0; index--) {
        const age = time - hitTimes[index]
        if (age > hitLabelSeconds) break
        const anchor = hitAnchor(frames[frameIndex], scene.hits[index])
        if (anchor) drawHitLabel(context!, scene.hits[index], age, anchor, unit, imageWidth)
      }
    }

    function tick() {
      draw()
      animationRequest = video!.paused || video!.ended ? 0 : requestAnimationFrame(tick)
    }
    function start() {
      if (!animationRequest) animationRequest = requestAnimationFrame(tick)
    }
    // Paused playback has nothing to animate, so a single repaint is enough.
    function repaint() {
      clock = null
      if (!animationRequest) draw()
    }
    function onVideoFrame(_now: number, metadata: VideoFrameCallbackMetadata) {
      clock = { mediaTime: metadata.mediaTime, displayedAt: metadata.expectedDisplayTime }
      videoFrameRequest = video!.requestVideoFrameCallback(onVideoFrame)
    }

    const supportsVideoFrames = 'requestVideoFrameCallback' in video
    if (supportsVideoFrames) videoFrameRequest = video.requestVideoFrameCallback(onVideoFrame)
    const resizeObserver = new ResizeObserver(repaint)
    resizeObserver.observe(canvas)
    video.addEventListener('play', start)
    for (const event of ['pause', 'seeked', 'loadeddata', 'ratechange'] as const) {
      video.addEventListener(event, repaint)
    }
    if (video.paused) draw()
    else start()

    return () => {
      cancelAnimationFrame(animationRequest)
      if (supportsVideoFrames) video.cancelVideoFrameCallback(videoFrameRequest)
      resizeObserver.disconnect()
      video.removeEventListener('play', start)
      for (const event of ['pause', 'seeked', 'loadeddata', 'ratechange'] as const) {
        video.removeEventListener(event, repaint)
      }
    }
  }, [videoRef, telemetry, scene])

  return <canvas ref={canvasRef} className="video-player__overlay" aria-hidden="true" />
}
