"""NetPoint Coach: conversational tactical analysis over a stored match.

Two layers keep the model's context small and precise:
- `analysis` turns the raw telemetry into a tactical model (points, shots, landings, outcomes,
  player profiles). It is rendered by `digest` into a compact text that lives in the cached
  system prompt: the *event layer* is always in context.
- `tools` exposes the *frame layer* (positions and ball flight at frame resolution) on demand,
  so the 1 MB of per-frame detections never enters the prompt.
"""
