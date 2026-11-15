"""Temporal validation of ball candidates and filling of the frames where the ball is not seen.

A tennis ball in broadcast footage is a few pixels wide, smears when it is fast and vanishes
against the net and the lines, while glints on lines and compression noise look just like it.
No single frame can tell them apart. What identifies the ball is that, over several frames, it
follows a fast and smooth path: the image of a ballistic flight is locally a parabola.

The per-frame stage therefore only proposes candidates. Here they are chained into tracklets
that obey that motion model, the tracklets that could not be a ball are discarded together
with every candidate left over, and the frames the ball was missed in are interpolated from
the motion on both sides of the gap. Interpolated positions are flagged, never passed off as
measurements.
"""

import math
from collections.abc import Sequence
from dataclasses import dataclass

import cv2
import numpy as np

from homography import get_homography_matrix, transform_point
from trajectory import MAX_BALL_IMAGE_SPEED_WIDTHS_PER_SECOND


# Two candidates start a tracklet only when they are this close in time.
SEED_MAX_STEP_SECONDS = 0.085
SEED_GATE_SPEED_FRACTION = 0.3
# A tracklet survives this long without a supporting candidate before it ends.
MAX_TRACKLET_GAP_SECONDS = 0.2
# Samples used to predict the next position; longer windows stop being parabolic.
FIT_WINDOW_SECONDS = 0.28
MIN_QUADRATIC_FIT_SAMPLES = 5
# Distance allowed between a candidate and its prediction, as a fraction of the image width.
GATE_WIDTH_RATIO = 0.005
MIN_GATE_PIXELS = 4.0
GATE_GROWTH_PER_MISSED_FRAME = 0.5
GATE_SPEED_FRACTION = 0.2

MIN_TRACKLET_SUPPORTS = 5
MIN_TRACKLET_SECONDS = 0.12
# A ball crosses the court; whatever stays put on it is a line, a logo or the net.
MIN_TRACKLET_TRAVEL_WIDTH_RATIO = 0.015
MIN_TRACKLET_TRAVEL_PIXELS = 8.0
MIN_TRACKLET_SCORE = 3.0
# Shoes, a shadow or the racket move with a player, not relative to them. A tracklet that stays
# this close to a player (in player heights) in most of its frames, and moves relative to them
# much less than it moves on screen, belongs to the player. The ball is far faster than a player,
# so even near the racket it moves relative to them about as much as on screen. The ratio, not a
# fixed distance, because the player's box jitters as the racket arm extends.
PLAYER_ATTACHED_MAX_HEIGHTS = 1.0
PLAYER_ATTACHED_MIN_FRACTION = 0.8
PLAYER_ATTACHED_MAX_RELATIVE_TRAVEL = 0.5
# A running player makes the frame-difference detector fire all around them (shadow, shoes, the
# edges of the body), so a tracklet next to a player that only that detector supports is not
# trusted; the real ball there is also seen by the colour or YOLO detectors.
UNCORROBORATED_SOURCES = {"motion"}
SOURCE_WEIGHTS = {"yolo": 1.0, "yolo_court": 1.0, "color": 0.6, "motion": 0.5}

# Gaps between two tracklets are bridged when both sides agree on where the ball went.
MAX_BRIDGE_SECONDS = 0.4
BRIDGE_GATE_MULTIPLIER = 4.0
MAX_LINEAR_BRIDGE_SECONDS = 0.13

# Once a candidate has been confirmed by its trajectory, the detector's own score matters little.
TRACKED_BALL_MIN_CONFIDENCE = 0.5
INTERPOLATED_BALL_CONFIDENCE = 0.3


@dataclass(eq=False)
class BallCandidate:
    frame_position: int
    time: float
    x: float
    y: float
    bbox: list[float]
    confidence: float
    source: str


@dataclass
class _Limits:
    gate: float
    max_speed: float
    min_travel: float


def _fit_motion(points: Sequence[BallCandidate], time: float) -> tuple[float, float]:
    """Position at `time` on the constant-acceleration path closest to `points`."""
    if len(points) == 1:
        return points[0].x, points[0].y
    reference = points[-1].time
    offsets = np.asarray([point.time - reference for point in points])
    degree = 2 if len(points) >= MIN_QUADRATIC_FIT_SAMPLES else 1
    return tuple(
        float(np.polyval(np.polyfit(offsets, values, degree), time - reference))
        for values in ([point.x for point in points], [point.y for point in points])
    )


def _grow(
    seed: Sequence[BallCandidate],
    by_frame: Sequence[Sequence[BallCandidate]],
    times: Sequence[float],
    limits: _Limits,
) -> list[BallCandidate]:
    """Extend a seed both ways with the candidates that keep following its motion."""
    track = list(seed)
    for direction in (1, -1):
        while True:
            edge = track[-1] if direction > 0 else track[0]
            recent = [point for point in track if abs(point.time - edge.time) <= FIT_WINDOW_SECONDS]
            found = None
            position = edge.frame_position + direction
            missed = 0
            while 0 <= position < len(times):
                elapsed = abs(times[position] - edge.time)
                if elapsed > MAX_TRACKLET_GAP_SECONDS:
                    break
                predicted = _fit_motion(recent, times[position])
                gate = (
                    limits.gate * (1 + GATE_GROWTH_PER_MISSED_FRAME * missed)
                    + GATE_SPEED_FRACTION * math.hypot(predicted[0] - edge.x, predicted[1] - edge.y)
                )
                best_rank = None
                for candidate in by_frame[position]:
                    error = math.hypot(candidate.x - predicted[0], candidate.y - predicted[1])
                    if error > gate or math.hypot(
                        candidate.x - edge.x, candidate.y - edge.y
                    ) > limits.max_speed * elapsed + limits.gate:
                        continue
                    # Two detectors often report the same blob; the more reliable one wins.
                    rank = SOURCE_WEIGHTS.get(candidate.source, 0.5) - error / gate
                    if best_rank is None or rank > best_rank:
                        found, best_rank = candidate, rank
                if found is not None:
                    break
                position += direction
                missed += 1
            if found is None:
                break
            if direction > 0:
                track.append(found)
            else:
                track.insert(0, found)
    return track


class _Stabilizer:
    """Removes camera motion by expressing image points in the view of a reference frame.

    A broadcast camera turns and zooms around a fixed point, so two of its views are related
    by a homography that the court corners give for every scene point, not only the ground.
    """

    def __init__(self, frames: Sequence[dict]):
        self.frames = frames
        self.cache: dict[tuple, np.ndarray | None] = {}

    def _image_to_court(self, position: int) -> np.ndarray | None:
        corners = self.frames[position].get("court_corners")
        if not corners:
            return None
        key = tuple(tuple(corner) for corner in corners)
        if key not in self.cache:
            try:
                self.cache[key] = get_homography_matrix(key).astype(np.float64)
            except (ValueError, cv2.error):
                self.cache[key] = None
        return self.cache[key]

    def relative_to_player(self, track: Sequence[BallCandidate]) -> list[tuple[float, float]] | None:
        """Offsets from the feet of the nearest player, or None when the track keeps away from them."""
        offsets = []
        for point in track:
            boxes = [
                detection["bbox"] for detection in self.frames[point.frame_position]["detections"]
                if detection["class"] == "player"
            ]
            if not boxes:
                continue
            box = min(
                boxes,
                key=lambda candidate: math.hypot(
                    point.x - (candidate[0] + candidate[2]) / 2, point.y - (candidate[1] + candidate[3]) / 2
                ),
            )
            height = max(box[3] - box[1], 1.0)
            gap = math.hypot(max(box[0] - point.x, 0.0, point.x - box[2]), max(box[1] - point.y, 0.0, point.y - box[3]))
            if gap > PLAYER_ATTACHED_MAX_HEIGHTS * height:
                continue
            offsets.append((point.x - (box[0] + box[2]) / 2, point.y - box[3]))
        if len(offsets) < PLAYER_ATTACHED_MIN_FRACTION * len(track):
            return None
        return offsets

    def positions(self, track: Sequence[BallCandidate]) -> list[tuple[float, float]]:
        raw = [(point.x, point.y) for point in track]
        homographies = [self._image_to_court(point.frame_position) for point in track]
        if any(homography is None for homography in homographies):
            return raw
        try:
            court_to_reference = np.linalg.inv(homographies[len(track) // 2])
        except np.linalg.LinAlgError:
            return raw
        stabilized = []
        for (x, y), homography in zip(raw, homographies):
            u, v, w = court_to_reference @ homography @ np.asarray([x, y, 1.0])
            if abs(w) < 1e-9:
                return raw
            stabilized.append((float(u / w), float(v / w)))
        return stabilized


def _travel(positions: Sequence[tuple[float, float]]) -> float:
    xs = [position[0] for position in positions]
    ys = [position[1] for position in positions]
    return math.hypot(max(xs) - min(xs), max(ys) - min(ys))


def _score(track: Sequence[BallCandidate]) -> float:
    return sum(
        SOURCE_WEIGHTS.get(point.source, 0.5) + (point.confidence if point.source.startswith("yolo") else 0.0)
        for point in track
    )


def _is_ball_like(track: Sequence[BallCandidate], stabilizer: _Stabilizer, limits: _Limits) -> bool:
    # Scenery (a logo, a line) stays put once the camera motion is removed; broadcast graphics
    # (the scoreboard) stay put on screen. The ball has to travel in both.
    return (
        len(track) >= MIN_TRACKLET_SUPPORTS
        and track[-1].time - track[0].time >= MIN_TRACKLET_SECONDS
        and _score(track) >= MIN_TRACKLET_SCORE
        and _travel(stabilizer.positions(track)) >= limits.min_travel
        and _travel([(point.x, point.y) for point in track]) >= limits.min_travel
        and not _moves_with_a_player(track, stabilizer, limits)
    )


def _moves_with_a_player(track: Sequence[BallCandidate], stabilizer: _Stabilizer, limits: _Limits) -> bool:
    offsets = stabilizer.relative_to_player(track)
    if offsets is None:
        return False
    if all(point.source in UNCORROBORATED_SOURCES for point in track):
        return True
    screen_travel = _travel([(point.x, point.y) for point in track])
    return _travel(offsets) < max(limits.min_travel, PLAYER_ATTACHED_MAX_RELATIVE_TRAVEL * screen_travel)


def build_tracklets(
    by_frame: Sequence[Sequence[BallCandidate]],
    times: Sequence[float],
    limits: _Limits,
) -> list[list[BallCandidate]]:
    """Every maximal chain of candidates that moves like one object."""
    tracklets = []
    chained: set[tuple[int, int]] = set()
    for first_position, first_candidates in enumerate(by_frame):
        for first in first_candidates:
            for second_position in range(first_position + 1, len(by_frame)):
                first_step = times[second_position] - first.time
                if first_step > SEED_MAX_STEP_SECONDS:
                    break
                for second in by_frame[second_position]:
                    if (id(first), id(second)) in chained:
                        continue
                    step = math.hypot(second.x - first.x, second.y - first.y)
                    if step > limits.max_speed * first_step + limits.gate:
                        continue
                    for third_position in range(second_position + 1, len(by_frame)):
                        second_step = times[third_position] - second.time
                        if second_step > SEED_MAX_STEP_SECONDS:
                            break
                        ratio = second_step / first_step
                        expected = (
                            second.x + (second.x - first.x) * ratio,
                            second.y + (second.y - first.y) * ratio,
                        )
                        gate = limits.gate + SEED_GATE_SPEED_FRACTION * step * ratio
                        for third in by_frame[third_position]:
                            if (id(second), id(third)) in chained or math.hypot(
                                third.x - expected[0], third.y - expected[1]
                            ) > gate:
                                continue
                            track = _grow((first, second, third), by_frame, times, limits)
                            chained.update(
                                (id(previous), id(following))
                                for previous, following in zip(track, track[1:])
                            )
                            tracklets.append(track)
    return tracklets


def select_tracklets(
    tracklets: Sequence[Sequence[BallCandidate]],
    stabilizer: _Stabilizer,
    limits: _Limits,
) -> list[list[BallCandidate]]:
    """The ball-like tracklets that can coexist: there is one ball and it cannot teleport."""
    selected: list[list[BallCandidate]] = []
    for track in sorted(tracklets, key=_score, reverse=True):
        # Only the part that does not overlap a better tracklet in time can still be the ball.
        runs: list[list[BallCandidate]] = [[]]
        for point in track:
            if any(other[0].time <= point.time <= other[-1].time for other in selected):
                runs.append([])
            else:
                runs[-1].append(point)
        track = max(runs, key=len)
        if not _is_ball_like(track, stabilizer, limits):
            continue
        reachable = True
        for other in selected:
            before, after = (other[-1], track[0]) if other[-1].time < track[0].time else (track[-1], other[0])
            elapsed = after.time - before.time
            if math.hypot(after.x - before.x, after.y - before.y) > limits.max_speed * elapsed + limits.gate:
                reachable = False
                break
        if reachable:
            selected.append(track)
    return sorted(selected, key=lambda track: track[0].time)


def _estimate(points: Sequence[BallCandidate], time: float) -> tuple[float, float, float, float]:
    """Centre from the motion fit and size from the neighbouring measurements."""
    x, y = _fit_motion(points, time)
    width = sum(point.bbox[2] - point.bbox[0] for point in points) / len(points)
    height = sum(point.bbox[3] - point.bbox[1] for point in points) / len(points)
    return x, y, width, height


def _nearby(track: Sequence[BallCandidate], time: float) -> list[BallCandidate]:
    return [point for point in track if abs(point.time - time) <= FIT_WINDOW_SECONDS / 2] or [
        min(track, key=lambda point: abs(point.time - time))
    ]


def interpolate_gaps(
    tracklets: Sequence[Sequence[BallCandidate]],
    times: Sequence[float],
    limits: _Limits,
) -> dict[int, tuple[float, float, float, float]]:
    """Estimated (x, y, width, height) for the frames the ball was missed in."""
    estimates: dict[int, tuple[float, float, float, float]] = {}
    for track in tracklets:
        for previous, following in zip(track, track[1:]):
            for position in range(previous.frame_position + 1, following.frame_position):
                points = [
                    point for point in track
                    if previous.time - point.time <= FIT_WINDOW_SECONDS / 2
                    and point.time - following.time <= FIT_WINDOW_SECONDS / 2
                ]
                estimates[position] = _estimate(points, times[position])

    for before, after in zip(tracklets, tracklets[1:]):
        last, first = before[-1], after[0]
        elapsed = first.time - last.time
        positions = range(last.frame_position + 1, first.frame_position)
        if not positions or elapsed > MAX_BRIDGE_SECONDS:
            continue
        # A hit or a bounce usually hides in the gap, so each side is extrapolated towards
        # the other and they are joined where the two paths meet.
        tail = [point for point in before if last.time - point.time <= FIT_WINDOW_SECONDS]
        head = [point for point in after if point.time - first.time <= FIT_WINDOW_SECONDS]
        forward = [_estimate(tail, times[position]) for position in positions]
        backward = [_estimate(head, times[position]) for position in positions]
        distances = [
            math.hypot(ahead[0] - behind[0], ahead[1] - behind[1])
            for ahead, behind in zip(forward, backward)
        ]
        meeting = min(range(len(distances)), key=distances.__getitem__)
        if distances[meeting] <= limits.gate * BRIDGE_GATE_MULTIPLIER:
            for index, position in enumerate(positions):
                if index == meeting:
                    estimates[position] = tuple(
                        (ahead + behind) / 2 for ahead, behind in zip(forward[index], backward[index])
                    )
                else:
                    estimates[position] = forward[index] if index < meeting else backward[index]
        elif elapsed <= MAX_LINEAR_BRIDGE_SECONDS:
            for position in positions:
                estimates[position] = _estimate([last, first], times[position])
    return estimates


def _ball_detection(frame: dict, bbox: Sequence[float], confidence: float, source: str) -> dict:
    x_meters = y_meters = None
    corners = frame.get("court_corners")
    if corners:
        try:
            x_meters, y_meters = transform_point(
                ((bbox[0] + bbox[2]) / 2, bbox[3]),
                get_homography_matrix(corners),
            )
        except (ValueError, cv2.error):
            pass
    return {
        "class": "ball",
        "confidence": confidence,
        "bbox": [float(value) for value in bbox],
        "x_meters": x_meters,
        "y_meters": y_meters,
        "source": source,
    }


def track_ball(
    frames: list[dict],
    candidates_by_frame: Sequence[Sequence[dict]],
    image_width: float,
) -> dict:
    """Add to each frame the ball that the candidates of the whole video agree on, if any."""
    times = [frame["timestamp_seconds"] for frame in frames]
    by_frame = [
        [
            BallCandidate(
                position,
                times[position],
                (candidate["bbox"][0] + candidate["bbox"][2]) / 2,
                (candidate["bbox"][1] + candidate["bbox"][3]) / 2,
                candidate["bbox"],
                candidate["confidence"],
                candidate["source"],
            )
            for candidate in candidates
        ]
        for position, candidates in enumerate(candidates_by_frame)
    ]
    limits = _Limits(
        gate=max(MIN_GATE_PIXELS, image_width * GATE_WIDTH_RATIO),
        max_speed=image_width * MAX_BALL_IMAGE_SPEED_WIDTHS_PER_SECOND,
        min_travel=max(MIN_TRACKLET_TRAVEL_PIXELS, image_width * MIN_TRACKLET_TRAVEL_WIDTH_RATIO),
    )
    tracklets = select_tracklets(build_tracklets(by_frame, times, limits), _Stabilizer(frames), limits)

    measured = 0
    for track in tracklets:
        for point in track:
            frames[point.frame_position]["detections"].append(_ball_detection(
                frames[point.frame_position],
                point.bbox,
                max(point.confidence, TRACKED_BALL_MIN_CONFIDENCE),
                point.source,
            ))
            measured += 1
    estimates = interpolate_gaps(tracklets, times, limits)
    for position, (x, y, width, height) in estimates.items():
        frames[position]["detections"].append({
            **_ball_detection(
                frames[position],
                [x - width / 2, y - height / 2, x + width / 2, y + height / 2],
                INTERPOLATED_BALL_CONFIDENCE,
                "interpolated",
            ),
            "interpolated": True,
        })
    return {
        "measured_frames": measured,
        "interpolated_frames": len(estimates),
        "rejected_candidates": sum(len(candidates) for candidates in by_frame) - measured,
        "tracklets": len(tracklets),
    }
