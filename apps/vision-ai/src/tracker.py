import bisect
import functools
import itertools
from collections import deque
import importlib.util
import math
import os
from collections.abc import Callable
from pathlib import Path

import cv2
import numpy as np
from ultralytics import YOLO

from ball_tracking import track_ball
from court_detector import CourtDetector
from events import build_events
from stage_timers import stage
from homography import (
    COURT_LENGTH_METERS,
    COURT_WIDTH_METERS,
    get_homography_matrix,
    transform_point,
)


CALIBRATION_WINDOW_FRAMES = 30
CALIBRATION_RETRY_INTERVAL = 5
COURT_MAX_CORNER_DISPLACEMENT_RATIO = 0.025
COURT_CALIBRATION_CONFIRMATIONS = 3
COURT_RECALIBRATION_CONFIRMATIONS = 2
PLAYER_BASELINE_MARGIN_METERS = 6.5
PLAYER_SIDELINE_MARGIN_METERS = 3.0
PLAYER_OFF_COURT_MIN_CONFIDENCE = 0.25
PLAYER_DEEP_BASELINE_DISTANCE_METERS = 4.0
PLAYER_DEEP_BASELINE_MIN_CONFIDENCE = 0.5
PLAYER_SIDELINE_MIN_CONFIDENCE = 0.4
PLAYER_SIDELINE_BASELINE_ZONE_METERS = 2.0
PLAYER_MIN_CONFIDENCE = 0.2
PLAYER_SIDELINE_EDGE_MARGIN_METERS = 0.5
PLAYER_SIDELINE_EDGE_MIN_CONFIDENCE = 0.3
MAX_PLAYER_CARRY_FORWARD_FRAMES = 3
# A ball over a blue court often renders as a pale, desaturated blob rather than yellow-green.
PALE_BALL_HSV_LOWER = (92, 45, 205)
PALE_BALL_HSV_UPPER = (125, 120, 255)
PALE_BALL_SCORE_PENALTY = 0.2
# On clay the blurred ball blends to an orange hue, so it is only separable by being brighter than the court.
BRIGHT_BALL_TOPHAT_KERNEL_SIZE = 9
BRIGHT_BALL_MIN_CONTRAST = 45
BRIGHT_BALL_MIN_VALUE = 200
BRIGHT_BALL_SCORE_PENALTY = 0.2
BRIGHT_BALL_MAX_STATIC_FRACTION = 0.8
BRIGHT_BALL_CONTINUITY_PIXELS = 20
# A fast ball is a faint streak; it is found as a spot that got brighter since the previous frame.
MOVING_BALL_MIN_BRIGHTENING = 20
MOVING_BALL_MIN_CONTRAST = 15
MOVING_BALL_MIN_PIXELS = 4
MOVING_BALL_SCORE_PENALTY = 0.4
COURT_BALL_INFERENCE_SIZE = 960
# Experimental speed-ups, off by default. Measured against the reference telemetry with
# benchmark.py, each of them moved discrete events (bounces / hits) out of tolerance:
#   NETPOINT_PLAYER_STRIDE=2   players every 2 frames, interpolated in between
#   NETPOINT_PLAYER_ONLY=1     full-frame pass without the ball class (its ball detections matter)
#   NETPOINT_FULL_IMGSZ=512    lower full-frame resolution (worse players, false hits)
#   NETPOINT_COURT_STRIDE=2    court-crop ball detector on alternate frames only
PLAYER_DETECTION_STRIDE = 1
COURT_BALL_STRIDE = 1
# Longest gap between two player detections that is bridged by interpolation.
MAX_PLAYER_INTERPOLATION_GAP_FRAMES = 6
COURT_BALL_MIN_CONFIDENCE = 0.1
MAX_BALL_CANDIDATES_PER_SOURCE = 6
# A panning broadcast camera makes every static white shape (logos, lines) light up in the frame
# difference, and the colour/motion detectors then take them for a moving ball. The previous frame
# is re-aligned on the current one before differencing when the camera moved enough to matter.
CAMERA_MOTION_ANALYSIS_WIDTH = 640
CAMERA_SHIFT_MIN_PIXELS = 1.0
CAMERA_SHIFT_MIN_RESPONSE = 0.3
# The ball is transient: a fraction of a second earlier the same scene point (after following the
# camera) looked different. A logo or a line still looks the same, and so does a broadcast overlay
# such as the scoreboard at the same screen position, so such candidates are dropped.
STATIC_SCENE_LAG_FRAMES = 6
STATIC_SCENE_PATCH_RADIUS = 7
STATIC_SCENE_SEARCH_PIXELS = 3
STATIC_SCENE_MIN_CORRELATION = 0.85
STATIC_SCENE_MIN_TEXTURE = 8.0
# Line judges and ball kids move like a ball to the motion detector; their boxes are excluded.
OTHER_PERSON_BOX_MARGIN = 4.0
# Broadcast graphics stay put on screen while the camera pans. In frames where the camera moved,
# a pixel votes "overlay" when the previous frame matches it as it was on screen but not once
# aligned with the camera; scenery does the opposite and a line sliding along itself does neither.
OVERLAY_CAMERA_MIN_PIXELS = 2.0
OVERLAY_VOTE_MARGIN = 20.0
OVERLAY_MIN_MOVING_FRAMES = 5
OVERLAY_MIN_VOTE_RATIO = 0.4
OVERLAY_DILATION_PIXELS = 6


def ball_candidate_near_player(
    ball_bbox: list[float],
    player_bboxes: list[list[float]],
) -> bool:
    for player_bbox in player_bboxes:
        if (
            max(ball_bbox[0], player_bbox[0]) < min(ball_bbox[2], player_bbox[2])
            and max(ball_bbox[1], player_bbox[1]) < min(ball_bbox[3], player_bbox[3])
        ):
            return True
    return False


def color_candidate_near_player(
    ball_bbox: list[float],
    player_bboxes: list[list[float]],
) -> bool:
    center_x = (ball_bbox[0] + ball_bbox[2]) / 2
    center_y = (ball_bbox[1] + ball_bbox[3]) / 2
    for player_bbox in player_bboxes:
        margin_x = max(24.0, (player_bbox[2] - player_bbox[0]) * 0.15)
        margin_y = max(12.0, (player_bbox[3] - player_bbox[1]) * 0.04)
        if (
            player_bbox[0] - margin_x <= center_x <= player_bbox[2] + margin_x
            and player_bbox[1] - margin_y <= center_y <= player_bbox[3] + margin_y
        ):
            return True
    return False


def distance_to_nearest_player(
    point: tuple[float, float],
    player_bboxes: list[list[float]],
) -> float | None:
    if not player_bboxes:
        return None
    distances = []
    for player_bbox in player_bboxes:
        dx = max(player_bbox[0] - point[0], 0.0, point[0] - player_bbox[2])
        dy = max(player_bbox[1] - point[1], 0.0, point[1] - player_bbox[3])
        distances.append(math.hypot(dx, dy))
    return min(distances)


def point_near_court_baseline(
    point: tuple[float, float],
    court_corners: list[tuple[int, int]],
) -> bool:
    corners = np.asarray(court_corners, dtype=np.float32)
    # Corners are TL, TR, BR, BL; under perspective the far baseline can be shorter than a sideline.
    baselines = ((corners[0], corners[1]), (corners[3], corners[2]))
    baseline_midpoints = [(start + end) / 2 for start, end in baselines]
    court_depth = float(np.linalg.norm(baseline_midpoints[0] - baseline_midpoints[1]))
    max_extension = max(12.0, court_depth * 0.35)
    point_array = np.asarray(point, dtype=np.float32)

    for start, end in baselines:
        edge = end - start
        projection = float(np.dot(point_array - start, edge) / np.dot(edge, edge))
        if not 0 <= projection <= 1:
            continue
        closest_point = start + projection * edge
        if np.linalg.norm(point_array - closest_point) <= max_extension:
            return True
    return False


def point_in_ball_tracking_region(
    point: tuple[float, float],
    court_corners: list[tuple[int, int]],
) -> bool:
    court_polygon = np.asarray(court_corners, dtype=np.float32)
    return (
        cv2.pointPolygonTest(court_polygon, point, True) >= 0
        or point_near_court_baseline(point, court_corners)
    )


@functools.lru_cache(maxsize=8)
def _ball_region_mask(shape: tuple[int, int], corners: tuple[tuple[int, int], ...]) -> np.ndarray:
    mask = np.zeros(shape, dtype=np.uint8)
    cv2.fillConvexPoly(mask, np.asarray(corners, dtype=np.int32), 255)
    points = np.asarray(corners, dtype=np.float32)
    baselines = ((points[0], points[1]), (points[3], points[2]))
    midpoints = [(start + end) / 2 for start, end in baselines]
    extension = max(12.0, float(np.linalg.norm(midpoints[0] - midpoints[1])) * 0.35)
    for start, end in baselines:
        direction = (end - start) / max(float(np.linalg.norm(end - start)), 1e-6)
        normal = np.asarray((-direction[1], direction[0]), dtype=np.float32) * extension
        band = np.asarray((start - normal, end - normal, end + normal, start + normal), dtype=np.int32)
        cv2.fillConvexPoly(mask, band, 255)
    mask.setflags(write=False)
    return mask


def ball_region_mask(shape: tuple[int, int], court_corners: list[tuple[int, int]]) -> np.ndarray:
    """Pixels where the ball is searched: the court plus a band around each baseline.

    It matches `point_in_ball_tracking_region`. A ball in the air near the far baseline or behind
    either baseline is drawn outside the court quadrilateral, so the court alone hid it.
    """
    return _ball_region_mask(tuple(shape[:2]), tuple(tuple(int(v) for v in corner) for corner in court_corners))


class ScreenOverlayMask:
    """Pixels covered by graphics drawn on top of the picture (scoreboard, clock, channel logo)."""

    def __init__(self):
        self.votes: np.ndarray | None = None
        self.moving_frames = 0
        self._mask: np.ndarray | None = None
        self._scale = 1.0

    def update(
        self,
        previous_image: np.ndarray | None,
        current_image: np.ndarray,
        shift: tuple[float, float] | None,
        frame_width: int,
    ) -> None:
        """Images are the small grayscale copies from `camera_motion_image`; `shift` in full pixels."""
        if previous_image is None or shift is None:
            return
        if max(abs(shift[0]), abs(shift[1])) < OVERLAY_CAMERA_MIN_PIXELS:
            return
        self._scale = frame_width / current_image.shape[1]
        small_shift = (shift[0] / self._scale, shift[1] / self._scale)
        aligned = align_to_current(previous_image, small_shift)
        on_screen = cv2.absdiff(current_image, previous_image)
        with_camera = cv2.absdiff(current_image, aligned)
        if self.votes is None:
            self.votes = np.zeros(current_image.shape[:2], dtype=np.uint16)
        self.votes += (with_camera - on_screen > OVERLAY_VOTE_MARGIN).astype(np.uint16)
        self.moving_frames += 1
        self._mask = None

    def mask(self) -> np.ndarray | None:
        if self.votes is None or self.moving_frames < OVERLAY_MIN_MOVING_FRAMES:
            return None
        if self._mask is None:
            overlay = (self.votes >= OVERLAY_MIN_VOTE_RATIO * self.moving_frames).astype(np.uint8)
            size = 2 * max(1, round(OVERLAY_DILATION_PIXELS / self._scale)) + 1
            self._mask = cv2.dilate(overlay, np.ones((size, size), dtype=np.uint8))
        return self._mask

    def contains(self, point: tuple[float, float]) -> bool:
        mask = self.mask()
        if mask is None:
            return False
        x, y = int(point[0] / self._scale), int(point[1] / self._scale)
        return 0 <= y < mask.shape[0] and 0 <= x < mask.shape[1] and bool(mask[y, x])


def boxes_overlap(first: list[float], second: list[float]) -> bool:
    return first[0] < second[2] and second[0] < first[2] and first[1] < second[3] and second[1] < first[3]


def inside_any_box(point: tuple[float, float], boxes: list[list[float]], margin: float = 0.0) -> bool:
    return any(
        box[0] - margin <= point[0] <= box[2] + margin and box[1] - margin <= point[1] <= box[3] + margin
        for box in boxes
    )


def point_outside_court_near_baseline(
    point: tuple[float, float],
    court_corners: list[tuple[int, int]],
) -> bool:
    court_polygon = np.asarray(court_corners, dtype=np.float32)
    return (
        cv2.pointPolygonTest(court_polygon, point, True) < 0
        and point_near_court_baseline(point, court_corners)
    )


def mean_corner_displacement(
    first: list[tuple[int, int]],
    second: list[tuple[int, int]],
) -> float:
    first_points = np.asarray(first, dtype=np.float32)
    second_points = np.asarray(second, dtype=np.float32)
    return float(np.linalg.norm(first_points - second_points, axis=1).mean())


def player_within_tracking_region(
    x_meters: float,
    y_meters: float,
    confidence: float,
) -> bool:
    baseline_distance = max(0.0, -x_meters, x_meters - COURT_LENGTH_METERS)
    if baseline_distance > PLAYER_BASELINE_MARGIN_METERS:
        return False
    if not -PLAYER_SIDELINE_MARGIN_METERS <= y_meters <= COURT_WIDTH_METERS + PLAYER_SIDELINE_MARGIN_METERS:
        return False
    minimum_confidence = (
        PLAYER_DEEP_BASELINE_MIN_CONFIDENCE
        if baseline_distance > PLAYER_DEEP_BASELINE_DISTANCE_METERS
        else PLAYER_OFF_COURT_MIN_CONFIDENCE
    )
    if baseline_distance > 0 and confidence < minimum_confidence:
        return False
    if 0 <= y_meters <= COURT_WIDTH_METERS:
        return True
    return (
        confidence >= PLAYER_SIDELINE_MIN_CONFIDENCE
        and (
            x_meters <= PLAYER_SIDELINE_BASELINE_ZONE_METERS
            or x_meters >= COURT_LENGTH_METERS - PLAYER_SIDELINE_BASELINE_ZONE_METERS
        )
    )


def camera_motion_image(frame: np.ndarray) -> np.ndarray:
    """Small grayscale copy used to estimate the camera motion between frames."""
    height, width = frame.shape[:2]
    size = (CAMERA_MOTION_ANALYSIS_WIDTH, max(1, round(height * CAMERA_MOTION_ANALYSIS_WIDTH / width)))
    return cv2.cvtColor(cv2.resize(frame, size, interpolation=cv2.INTER_AREA), cv2.COLOR_BGR2GRAY).astype(np.float32)


def measure_camera_shift(
    previous_image: np.ndarray,
    current_image: np.ndarray,
    frame_width: int,
) -> tuple[float, float, float]:
    """(dx, dy, response): full-resolution shift that moves the previous frame onto the current one."""
    (dx, dy), response = cv2.phaseCorrelate(previous_image, current_image)
    scale = frame_width / previous_image.shape[1]
    return dx * scale, dy * scale, response


def estimate_camera_shift(
    previous_image: np.ndarray,
    current_image: np.ndarray,
    frame_width: int,
) -> tuple[float, float] | None:
    """Shift worth compensating, or None when the camera barely moved or the estimate is unreliable."""
    dx, dy, response = measure_camera_shift(previous_image, current_image, frame_width)
    if response < CAMERA_SHIFT_MIN_RESPONSE or max(abs(dx), abs(dy)) < CAMERA_SHIFT_MIN_PIXELS:
        return None
    return dx, dy


class StaticSceneFilter:
    """Recognises candidates that are part of the scenery by looking a few frames back."""

    def __init__(self, lag: int = STATIC_SCENE_LAG_FRAMES):
        self.lag = lag
        self.history: deque[tuple[np.ndarray, tuple[float, float]]] = deque(maxlen=lag + 1)
        self.offset = (0.0, 0.0)

    def push(self, gray: np.ndarray, shift: tuple[float, float] | None) -> None:
        """Adds the current frame; `shift` is the camera motion since the previous one."""
        if shift is not None:
            self.offset = (self.offset[0] + shift[0], self.offset[1] + shift[1])
        self.history.append((gray, self.offset))

    def is_static(self, bbox: list[float]) -> bool:
        if len(self.history) <= self.lag:
            return False
        current, (current_x, current_y) = self.history[-1]
        past, (past_x, past_y) = self.history[0]
        height, width = current.shape[:2]
        radius = max(STATIC_SCENE_PATCH_RADIUS, int(max(bbox[2] - bbox[0], bbox[3] - bbox[1]) / 2) + 2)
        x, y = round((bbox[0] + bbox[2]) / 2), round((bbox[1] + bbox[3]) / 2)
        if not (radius <= x < width - radius and radius <= y < height - radius):
            return False
        patch = current[y - radius:y + radius + 1, x - radius:x + radius + 1]
        if float(patch.std()) < STATIC_SCENE_MIN_TEXTURE:
            return False
        reach = radius + STATIC_SCENE_SEARCH_PIXELS
        # Where that scene point was `lag` frames ago given the camera motion (scenery), and the
        # same screen position (overlays drawn on top of the picture).
        for past_center_x, past_center_y in {
            (round(x - (current_x - past_x)), round(y - (current_y - past_y))),
            (x, y),
        }:
            left, top = past_center_x - reach, past_center_y - reach
            if left < 0 or top < 0 or past_center_x + reach >= width or past_center_y + reach >= height:
                continue
            window = past[top:past_center_y + reach + 1, left:past_center_x + reach + 1]
            if float(cv2.matchTemplate(window, patch, cv2.TM_CCOEFF_NORMED).max()) >= STATIC_SCENE_MIN_CORRELATION:
                return True
        return False


def align_to_current(previous_frame: np.ndarray, shift: tuple[float, float]) -> np.ndarray:
    matrix = np.float32([[1, 0, shift[0]], [0, 1, shift[1]]])
    height, width = previous_frame.shape[:2]
    return cv2.warpAffine(previous_frame, matrix, (width, height), borderMode=cv2.BORDER_REPLICATE)


class FrameFeatures:
    """HSV image and brightness top-hat of one frame, each computed at most once.

    The colour and motion passes both need them for the frame and for the previous one, and the
    previous frame's features were the current ones a moment ago.
    """

    def __init__(self, frame: np.ndarray):
        self.frame = frame
        self._hsv: np.ndarray | None = None
        self._top_hat: np.ndarray | None = None

    @property
    def hsv(self) -> np.ndarray:
        if self._hsv is None:
            self._hsv = cv2.cvtColor(self.frame, cv2.COLOR_BGR2HSV)
        return self._hsv

    @property
    def top_hat(self) -> np.ndarray:
        if self._top_hat is None:
            self._top_hat = value_top_hat(self.hsv)
        return self._top_hat


def value_top_hat(hsv: np.ndarray) -> np.ndarray:
    return cv2.morphologyEx(
        hsv[:, :, 2],
        cv2.MORPH_TOPHAT,
        cv2.getStructuringElement(
            cv2.MORPH_ELLIPSE,
            (BRIGHT_BALL_TOPHAT_KERNEL_SIZE, BRIGHT_BALL_TOPHAT_KERNEL_SIZE),
        ),
    )


def bright_blob_mask(
    hsv: np.ndarray,
    region_mask: np.ndarray,
    top_hat: np.ndarray | None = None,
) -> np.ndarray:
    return cv2.bitwise_and(
        cv2.bitwise_and(
            cv2.threshold(
                top_hat if top_hat is not None else value_top_hat(hsv),
                BRIGHT_BALL_MIN_CONTRAST - 1,
                255,
                cv2.THRESH_BINARY,
            )[1],
            cv2.threshold(hsv[:, :, 2], BRIGHT_BALL_MIN_VALUE - 1, 255, cv2.THRESH_BINARY)[1],
        ),
        region_mask,
    )


def bright_blob_is_static(
    contour: np.ndarray,
    bright_mask: np.ndarray,
    previous_bright_mask: np.ndarray,
    previous_ball_bbox: list[float] | None,
) -> bool:
    x, y, width, height = cv2.boundingRect(contour)
    if previous_ball_bbox is not None and math.dist(
        (x + width / 2, y + height / 2),
        ((previous_ball_bbox[0] + previous_ball_bbox[2]) / 2, (previous_ball_bbox[1] + previous_ball_bbox[3]) / 2),
    ) <= BRIGHT_BALL_CONTINUITY_PIXELS:
        # A slow ball near the top of its arc overlaps its own previous position.
        return False
    current = bright_mask[y:y + height, x:x + width]
    overlap = cv2.bitwise_and(current, previous_bright_mask[y:y + height, x:x + width])
    return (
        cv2.countNonZero(overlap) / max(1, cv2.countNonZero(current))
        > BRIGHT_BALL_MAX_STATIC_FRACTION
    )


def find_ball_color_candidates(
    frame: np.ndarray,
    court_corners: list[tuple[int, int]],
    previous_frame: np.ndarray | None = None,
    player_bboxes: list[list[float]] | None = None,
    previous_ball_bbox: list[float] | None = None,
    previous_ball_near_player: bool = False,
    moving_only: bool = False,
    features: FrameFeatures | None = None,
    previous_features: FrameFeatures | None = None,
) -> list[tuple[float, list[float]]]:
    """Ball-like blobs as (score, bbox), best first. Most of them are not the ball.

    `features` / `previous_features` let a caller that runs several passes over the same frame
    share the HSV conversions and top-hats instead of recomputing them.
    """
    features = features or FrameFeatures(frame)
    hsv = features.hsv
    mask = cv2.inRange(
        hsv,
        np.asarray((18, 35, 175), dtype=np.uint8),
        np.asarray((96, 255, 255), dtype=np.uint8),
    )
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    frame_area = frame.shape[0] * frame.shape[1]
    min_area = max(1.0, frame_area * 0.000001)
    max_area = max(100.0, frame_area * 0.00025)
    max_diameter = max(16, min(frame.shape[:2]) * 0.035)
    court_polygon = np.asarray(court_corners, dtype=np.float32)
    motion_mask = None
    if previous_frame is not None and previous_frame.shape == frame.shape:
        difference = cv2.absdiff(frame, previous_frame)
        difference = cv2.cvtColor(difference, cv2.COLOR_BGR2GRAY)
        motion_mask = cv2.threshold(difference, 15, 255, cv2.THRESH_BINARY)[1]
    contour_sources = [] if moving_only else [(contour, 0.0) for contour in contours]
    if motion_mask is not None:
        court_fill = ball_region_mask(mask.shape, court_corners)
        previous_features = previous_features or FrameFeatures(previous_frame)
        previous_hsv = previous_features.hsv
        if moving_only:
            moving_mask = cv2.bitwise_and(
                cv2.bitwise_and(
                    cv2.threshold(
                        cv2.subtract(hsv[:, :, 2], previous_hsv[:, :, 2]),
                        MOVING_BALL_MIN_BRIGHTENING - 1,
                        255,
                        cv2.THRESH_BINARY,
                    )[1],
                    cv2.threshold(features.top_hat, MOVING_BALL_MIN_CONTRAST - 1, 255, cv2.THRESH_BINARY)[1],
                ),
                court_fill,
            )
            moving_contours, _ = cv2.findContours(
                moving_mask,
                cv2.RETR_EXTERNAL,
                cv2.CHAIN_APPROX_SIMPLE,
            )
            for contour in moving_contours:
                x, y, width, height = cv2.boundingRect(contour)
                if cv2.countNonZero(moving_mask[y:y + height, x:x + width]) >= MOVING_BALL_MIN_PIXELS:
                    contour_sources.append((contour, MOVING_BALL_SCORE_PENALTY))
        else:
            bright_mask = bright_blob_mask(hsv, court_fill, features.top_hat)
            # Lines and court signage are bright in both frames; dilation absorbs camera jitter.
            previous_bright_mask = cv2.dilate(
                bright_blob_mask(previous_hsv, court_fill, previous_features.top_hat),
                np.ones((3, 3), dtype=np.uint8),
            )
            bright_contours, _ = cv2.findContours(
                bright_mask,
                cv2.RETR_EXTERNAL,
                cv2.CHAIN_APPROX_SIMPLE,
            )
            contour_sources.extend(
                (contour, BRIGHT_BALL_SCORE_PENALTY) for contour in bright_contours
                if not bright_blob_is_static(
                    contour,
                    bright_mask,
                    previous_bright_mask,
                    previous_ball_bbox,
                )
            )
            pale_mask = cv2.bitwise_and(
                cv2.inRange(
                    hsv,
                    np.asarray(PALE_BALL_HSV_LOWER, dtype=np.uint8),
                    np.asarray(PALE_BALL_HSV_UPPER, dtype=np.uint8),
                ),
                court_fill,
            )
            pale_contours, _ = cv2.findContours(
                pale_mask,
                cv2.RETR_EXTERNAL,
                cv2.CHAIN_APPROX_SIMPLE,
            )
            contour_sources.extend(
                (contour, PALE_BALL_SCORE_PENALTY) for contour in pale_contours
            )
    candidates = []

    for contour, score_penalty in contour_sources:
        area = cv2.contourArea(contour)
        if score_penalty:
            # Tiny blobs have a near-zero contour area, so size them by their bounding box.
            _, _, pale_width, pale_height = cv2.boundingRect(contour)
            area = max(area, pale_width * pale_height * 0.5)
        if not min_area <= area <= max_area:
            continue
        x, y, width, height = cv2.boundingRect(contour)
        if max(width, height) > max_diameter or min(width, height) == 0:
            continue
        motion_fraction = 0.0
        if motion_mask is not None:
            motion_fraction = cv2.countNonZero(
                motion_mask[y:y + height, x:x + width]
            ) / (width * height)
            if motion_fraction < 0.35:
                continue
        aspect_ratio = width / height
        if not 0.12 <= aspect_ratio <= 5.0:
            continue
        center = (x + width / 2, y + height / 2)
        if not point_in_ball_tracking_region(center, court_corners):
            continue
        bbox = [float(x), float(y), float(x + width), float(y + height)]
        if player_bboxes and color_candidate_near_player(bbox, player_bboxes):
            if (
                ball_candidate_near_player(bbox, player_bboxes)
                or cv2.pointPolygonTest(court_polygon, center, True) >= 0
                or not point_near_court_baseline(center, court_corners)
            ):
                continue

        perimeter = cv2.arcLength(contour, True)
        circularity = 4 * math.pi * area / max(perimeter * perimeter, 1)
        score = circularity + motion_fraction * 0.5 - score_penalty
        player_distance = distance_to_nearest_player(center, player_bboxes or [])
        if player_distance is not None and player_distance <= 120:
            score += 1.5 * (1.0 - player_distance / 120)
        if previous_ball_bbox is not None:
            previous_center = (
                (previous_ball_bbox[0] + previous_ball_bbox[2]) / 2,
                (previous_ball_bbox[1] + previous_ball_bbox[3]) / 2,
            )
            distance = math.dist(center, previous_center)
            max_displacement = max(60.0, min(frame.shape[:2]) * 0.1)
            if moving_only and distance > max_displacement:
                continue
            if distance <= max_displacement:
                continuity_weight = 2.0 if previous_ball_near_player else 0.15
                score += continuity_weight * (1.0 - distance / max_displacement)
        candidates.append((score, area, bbox))

    candidates.sort(key=lambda candidate: candidate[0] + candidate[1] / max_area * 0.1, reverse=True)
    return [(score, bbox) for score, _, bbox in candidates]


def detect_tennis_ball_color(
    frame: np.ndarray,
    court_corners: list[tuple[int, int]],
    previous_frame: np.ndarray | None = None,
    player_bboxes: list[list[float]] | None = None,
    previous_ball_bbox: list[float] | None = None,
    previous_ball_near_player: bool = False,
    moving_only: bool = False,
) -> tuple[list[float], float] | None:
    """Best single-frame colour guess; without temporal validation it is often wrong."""
    if moving_only and previous_ball_bbox is None:
        return None
    candidates = find_ball_color_candidates(
        frame,
        court_corners,
        previous_frame,
        player_bboxes,
        previous_ball_bbox,
        previous_ball_near_player,
        moving_only,
    )
    if not candidates:
        return None
    score, bbox = candidates[0]
    return bbox, min(0.65, 0.45 + score * 0.2)


def find_balls_in_court(
    frame: np.ndarray,
    court_corners: list[tuple[int, int]],
    model: YOLO,
) -> list[tuple[float, list[float]]]:
    """Every ball the detector sees in an enlarged crop of the court, as (confidence, bbox)."""
    height, width = frame.shape[:2]
    court_x, court_y, court_width, court_height = cv2.boundingRect(
        np.asarray(court_corners, dtype=np.int32)
    )
    padding = max(8, int(max(height, width) * 0.02))
    left = max(0, court_x - padding)
    top = max(0, court_y - padding)
    right = min(width, court_x + court_width + padding)
    bottom = min(height, court_y + court_height + padding)
    court_crop = frame[top:bottom, left:right]
    result = model(
        court_crop,
        classes=[32],
        conf=COURT_BALL_MIN_CONFIDENCE,
        imgsz=COURT_BALL_INFERENCE_SIZE,
        verbose=False,
    )[0]

    candidates = []
    for detection in result.boxes:
        confidence = float(detection.conf[0].item())
        x1, y1, x2, y2 = (float(value) for value in detection.xyxy[0].tolist())
        bbox = [x1 + left, y1 + top, x2 + left, y2 + top]
        center = ((bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2)
        if point_in_ball_tracking_region(center, court_corners):
            candidates.append((confidence, bbox))

    candidates.sort(key=lambda candidate: candidate[0], reverse=True)
    return candidates


def detect_tennis_ball_in_court(
    frame: np.ndarray,
    court_corners: list[tuple[int, int]],
    model: YOLO,
) -> tuple[list[float], float] | None:
    candidates = find_balls_in_court(frame, court_corners, model)
    if not candidates:
        return None
    confidence, bbox = candidates[0]
    return bbox, confidence


def resolve_model(model_size: str, backend: str | None = None) -> tuple[str, str]:
    """(path to load, backend name) for NETPOINT_BACKEND = pytorch (default) | openvino | auto.

    OpenVINO needs the exported folder next to the weights (`yolo export format=openvino
    dynamic=True`) and the `openvino` package; `auto` falls back to PyTorch when either is missing.
    """
    backend = (backend or os.environ.get("NETPOINT_BACKEND") or "pytorch").lower()
    if backend not in {"pytorch", "openvino", "auto"}:
        raise ValueError(f"NETPOINT_BACKEND desconocido: {backend}")
    if backend != "pytorch":
        weights = Path(model_size)
        exported = weights.with_name(f"{weights.stem}_openvino_model")
        if exported.is_dir() and importlib.util.find_spec("openvino") is not None:
            return str(exported), "openvino"
        if backend == "openvino":
            raise RuntimeError(
                f"OpenVINO no disponible: falta {exported} o el paquete openvino."
            )
    return model_size, "pytorch"


def _player_side(detection: dict) -> str:
    return "left" if detection["x_meters"] < COURT_LENGTH_METERS / 2 else "right"


def _blend_players(before: dict, after: dict, weight: float) -> dict:
    def lerp(first: float, second: float) -> float:
        return first + (second - first) * weight

    return {
        **before,
        "confidence": min(before["confidence"], after["confidence"]),
        "bbox": [lerp(a, b) for a, b in zip(before["bbox"], after["bbox"])],
        "x_meters": lerp(before["x_meters"], after["x_meters"]),
        "y_meters": lerp(before["y_meters"], after["y_meters"]),
        "interpolated": True,
    }


def fill_skipped_player_frames(telemetry: list[dict], skipped: list[int]) -> None:
    """Player detections for the frames where the detector did not run, in place.

    Each side is interpolated between the nearest detected frames around the gap; when only an
    earlier detection is close enough it is carried forward, as for any missed detection.
    """
    skipped_frames = set(skipped)
    anchors: dict[str, list[tuple[int, dict]]] = {"left": [], "right": []}
    for frame in telemetry:
        if frame["frame_index"] in skipped_frames:
            continue
        for detection in frame["detections"]:
            if (
                detection["class"] == "player"
                and not detection.get("carried_forward")
                and detection["x_meters"] is not None
            ):
                anchors[_player_side(detection)].append((frame["frame_index"], detection))

    for index in skipped:
        filled = []
        for side in ("left", "right"):
            points = anchors[side]
            position = bisect.bisect_left(points, index, key=lambda point: point[0])
            before = points[position - 1] if position > 0 else None
            after = points[position] if position < len(points) else None
            if (
                before is not None
                and after is not None
                and after[0] - before[0] <= MAX_PLAYER_INTERPOLATION_GAP_FRAMES
            ):
                filled.append(_blend_players(before[1], after[1], (index - before[0]) / (after[0] - before[0])))
            elif before is not None and index - before[0] <= MAX_PLAYER_CARRY_FORWARD_FRAMES:
                filled.append({**before[1], "carried_forward": True})
        telemetry[index]["detections"] = filled + telemetry[index]["detections"]


class TennisTracker:
    # Class defaults keep the exhaustive behaviour; __init__ only changes them through the
    # experimental NETPOINT_* variables above.
    player_detection_stride = 1
    court_ball_stride = 1
    full_frame_classes: list[int] | None = None
    full_frame_imgsz: int | None = None
    # Separate instance for the 960 px court crop: alternating input sizes on one OpenVINO model
    # forces a reshape on every call, which halved its speed.
    court_model = None

    def __init__(self, model_size: str = "yolov8n.pt"):
        model_path, self.backend = resolve_model(model_size)
        print(f"🔄 Cargando modelo YOLOv8 ({model_path}, backend {self.backend})...")
        self.model = YOLO(model_path, task="detect")
        self.court_model = YOLO(model_path, task="detect")
        self.court_detector = CourtDetector()
        # Clases de COCO: 0 = persona (jugadores), 32 = pelota de tenis
        self.target_classes = [0, 32]
        self.player_detection_stride = int(os.environ.get("NETPOINT_PLAYER_STRIDE", PLAYER_DETECTION_STRIDE))
        self.court_ball_stride = int(os.environ.get("NETPOINT_COURT_STRIDE", COURT_BALL_STRIDE))
        self.full_frame_classes = [0] if os.environ.get("NETPOINT_PLAYER_ONLY") == "1" else None
        self.full_frame_imgsz = int(os.environ.get("NETPOINT_FULL_IMGSZ", "0")) or None

    def process_video(
        self,
        video_path: str,
        max_frames: int | None = None,
        progress_callback: Callable[[int, int | None], None] | None = None,
    ):
        cap = cv2.VideoCapture(video_path)
        if not cap.isOpened():
            raise FileNotFoundError(f"No se pudo abrir el vídeo: {video_path}")

        fps = cap.get(cv2.CAP_PROP_FPS)
        total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT)) or None
        if max_frames is not None and total_frames is not None:
            total_frames = min(total_frames, max_frames)
        frame_count = 0
        image_width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        image_height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        telemetry = []
        homography_matrix = None
        calibrated_corners = None
        pending_court_corners = None
        pending_court_corner_count = 0
        last_player_by_side = {}
        last_player_frame_by_side = {}
        previous_video_frame = None
        previous_features = None
        previous_motion_image = None
        static_scene = StaticSceneFilter()
        screen_overlay = ScreenOverlayMask()
        last_player_bboxes: list[list[float]] = []
        last_other_person_bboxes: list[list[float]] = []
        skipped_player_frames: list[int] = []
        ball_candidates_by_frame = []
        if progress_callback is not None:
            progress_callback(0, total_frames)
        print("🚀 Iniciando inferencia con YOLOv8...")

        while cap.isOpened() and (max_frames is None or frame_count < max_frames):
            with stage("decode"):
                ret, frame = cap.read()
            if not ret:
                break
            image_height, image_width = frame.shape[:2]
            features = FrameFeatures(frame)
            with stage("camera_motion"):
                motion_image = camera_motion_image(frame)
                measured_shift = (
                    measure_camera_shift(previous_motion_image, motion_image, image_width)
                    if previous_motion_image is not None
                    else None
                )
                reliable_shift = (
                    measured_shift[:2]
                    if measured_shift is not None and measured_shift[2] >= CAMERA_SHIFT_MIN_RESPONSE
                    else None
                )
                camera_shift = (
                    reliable_shift
                    if reliable_shift is not None and max(map(abs, reliable_shift)) >= CAMERA_SHIFT_MIN_PIXELS
                    else None
                )
                static_scene.push(cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY), reliable_shift)
                screen_overlay.update(previous_motion_image, motion_image, reliable_shift, image_width)

            should_detect_court = (
                frame_count % CALIBRATION_RETRY_INTERVAL == 0
                if homography_matrix is not None
                else frame_count < CALIBRATION_WINDOW_FRAMES
                or frame_count % CALIBRATION_RETRY_INTERVAL == 0
            )
            if should_detect_court:
                if (
                    homography_matrix is None
                    and frame_count == CALIBRATION_WINDOW_FRAMES
                ):
                    print(
                        f"⚠️ No se encontró la pista en los primeros "
                        f"{CALIBRATION_WINDOW_FRAMES} frames; se reintentará "
                        f"cada {CALIBRATION_RETRY_INTERVAL} frames."
                    )
                with stage("court_detect"):
                    detected_corners = self.court_detector.detect_corners(frame)
                court_corners = detected_corners
                if detected_corners is None or len(detected_corners) != 4:
                    if homography_matrix is not None:
                        pending_court_corners = None
                        pending_court_corner_count = 0
                elif homography_matrix is None:
                    max_displacement = max(frame.shape[:2]) * COURT_MAX_CORNER_DISPLACEMENT_RATIO
                    if (
                        pending_court_corners is not None
                        and mean_corner_displacement(
                            detected_corners,
                            pending_court_corners,
                        ) <= max_displacement
                    ):
                        pending_court_corner_count += 1
                    else:
                        pending_court_corners = detected_corners
                        pending_court_corner_count = 1

                    if pending_court_corner_count < COURT_CALIBRATION_CONFIRMATIONS:
                        court_corners = None
                    else:
                        pending_court_corners = None
                        pending_court_corner_count = 0
                else:
                    max_displacement = max(frame.shape[:2]) * COURT_MAX_CORNER_DISPLACEMENT_RATIO
                    displacement = mean_corner_displacement(
                        detected_corners,
                        calibrated_corners,
                    )
                    if displacement > max_displacement:
                        if (
                            pending_court_corners is not None
                            and mean_corner_displacement(
                                detected_corners,
                                pending_court_corners,
                            ) <= max_displacement
                        ):
                            pending_court_corner_count += 1
                        else:
                            pending_court_corners = detected_corners
                            pending_court_corner_count = 1

                        if pending_court_corner_count < COURT_RECALIBRATION_CONFIRMATIONS:
                            court_corners = None
                        else:
                            pending_court_corners = None
                            pending_court_corner_count = 0
                    else:
                        pending_court_corners = None
                        pending_court_corner_count = 0

                if court_corners is not None and len(court_corners) == 4:
                    try:
                        homography_matrix = get_homography_matrix(court_corners)
                        calibrated_corners = court_corners
                    except (ValueError, cv2.error):
                        pass

            # Inferencia filtrada por personas y pelotas de tenis
            run_player_detection = frame_count % self.player_detection_stride == 0
            boxes = []
            if run_player_detection:
                inference_options = {
                    "classes": self.full_frame_classes or self.target_classes,
                    "conf": 0.12,
                    "verbose": False,
                }
                if self.full_frame_imgsz:
                    inference_options["imgsz"] = self.full_frame_imgsz
                with stage("yolo_full"):
                    boxes = self.model(frame, **inference_options)[0].boxes
            frame_index = frame_count
            timestamp_seconds = (
                frame_index / fps
                if fps > 0
                else cap.get(cv2.CAP_PROP_POS_MSEC) / 1000.0
            )
            detections = []
            player_candidates_by_side = {}
            player_bboxes = [] if run_player_detection else last_player_bboxes
            person_bboxes: list[list[float]] = []
            ball_candidates = []
            for box in boxes:
                class_id = int(box.cls[0].item())
                confidence = float(box.conf[0].item())
                if class_id == 0 and confidence < PLAYER_MIN_CONFIDENCE:
                    continue
                bbox = [float(coordinate) for coordinate in box.xyxy[0].tolist()]
                if class_id == 0:
                    person_bboxes.append(bbox)
                x1, _, x2, y2 = bbox
                x_meters = None
                y_meters = None
                if homography_matrix is not None:
                    try:
                        x_meters, y_meters = transform_point(
                            ((x1 + x2) / 2, y2),
                            homography_matrix,
                        )
                    except (ValueError, cv2.error):
                        continue

                    if class_id == 0:
                        if not player_within_tracking_region(
                            x_meters,
                            y_meters,
                            confidence,
                        ):
                            continue
                    elif not (
                        0 <= x_meters <= COURT_LENGTH_METERS
                        and 0 <= y_meters <= COURT_WIDTH_METERS
                    ) and not (
                        class_id == 32
                        and calibrated_corners is not None
                        and point_in_ball_tracking_region(
                            ((bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2),
                            calibrated_corners,
                        )
                    ):
                        continue
                    if (
                        class_id == 0
                        and min(y_meters, COURT_WIDTH_METERS - y_meters)
                        < PLAYER_SIDELINE_EDGE_MARGIN_METERS
                        and confidence < PLAYER_SIDELINE_EDGE_MIN_CONFIDENCE
                    ):
                        continue

                detection = {
                    "class": "player" if class_id == 0 else "ball",
                    "confidence": confidence,
                    "bbox": bbox,
                    "x_meters": x_meters,
                    "y_meters": y_meters,
                }
                if class_id == 0:
                    player_bboxes.append(bbox)
                if class_id == 32:
                    ball_candidates.append(detection)
                    continue
                if homography_matrix is None:
                    continue

                side = (
                    "left"
                    if x_meters < COURT_LENGTH_METERS / 2
                    else "right"
                )
                current_candidate = player_candidates_by_side.get(side)
                if (
                    current_candidate is None
                    or detection["confidence"] > current_candidate["confidence"]
                ):
                    player_candidates_by_side[side] = detection

            # A single frame cannot tell the ball from a glint on a line, so every plausible
            # candidate is kept and the ball is chosen afterwards from how they move over time.
            frame_ball_candidates = [
                {
                    "bbox": detection["bbox"],
                    "confidence": detection["confidence"],
                    "source": "yolo",
                }
                for detection in ball_candidates
                if not ball_candidate_near_player(detection["bbox"], player_bboxes)
                or (
                    calibrated_corners is not None
                    and point_outside_court_near_baseline(
                        (
                            (detection["bbox"][0] + detection["bbox"][2]) / 2,
                            (detection["bbox"][1] + detection["bbox"][3]) / 2,
                        ),
                        calibrated_corners,
                    )
                )
            ]
            if run_player_detection:
                # Anyone overlapping a person in the playing area (a player, or a second box YOLO
                # put on the same player) is kept out of this list: the ball is often next to them.
                other_person_bboxes = [
                    box for box in person_bboxes
                    if not any(boxes_overlap(box, player_box) for player_box in player_bboxes)
                ]
                last_other_person_bboxes = other_person_bboxes
            else:
                other_person_bboxes = last_other_person_bboxes
            if homography_matrix is not None:
                cheap_candidates = []
                if previous_video_frame is not None:
                    reference_frame, reference_features = previous_video_frame, previous_features
                    if camera_shift is not None:
                        with stage("camera_motion"):
                            reference_frame = align_to_current(previous_video_frame, camera_shift)
                        reference_features = FrameFeatures(reference_frame)
                    for source, moving_only in (("color", False), ("motion", True)):
                        with stage(f"ball_{source}"):
                            found = find_ball_color_candidates(
                                frame,
                                calibrated_corners,
                                reference_frame,
                                player_bboxes,
                                moving_only=moving_only,
                                features=features,
                                previous_features=reference_features,
                            )
                        # Scenery is discarded before keeping the best few: logos, lines and the
                        # scoreboard often outscore the ball and would otherwise take every slot.
                        with stage("static_scene"):
                            kept = list(itertools.islice(
                                (
                                    (score, bbox) for score, bbox in found
                                    if not inside_any_box(
                                        ((bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2),
                                        other_person_bboxes,
                                        OTHER_PERSON_BOX_MARGIN,
                                    )
                                    and not screen_overlay.contains(((bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2))
                                    and not static_scene.is_static(bbox)
                                ),
                                MAX_BALL_CANDIDATES_PER_SOURCE,
                            ))
                        cheap_candidates.extend(
                            {
                                "bbox": bbox,
                                "confidence": max(0.0, min(1.0, score / 2)),
                                "source": source,
                            }
                            for score, bbox in kept
                        )
                # The court-crop detector is the most expensive step: it runs on alternate frames,
                # and in any frame where the cheap detectors found nothing at all.
                if not frame_ball_candidates and (
                    frame_count % self.court_ball_stride == 0 or not cheap_candidates
                ):
                    with stage("yolo_court"):
                        frame_ball_candidates.extend(
                            {"bbox": bbox, "confidence": confidence, "source": "yolo_court"}
                            for confidence, bbox in find_balls_in_court(
                                frame,
                                calibrated_corners,
                                self.court_model or self.model,
                            )[:MAX_BALL_CANDIDATES_PER_SOURCE]
                            if not ball_candidate_near_player(bbox, player_bboxes)
                        )
                frame_ball_candidates.extend(cheap_candidates)
            ball_candidates_by_frame.append(frame_ball_candidates)

            if run_player_detection:
                last_player_bboxes = player_bboxes
            if homography_matrix is not None and not run_player_detection:
                skipped_player_frames.append(frame_index)
            elif homography_matrix is not None:
                selected_players = []
                for side in ("left", "right"):
                    player = player_candidates_by_side.get(side)
                    if player is not None:
                        last_player_by_side[side] = player
                        last_player_frame_by_side[side] = frame_count
                    else:
                        player = last_player_by_side.get(side)
                        previous_frame = last_player_frame_by_side.get(side, frame_count)
                        if (
                            player is not None
                            and frame_count - previous_frame
                            <= MAX_PLAYER_CARRY_FORWARD_FRAMES
                        ):
                            player = {**player, "carried_forward": True}
                        else:
                            player = None
                            last_player_by_side.pop(side, None)
                            last_player_frame_by_side.pop(side, None)
                    if player is not None:
                        selected_players.append(player.copy())
                detections = selected_players + detections

            telemetry.append({
                "frame_index": frame_index,
                "timestamp_seconds": timestamp_seconds,
                "court_corners": calibrated_corners,
                "detections": detections,
            })
            frame_count += 1
            previous_video_frame = frame
            previous_features = features
            previous_motion_image = motion_image
            if progress_callback is not None and (
                frame_count % 5 == 0
                or (total_frames is not None and frame_count >= total_frames)
            ):
                progress_callback(frame_count, total_frames)

            if frame_count % 30 == 0:
                frame_limit = f"/{max_frames}" if max_frames is not None else ""
                print(f"Fotogramas procesados: {frame_count}{frame_limit}")

        cap.release()
        cv2.destroyAllWindows()
        print(f"✨ Inferencia completada. {frame_count} fotogramas analizados.")
        fill_skipped_player_frames(telemetry, skipped_player_frames)
        with stage("track_ball"):
            ball_summary = track_ball(telemetry, ball_candidates_by_frame, image_width)
        print(
            f"🎾 Pelota: {ball_summary['measured_frames']} fotogramas medidos y "
            f"{ball_summary['interpolated_frames']} interpolados de {frame_count}; "
            f"{ball_summary['rejected_candidates']} candidatos descartados."
        )
        if homography_matrix is None:
            print(
                "⚠️ No se pudo calibrar la pista; las coordenadas métricas "
                "quedan como null."
            )
        with stage("build_events"):
            events = build_events(telemetry, image_width, image_height)
        return {
            "version": 2,
            "video": {
                "fps": fps if fps > 0 else None,
                "width": image_width,
                "height": image_height,
                "frame_count": frame_count,
            },
            "court": {
                "length_meters": COURT_LENGTH_METERS,
                "width_meters": COURT_WIDTH_METERS,
                "calibrated": homography_matrix is not None,
            },
            "frames": telemetry,
            "events": events,
        }