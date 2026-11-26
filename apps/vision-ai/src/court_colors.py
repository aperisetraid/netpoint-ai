"""Colours of the court surface and of the area around it, measured on the analysed video.

The web paints its 2D map and 3D replay with them (blue court and green surround at the US Open, clay at
Monte Carlo). They come from the court corners the pipeline already stores: a few frames are read, points
laid out in court metres are projected into each one, and the median colour inside the lines and in a band
outside them wins. Lines, the net and the players are kept out of the samples.

Measured once per match and cached next to it (`court_colors.json`), so analyses stored before this
existed get their colours on first open without being processed again.
"""

from __future__ import annotations

import json
from pathlib import Path

import cv2
import numpy as np

COLORS_FILE = "court_colors.json"
COURT_LENGTH = 23.77
COURT_WIDTH = 10.97
NET_X = COURT_LENGTH / 2
SINGLES_INSET = 1.37
SERVICE_DISTANCE = 6.4
SAMPLE_FRAMES = 8
SAMPLE_STEP_METERS = 0.5
# Keeps samples off the painted lines (5 cm wide, blurred over a few pixels) and the net.
LINE_CLEARANCE_METERS = 0.3
NET_CLEARANCE_METERS = 1.2
# Band around the court: clear of the lines, short of the stands and the sponsor boards.
APRON_SIDE_METERS = (0.6, 2.4)
APRON_BACK_METERS = (0.9, 3.5)
PLAYER_MARGIN_PIXELS = 12
MIN_SAMPLES = 60


def _surface_points() -> np.ndarray:
    xs = np.arange(SAMPLE_STEP_METERS, COURT_LENGTH, SAMPLE_STEP_METERS)
    ys = np.arange(SAMPLE_STEP_METERS / 2, COURT_WIDTH, SAMPLE_STEP_METERS)
    grid = np.array([(x, y) for x in xs for y in ys])
    lines_y = [0.0, SINGLES_INSET, COURT_WIDTH - SINGLES_INSET, COURT_WIDTH]
    lines_x = [0.0, NET_X - SERVICE_DISTANCE, NET_X + SERVICE_DISTANCE, COURT_LENGTH]
    near_line = np.zeros(len(grid), dtype=bool)
    for line in lines_y:
        near_line |= np.abs(grid[:, 1] - line) < LINE_CLEARANCE_METERS
    for line in lines_x:
        near_line |= np.abs(grid[:, 0] - line) < LINE_CLEARANCE_METERS
    in_service_boxes = np.abs(grid[:, 0] - NET_X) < SERVICE_DISTANCE
    near_line |= in_service_boxes & (np.abs(grid[:, 1] - COURT_WIDTH / 2) < LINE_CLEARANCE_METERS)
    near_line |= np.abs(grid[:, 0] - NET_X) < NET_CLEARANCE_METERS
    return grid[~near_line]


def _apron_points() -> np.ndarray:
    step = SAMPLE_STEP_METERS
    points = []
    side_near, side_far = APRON_SIDE_METERS
    back_near, back_far = APRON_BACK_METERS
    for x in np.arange(-back_near, COURT_LENGTH + back_near, step):
        if abs(x - NET_X) < NET_CLEARANCE_METERS:
            continue
        for offset in np.arange(side_near, side_far, step):
            points += [(x, -offset), (x, COURT_WIDTH + offset)]
    for y in np.arange(-side_near, COURT_WIDTH + side_near, step):
        for offset in np.arange(back_near, back_far, step):
            points += [(-offset, y), (COURT_LENGTH + offset, y)]
    return np.array(points)


SURFACE_POINTS = _surface_points()
APRON_POINTS = _apron_points()


def court_to_image(corners: list[list[float]]) -> np.ndarray:
    """Homography from court metres (x along, y across) to pixels, for the corner order the pipeline stores."""
    court = np.asarray(
        [[0.0, 0.0], [0.0, COURT_WIDTH], [COURT_LENGTH, COURT_WIDTH], [COURT_LENGTH, 0.0]], dtype=np.float32
    )
    return cv2.getPerspectiveTransform(court, np.asarray(corners, dtype=np.float32))


def sample_colors(image: np.ndarray, homography: np.ndarray, points: np.ndarray, players: list[list[float]]) -> np.ndarray:
    """BGR colours under `points` (court metres), skipping pixels outside the image or on a player."""
    if len(points) == 0:
        return np.empty((0, 3), dtype=np.uint8)
    pixels = cv2.perspectiveTransform(points.reshape(-1, 1, 2).astype(np.float32), homography).reshape(-1, 2)
    pixels = np.rint(pixels).astype(int)
    height, width = image.shape[:2]
    keep = (pixels[:, 0] >= 0) & (pixels[:, 0] < width) & (pixels[:, 1] >= 0) & (pixels[:, 1] < height)
    for left, top, right, bottom in players:
        keep &= ~(
            (pixels[:, 0] >= left - PLAYER_MARGIN_PIXELS)
            & (pixels[:, 0] <= right + PLAYER_MARGIN_PIXELS)
            & (pixels[:, 1] >= top - PLAYER_MARGIN_PIXELS)
            & (pixels[:, 1] <= bottom + PLAYER_MARGIN_PIXELS)
        )
    pixels = pixels[keep]
    return image[pixels[:, 1], pixels[:, 0]]


def to_hex(bgr: np.ndarray) -> str:
    blue, green, red = (int(round(float(value))) for value in bgr)
    return f"#{red:02X}{green:02X}{blue:02X}"


def measure_court_colors(video_path: Path, frames: list[dict]) -> dict | None:
    """Median surface and surround colours over a few calibrated frames; None when there is too little to go on."""
    calibrated = [frame for frame in frames if frame.get("court_corners")]
    if not calibrated:
        return None
    picks = [calibrated[int(index)] for index in np.linspace(0, len(calibrated) - 1, min(SAMPLE_FRAMES, len(calibrated)))]
    capture = cv2.VideoCapture(str(video_path))
    if not capture.isOpened():
        return None
    surface, apron = [], []
    try:
        for frame in picks:
            capture.set(cv2.CAP_PROP_POS_FRAMES, int(frame["frame_index"]))
            ok, image = capture.read()
            if not ok:
                continue
            homography = court_to_image(frame["court_corners"])
            players = [d["bbox"] for d in frame.get("detections", []) if d.get("class") == "player" and d.get("bbox")]
            surface.append(sample_colors(image, homography, SURFACE_POINTS, players))
            apron.append(sample_colors(image, homography, APRON_POINTS, players))
    finally:
        capture.release()
    surface_samples = np.concatenate(surface) if surface else np.empty((0, 3))
    apron_samples = np.concatenate(apron) if apron else np.empty((0, 3))
    if len(surface_samples) < MIN_SAMPLES:
        return None
    colors = {"surface": to_hex(np.median(surface_samples, axis=0))}
    # Too little of the surround in shot (tight framing): the web falls back to a darker surface.
    if len(apron_samples) >= MIN_SAMPLES:
        colors["surround"] = to_hex(np.median(apron_samples, axis=0))
    return colors


def court_colors(folder: Path, telemetry: dict, video_path: Path | None) -> dict | None:
    """Cached colours of a match folder, measured on first use; None when the video cannot tell."""
    cache = folder / COLORS_FILE
    try:
        return json.loads(cache.read_text(encoding="utf-8")) or None
    except (OSError, ValueError):
        pass
    if video_path is None:
        return None
    colors = measure_court_colors(video_path, telemetry.get("frames", []))
    try:
        # An empty object remembers that the video could not tell, so it is not read again.
        cache.write_text(json.dumps(colors or {}), encoding="utf-8")
    except OSError:
        pass  # A read-only library still serves the colours, it just measures them again next time.
    return colors


def with_court_colors(folder: Path, telemetry: dict, video_path: Path | None) -> dict:
    """The telemetry with `court.colors` added when the video gives them."""
    colors = court_colors(folder, telemetry, video_path)
    if colors and isinstance(telemetry.get("court"), dict):
        telemetry["court"]["colors"] = colors
    return telemetry
