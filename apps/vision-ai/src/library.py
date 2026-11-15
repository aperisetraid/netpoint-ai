"""File-backed match library: lists and loads the analyses already stored under temp/matches.

Every analysis lives in its own folder named after a UUID and holds the video, the
`telemetry_output.json` written by the pipeline and, for newer runs, a small `meta.json`.
No database: folders are the source of truth and summaries are cached by file mtime.
"""

import json
import logging
import threading
from datetime import datetime, timezone
from pathlib import Path
from uuid import UUID

import cv2

logger = logging.getLogger(__name__)

TELEMETRY_FILE = "telemetry_output.json"
METADATA_FILE = "meta.json"
THUMBNAIL_FILE = "thumbnail.jpg"
VIDEO_EXTENSIONS = {".mp4", ".m4v", ".mov", ".avi", ".mkv", ".webm"}
THUMBNAIL_POSITION = 0.25
THUMBNAIL_WIDTH = 640

# None marks folders that cannot be listed (legacy v1 telemetry or corrupt files), so they are parsed once.
_summary_cache: dict[Path, tuple[tuple[int, int], dict | None]] = {}
_cache_lock = threading.Lock()


def write_match_metadata(output_dir: Path, title: str | None, source: str) -> None:
    """Stores the data the telemetry does not carry. Only for folders the pipeline created."""
    if not output_dir.is_dir():
        return
    metadata = {
        "title": (title or "").strip() or None,
        "source": source,
        "createdAt": datetime.now(timezone.utc).isoformat(),
    }
    (output_dir / METADATA_FILE).write_text(json.dumps(metadata), encoding="utf-8")


def resolve_match_dir(root: Path, match_id: str) -> Path | None:
    """Maps a library id to its folder, refusing anything that is not a plain UUID."""
    try:
        canonical = str(UUID(match_id))
    except ValueError:
        return None
    folder = root / canonical
    return folder if (folder / TELEMETRY_FILE).is_file() else None


def find_video(folder: Path) -> Path | None:
    candidates = sorted(
        path for path in folder.iterdir()
        if path.is_file() and path.suffix.lower() in VIDEO_EXTENSIONS
    )
    return candidates[0] if candidates else None


def _read_metadata(folder: Path) -> dict:
    try:
        metadata = json.loads((folder / METADATA_FILE).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return metadata if isinstance(metadata, dict) else {}


def _summarize(folder: Path) -> dict:
    telemetry_path = folder / TELEMETRY_FILE
    telemetry = json.loads(telemetry_path.read_text(encoding="utf-8"))
    if not isinstance(telemetry, dict) or "video" not in telemetry or "frames" not in telemetry:
        raise ValueError("formato de telemetria no compatible (anterior a la version 2)")
    video = telemetry["video"]
    events = telemetry.get("events", {})
    hits = events.get("hits", [])
    speeds = [hit["speed_kmh"] for hit in hits if hit.get("speed_kmh") is not None]
    metadata = _read_metadata(folder)
    video_file = find_video(folder)
    fps = video.get("fps")
    frame_count = int(video.get("frame_count") or len(telemetry["frames"]))
    created_at = metadata.get("createdAt") or datetime.fromtimestamp(
        telemetry_path.stat().st_mtime, timezone.utc
    ).isoformat()

    return {
        "id": folder.name,
        "title": metadata.get("title") or (video_file.stem if video_file else folder.name[:8]),
        "createdAt": created_at,
        "source": metadata.get("source"),
        "videoFilename": video_file.name if video_file else None,
        "hasVideo": video_file is not None,
        "fps": fps,
        "width": video.get("width"),
        "height": video.get("height"),
        "frameCount": frame_count,
        "durationSeconds": round(frame_count / fps, 2) if fps else None,
        "calibrated": bool(telemetry.get("court", {}).get("calibrated")),
        "hitCount": len(hits),
        "bounceCount": len(events.get("bounces", [])),
        "maxSpeedKmh": round(max(speeds), 1) if speeds else None,
    }


def _cache_key(folder: Path) -> tuple[int, int]:
    metadata_path = folder / METADATA_FILE
    metadata_mtime = metadata_path.stat().st_mtime_ns if metadata_path.is_file() else 0
    return (folder.joinpath(TELEMETRY_FILE).stat().st_mtime_ns, metadata_mtime)


def summarize_match(folder: Path) -> dict | None:
    """Summary of one folder, or None when its telemetry is unreadable or from an older format."""
    try:
        key = _cache_key(folder)
    except OSError:
        return None
    with _cache_lock:
        cached = _summary_cache.get(folder)
    if cached and cached[0] == key:
        return cached[1]

    try:
        summary = _summarize(folder)
    except (OSError, ValueError, KeyError, TypeError) as error:
        logger.warning("Match %s is not listed in the library: %s", folder.name, error)
        summary = None
    with _cache_lock:
        _summary_cache[folder] = (key, summary)
    return summary


def list_matches(root: Path) -> list[dict]:
    """All stored analyses, newest first."""
    if not root.is_dir():
        return []
    summaries = []
    for folder in root.iterdir():
        if not folder.is_dir() or resolve_match_dir(root, folder.name) is None:
            continue
        summary = summarize_match(folder)
        if summary is not None:
            summaries.append(summary)
    return sorted(summaries, key=lambda summary: summary["createdAt"], reverse=True)


def read_telemetry(folder: Path) -> dict:
    return json.loads((folder / TELEMETRY_FILE).read_text(encoding="utf-8"))


def ensure_thumbnail(folder: Path) -> Path | None:
    """JPEG still from the video, generated once and kept next to the analysis."""
    thumbnail = folder / THUMBNAIL_FILE
    if thumbnail.is_file():
        return thumbnail
    video = find_video(folder)
    if video is None:
        return None

    capture = cv2.VideoCapture(str(video))
    try:
        if not capture.isOpened():
            return None
        total = int(capture.get(cv2.CAP_PROP_FRAME_COUNT))
        if total > 0:
            capture.set(cv2.CAP_PROP_POS_FRAMES, int(total * THUMBNAIL_POSITION))
        success, frame = capture.read()
        if not success:
            return None
    finally:
        capture.release()

    height, width = frame.shape[:2]
    if width > THUMBNAIL_WIDTH:
        frame = cv2.resize(frame, (THUMBNAIL_WIDTH, round(height * THUMBNAIL_WIDTH / width)))
    encoded, image = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 82])
    if not encoded:
        return None
    thumbnail.write_bytes(image.tobytes())
    return thumbnail
