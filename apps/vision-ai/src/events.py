"""Match events (bounces and hits) derived from per-frame telemetry.

Events are first proposed from the ball's image trajectory and then reconstructed in 3D:
each free flight between two events is fitted with a ballistic model, which yields the
ball height, its true court position and its speed. A single camera cannot observe height
directly, so every event carries a confidence and the method that produced its position.
"""

import math
from collections.abc import Sequence
from dataclasses import replace

from camera import Camera, estimate_camera, estimate_focal_length
from homography import COURT_LENGTH_METERS, COURT_WIDTH_METERS
from trajectory import (
    CONTACT_MAX_HEIGHT_METERS,
    BallSample,
    Contact,
    Flight,
    best_ball,
    collect_ball_samples,
    fit_flight,
    fit_velocity,
    is_finite_number,
    launch_velocity,
    split_trajectories,
)


NET_POSITION_METERS = COURT_LENGTH_METERS / 2

BOUNCE_WINDOW_SECONDS = 0.2
BOUNCE_MIN_SEPARATION_SECONDS = 0.3
BOUNCE_MIN_RISE_RATIO = 0.003
BOUNCE_MAX_SIDEWAYS_DEVIATION_RATIO = 0.015

HIT_MIN_BALL_CONFIDENCE = 0.25
HIT_VELOCITY_WINDOW_SECONDS = 0.25
HIT_MIN_WINDOW_SAMPLES = 3
HIT_MIN_DIRECTION_SPEED_WIDTHS_PER_SECOND = 0.01
HIT_MIN_DIRECTION_CHANGE_DEGREES = 60
HIT_MIN_VELOCITY_CHANGE_WIDTHS_PER_SECOND = 0.1
# Arm plus racket reach about 0.8 of a player's height beyond the body; the box often misses the arm.
HIT_PLAYER_REACH_HEIGHT_RATIO = 0.6
HIT_MIN_PLAYER_REACH_PIXELS = 28
HIT_COOLDOWN_SECONDS = 0.5
HIT_BOUNCE_EXCLUSION_SECONDS = 0.1
HIT_VANISH_WINDOW_SECONDS = 0.5
HIT_VANISH_MIN_RETURN_RATIO = 0.2
VANISH_CONTINUATION_WIDTH_RATIO = 0.02
HIT_SHARPEN_SECONDS = 0.06
HIT_SHARPEN_MIN_CHANGE_RATIO = 2.0
# YOLO often loses a player for a fraction of a second right at the stroke, when the arm and
# racket blur; for hit detection the player is placed between the detections around the loss.
HIT_LOST_PLAYER_MAX_SECONDS = 1.0

SPEED_SEGMENT_COUNT = 3
SPEED_WINDOW_SECONDS = 0.25
SPEED_MAX_SEGMENT_GAP_SECONDS = 0.12
MAX_PLAUSIBLE_SPEED_KMH = 265
POINT_GAP_SECONDS = 4
RALLY_BOUNCE_SECONDS = 1.5
SERVE_BASELINE_TOLERANCE_METERS = 1
VOLLEY_MAX_NET_DISTANCE_METERS = 6.4

# A bounce that does not reverse the ball's image motion still kicks its image velocity upwards.
KINK_WINDOW_SECONDS = 0.1
KINK_MIN_WINDOW_SAMPLES = 3
KINK_MIN_UPWARD_IMPULSE_WIDTHS_PER_SECOND = 0.04
KINK_EVENT_EXCLUSION_SECONDS = 0.3
KINK_TIME_OFFSETS_FRAMES = (-0.5, 0.0, 0.5, 1.0)
# A bounce must explain the samples clearly better than one uninterrupted flight does.
KINK_MIN_SINGLE_FLIGHT_ERROR_RATIO = 1.3
KINK_SINGLE_FLIGHT_ERROR_MARGIN_PIXELS = 0.3
# When the flights between known events do not explain a kink, a hit may have been missed: the
# ball unseen for a few frames or the player lost at the stroke. The bounce is then fitted to the
# ball seen continuously around it.
KINK_UNSEEN_GAP_FRAMES = 4
KINK_SEEN_AFTER_SECONDS = 0.3
BOUNCE_SIDEWAYS_DEADBAND_RATIO = 0.003
BOUNCE_MAX_FLIGHT_DISAGREEMENT_METERS = 1.0
BOUNCE_MIN_RESTITUTION = 0.3
BOUNCE_MAX_RESTITUTION = 1.1
BOUNCE_MAX_SPEED_GAIN = 1.1
BOUNCE_OUT_MARGIN_METERS = 3.0

# An image reversal within the near player's reach may be the racket rather than the ground: a
# serve toss leaving several times faster than it fell, or flights on both sides that travel in
# opposite directions along the court with the ball sent towards the far side at a stroke's pace.
# A hit sends the ball to the opponent; one that would send it back to the hitter's side is not.
REVERSAL_WINDOW_SECONDS = 0.3
REVERSAL_MIN_SPEED_METERS_PER_SECOND = 2.0
TOSS_MIN_SPEED_RATIO = 4.0
STROKE_MIN_SPEED_METERS_PER_SECOND = 5.0
# Arm, racket and a step towards the ball, measured from the player's feet.
PLAYER_REACH_METERS = 2.5
REACH_HEIGHT_STEP_METERS = 0.1

# A fast ball over clay or a busy background can go unseen for a few frames right before it lands.
# A bounce inside such a gap is accepted when a flight leaving the ground in the gap explains what
# is seen afterwards, the ball reappears on the receiver's side, and it has not bounced there since
# the last hit (a shot bounces once before the reply).
GAP_MIN_FRAMES = 4
GAP_MAX_SECONDS = 0.5
GAP_EVENT_EXCLUSION_SECONDS = 0.1
GAP_MIN_AFTER_SAMPLES = 6
GAP_AFTER_WINDOW_SECONDS = 0.5
GAP_BEFORE_WINDOW_SECONDS = 0.6
GAP_MAX_SAMPLE_STEP_SECONDS = 0.1
GAP_MIN_LAUNCH_VERTICAL_SPEED = 0.5

MIN_UNANCHORED_FLIGHT_SAMPLES = 10
MIN_UNANCHORED_FLIGHT_SECONDS = 0.4

# A ball placed by a fitted flight in a frame where it was not seen.
FLIGHT_BALL_CONFIDENCE = 0.4

CONFIDENCE_IMAGE_ONLY = 0.5
CONFIDENCE_ONE_FLIGHT = 0.75
CONFIDENCE_TWO_FLIGHTS = 0.9


def side_of(x_meters: float) -> str:
    return "far" if x_meters < NET_POSITION_METERS else "near"


def _metric_position(detection: dict) -> tuple[float, float] | None:
    x, y = detection.get("x_meters"), detection.get("y_meters")
    return (x, y) if is_finite_number(x) and is_finite_number(y) else None


def _inside_court(detection: dict) -> bool:
    position = _metric_position(detection)
    return (
        position is not None
        and 0 <= position[0] <= COURT_LENGTH_METERS
        and 0 <= position[1] <= COURT_WIDTH_METERS
    )


def _center_inside_player(sample: BallSample) -> bool:
    return any(
        detection["class"] == "player"
        and detection["bbox"][0] <= sample.x <= detection["bbox"][2]
        and detection["bbox"][1] <= sample.y <= detection["bbox"][3]
        for detection in sample.frame["detections"]
    )


def _refine_bounce_time(samples: Sequence[BallSample], index: int) -> float:
    """Sub-frame contact time: where the falling and rising image paths cross."""
    candidate = samples[index]

    def fit(points: Sequence[BallSample]) -> tuple[float, float] | None:
        mean_time = sum(point.time for point in points) / len(points)
        mean_y = sum(point.bottom for point in points) / len(points)
        variance = sum((point.time - mean_time) ** 2 for point in points)
        if variance <= 0:
            return None
        slope = sum((point.time - mean_time) * (point.bottom - mean_y) for point in points) / variance
        return slope, mean_y - slope * mean_time

    before = fit(samples[index - 2:index + 1])
    after = fit(samples[index:index + 3])
    if before is None or after is None or before[0] - after[0] <= 1e-9:
        return candidate.time
    crossing = (after[1] - before[1]) / (before[0] - after[0])
    half_before = (candidate.time - samples[index - 1].time) / 2
    half_after = (samples[index + 1].time - candidate.time) / 2
    return min(candidate.time + half_after, max(candidate.time - half_before, crossing))


def detect_bounces(frames: Sequence[dict], image_width: float, image_height: float) -> list[dict]:
    """Bounces as reversals of the ball's vertical image motion away from the players."""
    # Only the contact has to be on the court: a ball rising off a deep bounce projects
    # beyond the baseline, and dropping those samples would hide the bounce itself.
    samples = collect_ball_samples(frames)
    bounces: list[dict] = []
    rise_threshold = max(2.0, image_height * BOUNCE_MIN_RISE_RATIO)
    sideways_threshold = max(12.0, image_width * BOUNCE_MAX_SIDEWAYS_DEVIATION_RATIO)
    sideways_deadband = image_width * BOUNCE_SIDEWAYS_DEADBAND_RATIO

    for trajectory in split_trajectories(samples, image_width, vertical=lambda sample: sample.bottom):
        for index in range(2, len(trajectory) - 2):
            candidate = trajectory[index]
            previous, following = trajectory[index - 1], trajectory[index + 1]
            if (
                candidate.bottom <= previous.bottom
                or candidate.bottom < following.bottom
                or not _inside_court(candidate.ball)
            ):
                continue

            before = [
                sample for sample in trajectory[:index]
                if candidate.time - sample.time <= BOUNCE_WINDOW_SECONDS
            ]
            after = [
                sample for sample in trajectory[index + 1:]
                if sample.time - candidate.time <= BOUNCE_WINDOW_SECONDS
            ]
            if len(before) < 2 or len(after) < 2:
                continue
            # The ball must still be rising at the end of the window; a wobble inside a fall is not a bounce.
            if (
                candidate.bottom - min(sample.bottom for sample in before) < rise_threshold
                or candidate.bottom - after[-1].bottom < rise_threshold
            ):
                continue

            # A ball travelling along the court barely moves sideways, so noise alone flips the sign.
            incoming = candidate.x - trajectory[index - 2].x
            outgoing = trajectory[index + 2].x - candidate.x
            if incoming * outgoing < 0 and min(abs(incoming), abs(outgoing)) > sideways_deadband:
                continue
            fraction = (candidate.time - previous.time) / (following.time - previous.time)
            expected_x = previous.x + (following.x - previous.x) * fraction
            if abs(candidate.x - expected_x) > sideways_threshold or _center_inside_player(candidate):
                continue

            timestamp = _refine_bounce_time(trajectory, index)
            if bounces and timestamp - bounces[-1]["timestamp_seconds"] < BOUNCE_MIN_SEPARATION_SECONDS:
                continue
            x_meters, y_meters = _metric_position(candidate.ball)
            bounces.append({
                "timestamp_seconds": timestamp,
                "frame_index": candidate.frame["frame_index"],
                "x_meters": x_meters,
                "y_meters": y_meters,
                "side": side_of(x_meters),
                "confidence": CONFIDENCE_IMAGE_ONLY,
                "method": "image2d",
            })
    return bounces


def _within_player_reach(sample: BallSample) -> bool:
    # A box carried forward is at most a few frames old: YOLO often loses the player
    # exactly at the stroke, when the arm and racket blur.
    for detection in sample.frame["detections"]:
        if detection["class"] != "player":
            continue
        left, top, right, bottom = detection["bbox"]
        reach = max(HIT_MIN_PLAYER_REACH_PIXELS, (bottom - top) * HIT_PLAYER_REACH_HEIGHT_RATIO)
        if left - reach <= sample.x <= right + reach and top - reach <= sample.y <= bottom + reach:
            return True
    return False


def detect_hits(
    frames: Sequence[dict],
    image_width: float,
    bounce_timestamps: Sequence[float] = (),
) -> list[BallSample]:
    """Racket contacts estimated as abrupt changes of image velocity within reach of a player."""
    samples = collect_ball_samples(frames, HIT_MIN_BALL_CONFIDENCE)
    candidates: list[tuple[BallSample, float]] = []

    for trajectory in split_trajectories(samples, image_width):
        for contact in trajectory:
            before = [
                sample for sample in trajectory
                if 0 <= contact.time - sample.time <= HIT_VELOCITY_WINDOW_SECONDS
            ]
            after = [
                sample for sample in trajectory
                if 0 <= sample.time - contact.time <= HIT_VELOCITY_WINDOW_SECONDS
            ]
            if len(before) < HIT_MIN_WINDOW_SAMPLES or len(after) < HIT_MIN_WINDOW_SAMPLES:
                continue

            before_velocity = fit_velocity(before)
            after_velocity = fit_velocity(after)
            before_speed = math.hypot(*before_velocity)
            after_speed = math.hypot(*after_velocity)
            velocity_change = math.hypot(
                after_velocity[0] - before_velocity[0],
                after_velocity[1] - before_velocity[1],
            )
            min_direction_speed = image_width * HIT_MIN_DIRECTION_SPEED_WIDTHS_PER_SECOND
            if (
                velocity_change < image_width * HIT_MIN_VELOCITY_CHANGE_WIDTHS_PER_SECOND
                or before_speed < min_direction_speed
                or after_speed < min_direction_speed
            ):
                continue
            cosine = (
                before_velocity[0] * after_velocity[0] + before_velocity[1] * after_velocity[1]
            ) / (before_speed * after_speed)
            direction_change = math.degrees(math.acos(max(-1.0, min(1.0, cosine))))
            if direction_change < HIT_MIN_DIRECTION_CHANGE_DEGREES or not _within_player_reach(contact):
                continue
            if any(abs(bounce - contact.time) <= HIT_BOUNCE_EXCLUSION_SECONDS for bounce in bounce_timestamps):
                continue
            candidates.append((contact, velocity_change))

    hits: list[BallSample] = []
    cluster: list[tuple[BallSample, float]] = []
    for candidate in sorted(candidates, key=lambda item: item[0].time):
        if cluster and candidate[0].time - cluster[-1][0].time > HIT_COOLDOWN_SECONDS:
            hits.append(max(cluster, key=lambda item: item[1])[0])
            cluster = []
        cluster.append(candidate)
    if cluster:
        hits.append(max(cluster, key=lambda item: item[1])[0])
    return [_contact_before_vanishing(_sharpen_hit(hit, samples, image_width), samples) for hit in hits]


def with_lost_players(frames: Sequence[dict]) -> list[dict]:
    """Shallow copies of the frames where a player missing for a moment is interpolated.

    Each side of the net is bridged between the detections around the loss; the frames
    themselves are left untouched, so the exported telemetry only holds what was detected.
    """
    anchors: dict[str, list[tuple[int, dict]]] = {"far": [], "near": []}
    present: list[set[str]] = []
    for position, frame in enumerate(frames):
        sides = set()
        for detection in frame["detections"]:
            if detection["class"] != "player" or _metric_position(detection) is None:
                continue
            side = side_of(detection["x_meters"])
            sides.add(side)
            if not detection.get("carried_forward") and not detection.get("interpolated"):
                anchors[side].append((position, detection))
        present.append(sides)

    views = [dict(frame, detections=list(frame["detections"])) for frame in frames]
    for side, points in anchors.items():
        for (start, before), (end, after) in zip(points, points[1:]):
            if (
                end - start < 2
                or frames[end]["timestamp_seconds"] - frames[start]["timestamp_seconds"] > HIT_LOST_PLAYER_MAX_SECONDS
            ):
                continue
            for position in range(start + 1, end):
                if side in present[position]:
                    continue
                weight = (position - start) / (end - start)
                views[position]["detections"].append({
                    **before,
                    "confidence": min(before["confidence"], after["confidence"]),
                    "bbox": [a + (b - a) * weight for a, b in zip(before["bbox"], after["bbox"])],
                    "x_meters": before["x_meters"] + (after["x_meters"] - before["x_meters"]) * weight,
                    "y_meters": before["y_meters"] + (after["y_meters"] - before["y_meters"]) * weight,
                    "interpolated": True,
                })
    return views


def detect_vanishing_strokes(
    frames: Sequence[dict],
    image_width: float,
    hits: Sequence[BallSample],
    bounces: Sequence[dict] = (),
) -> list[BallSample]:
    """Strokes after which the ball is not seen for a while and is next seen across the net.

    A struck serve or smash is too fast to be detected, so there is no motion after the contact
    to measure; the last sight of the falling ball at the server is the contact. A groundstroke
    can hide the ball behind the hitter's body just as well: a ball that has just bounced on the
    hitter's side and is next seen moving away from them was struck where it was last seen.
    """
    samples = collect_ball_samples(frames, HIT_MIN_BALL_CONFIDENCE)
    steps = sorted(b.time - a.time for a, b in zip(samples, samples[1:]) if b.time > a.time)
    if not steps:
        return []
    frame_seconds = steps[len(steps) // 2]
    strokes = []
    for position in range(len(samples) - 1):
        contact, reappeared = samples[position], samples[position + 1]
        gap = reappeared.time - contact.time
        if gap < GAP_MIN_FRAMES * frame_seconds or gap > GAP_MAX_SECONDS:
            continue
        if any(abs(hit.time - contact.time) <= HIT_COOLDOWN_SECONDS for hit in hits):
            continue
        hitter = _find_hitter(contact)
        landing = _metric_position(reappeared.ball)
        if hitter is None or landing is None or not _within_player_reach(contact):
            continue
        hitter_side = side_of(_metric_position(hitter)[0])
        above_head = contact.y < hitter["bbox"][1]
        # A fast serve is next seen landing across the net. A groundstroke is next seen in the
        # air, where the ground projection says little about the side, so its direction decides.
        if above_head and side_of(landing[0]) == hitter_side:
            continue
        falling = [
            sample for sample in samples[:position + 1]
            if 0 <= contact.time - sample.time <= KINK_WINDOW_SECONDS
        ]
        if len(falling) < KINK_MIN_WINDOW_SAMPLES:
            continue
        velocity = fit_velocity(falling)
        if above_head:
            if velocity[1] <= 0:
                continue
        elif not _struck_after_bounce(samples[position + 1:], velocity, contact, hitter_side, bounces):
            continue
        # A ball that merely went unseen for a few frames reappears where its fall was taking it.
        expected = (contact.x + velocity[0] * gap, contact.y + velocity[1] * gap)
        if math.hypot(reappeared.x - expected[0], reappeared.y - expected[1]) <= (
            image_width * VANISH_CONTINUATION_WIDTH_RATIO
        ):
            continue
        strokes.append(contact)
    return strokes


def _struck_after_bounce(
    following: Sequence[BallSample],
    incoming: tuple[float, float],
    contact: BallSample,
    hitter_side: str,
    bounces: Sequence[dict],
) -> bool:
    """Whether a ball lost at a player below their head was a groundstroke rather than a miss.

    The ball must have bounced on the hitter's side just before, been coming towards them, and
    reappear moving away from them: up the image from the near player, down it from the far one.
    """
    if not any(
        bounce["side"] == hitter_side and 0 < contact.time - bounce["timestamp_seconds"] <= RALLY_BOUNCE_SECONDS
        for bounce in bounces
    ):
        return False
    if not following:
        return False
    reappeared = following[0]
    leaving = [sample for sample in following if sample.time - reappeared.time <= KINK_WINDOW_SECONDS]
    if len(leaving) < KINK_MIN_WINDOW_SAMPLES:
        return False
    outgoing = fit_velocity(leaving)
    towards_hitter = 1 if hitter_side == "near" else -1
    return incoming[1] * towards_hitter > 0 and outgoing[1] * towards_hitter < 0


def _sharpen_hit(hit: BallSample, samples: Sequence[BallSample], image_width: float) -> BallSample:
    """The frame of a hit where short velocity windows on both sides differ most.

    The long windows that make detection robust also flatten the peak over several frames,
    so the contact is located again with short windows next to the first estimate.
    """
    trajectory = next(
        (
            trajectory for trajectory in split_trajectories(samples, image_width)
            if any(sample is hit for sample in trajectory)
        ),
        None,
    )
    if trajectory is None:
        return hit
    # Where the short windows see no clear contact, the first estimate stands.
    best = hit
    best_change = image_width * HIT_MIN_VELOCITY_CHANGE_WIDTHS_PER_SECOND * HIT_SHARPEN_MIN_CHANGE_RATIO
    for contact in trajectory:
        if abs(contact.time - hit.time) > HIT_SHARPEN_SECONDS or not _within_player_reach(contact):
            continue
        before = [s for s in trajectory if 0 <= contact.time - s.time <= KINK_WINDOW_SECONDS]
        after = [s for s in trajectory if 0 <= s.time - contact.time <= KINK_WINDOW_SECONDS]
        if len(before) < KINK_MIN_WINDOW_SAMPLES or len(after) < KINK_MIN_WINDOW_SAMPLES:
            continue
        before_velocity, after_velocity = fit_velocity(before), fit_velocity(after)
        change = math.hypot(after_velocity[0] - before_velocity[0], after_velocity[1] - before_velocity[1])
        if change > best_change:
            best, best_change = contact, change
    return best


def _contact_before_vanishing(hit: BallSample, samples: Sequence[BallSample]) -> BallSample:
    """The last sight of the ball at the player when it then vanishes, as after a fast serve.

    The motion measured on the way up of a serve toss can pass for the contact; the real one is
    the last frame the ball is seen at the racket before it leaves too fast to be detected. A
    toss rises from the player and falls back to the racket, while a ball already struck only
    moves away from them.
    """
    position = next(index for index, sample in enumerate(samples) if sample is hit)
    following = samples[position + 1:]
    if not following:
        return hit
    steps = sorted(b.time - a.time for a, b in zip(samples, samples[1:]) if b.time > a.time)
    frame_seconds = steps[len(steps) // 2]
    chain = [hit]
    for sample in following:
        if not _within_player_reach(sample):
            contact = chain[-1]
            vanished = sample.time - contact.time >= GAP_MIN_FRAMES * frame_seconds
            hitter = _find_hitter(contact)
            if not vanished or hitter is None or contact is hit:
                return hit
            box = hitter["bbox"]
            farthest = max(_distance_to_box(point, box) for point in chain)
            returned = farthest - _distance_to_box(contact, box)
            return contact if returned >= HIT_VANISH_MIN_RETURN_RATIO * (box[3] - box[1]) else hit
        if sample.time - hit.time > HIT_VANISH_WINDOW_SECONDS:
            return hit
        chain.append(sample)
    return hit


def _distance_to_box(sample: BallSample, box: Sequence[float]) -> float:
    return math.hypot(
        max(box[0] - sample.x, 0.0, sample.x - box[2]),
        max(box[1] - sample.y, 0.0, sample.y - box[3]),
    )


def _find_hitter(sample: BallSample) -> dict | None:
    best = None
    best_distance = math.inf
    for detection in sample.frame["detections"]:
        if detection["class"] != "player" or _metric_position(detection) is None:
            continue
        bbox = detection["bbox"]
        distance = math.hypot(
            max(bbox[0] - sample.x, 0.0, sample.x - bbox[2]),
            max(bbox[1] - sample.y, 0.0, sample.y - bbox[3]),
        )
        if distance < best_distance:
            best, best_distance = detection, distance
    return best


def estimate_ground_speed_kmh(frames: Sequence[dict], start: int) -> float | None:
    """Median speed of the ball's court projection right after a hit; overestimates high balls."""
    start_time = frames[start]["timestamp_seconds"]
    samples = []
    for frame in frames[start:]:
        if len(samples) > SPEED_SEGMENT_COUNT or frame["timestamp_seconds"] - start_time > SPEED_WINDOW_SECONDS:
            break
        ball = best_ball(frame, predicate=lambda detection: _metric_position(detection) is not None)
        if ball is not None:
            samples.append((frame["timestamp_seconds"], _metric_position(ball)))

    speeds = []
    for (previous_time, previous), (time, position) in zip(samples, samples[1:]):
        elapsed = time - previous_time
        if elapsed <= 0 or elapsed > SPEED_MAX_SEGMENT_GAP_SECONDS:
            continue
        speed = math.dist(previous, position) / elapsed * 3.6
        if speed <= MAX_PLAUSIBLE_SPEED_KMH:
            speeds.append(speed)
    if not speeds:
        return None
    speeds.sort()
    middle = len(speeds) // 2
    return speeds[middle] if len(speeds) % 2 else (speeds[middle - 1] + speeds[middle]) / 2


def _classify_groundstroke(side: str, handedness: str, ball_x: float, player_bbox: Sequence[float]) -> str:
    player_x = (player_bbox[0] + player_bbox[2]) / 2
    # Assumes a broadcast camera behind the near baseline: the near player shows their back, the far player faces it.
    ball_on_player_right = ball_x >= player_x if side == "near" else ball_x <= player_x
    return "forehand" if ball_on_player_right == (handedness == "right") else "backhand"


def classify_hits(
    frames: Sequence[dict],
    hit_samples: Sequence[BallSample],
    bounces: Sequence[dict],
    handedness: dict[str, str] | None = None,
) -> list[dict]:
    """Attribute each hit to a player and label it as serve, volley, forehand or backhand."""
    hands = {"far": "right", "near": "right", **(handedness or {})}
    hits: list[dict] = []
    point_index = -1

    for sample in sorted(hit_samples, key=lambda hit: hit.time):
        hitter = _find_hitter(sample)
        if hitter is None:
            continue
        player_x, player_y = _metric_position(hitter)
        player = side_of(player_x)
        previous = hits[-1] if hits else None
        # A ball that just bounced on the player's side is in play, however long since the
        # last hit that was seen: a point never starts with a bounce at the server's feet.
        in_play = any(
            bounce["side"] == player and 0 < sample.time - bounce["timestamp_seconds"] <= RALLY_BOUNCE_SECONDS
            for bounce in bounces
        )
        starts_point = previous is None or (
            sample.time - previous["timestamp_seconds"] > POINT_GAP_SECONDS and not in_play
        )
        if starts_point:
            point_index += 1

        behind_baseline = (
            player_x <= SERVE_BASELINE_TOLERANCE_METERS
            if player == "far"
            else player_x >= COURT_LENGTH_METERS - SERVE_BASELINE_TOLERANCE_METERS
        )
        if starts_point and behind_baseline:
            shot_type = "serve"
        elif (
            not starts_point
            and abs(player_x - NET_POSITION_METERS) <= VOLLEY_MAX_NET_DISTANCE_METERS
            and not any(
                previous["timestamp_seconds"] < bounce["timestamp_seconds"] < sample.time
                and bounce["side"] == player
                for bounce in bounces
            )
        ):
            shot_type = "volley"
        else:
            shot_type = _classify_groundstroke(player, hands[player], sample.x, hitter["bbox"])

        position = _metric_position(sample.ball)
        hits.append({
            "timestamp_seconds": sample.time,
            "frame_index": sample.frame["frame_index"],
            "player": player,
            "type": shot_type,
            "speed_kmh": estimate_ground_speed_kmh(frames, sample.frame_position),
            "point_index": point_index,
            "ball": {
                "x": position[0] if position else None,
                "y": position[1] if position else None,
                "z": None,
            },
            "player_position": {"x": player_x, "y": player_y},
            "confidence": CONFIDENCE_IMAGE_ONLY,
        })
    return hits


def build_cameras(
    frames: Sequence[dict],
    image_size: tuple[int, int],
) -> list[Camera | None]:
    """One camera per frame, sharing the median focal length of the whole video."""
    corner_sets = [
        tuple(tuple(corner) for corner in frame["court_corners"]) if frame.get("court_corners") else None
        for frame in frames
    ]
    focal_lengths = sorted(
        focal
        for focal in (
            estimate_focal_length(corners, image_size)
            for corners in corner_sets
            if corners is not None
        )
        if focal is not None
    )
    if not focal_lengths:
        return [None] * len(frames)
    focal = focal_lengths[len(focal_lengths) // 2]
    cache: dict[tuple, Camera | None] = {}
    cameras = []
    for corners in corner_sets:
        if corners is None:
            cameras.append(None)
            continue
        if corners not in cache:
            cache[corners] = estimate_camera(corners, image_size, focal)
        cameras.append(cache[corners])
    return cameras


def reconstruct_flights(
    frames: Sequence[dict],
    cameras: Sequence[Camera | None],
    image_width: float,
    bounces: Sequence[dict],
    hits: Sequence[dict],
) -> list[tuple[Flight, list[BallSample], Contact | None, Contact | None]]:
    """Fit a 3D flight to each stretch of ball samples between consecutive events."""
    contacts = sorted(
        [Contact("bounce", bounce["timestamp_seconds"]) for bounce in bounces]
        + [Contact("hit", hit["timestamp_seconds"], hit["player_position"]["x"]) for hit in hits],
        key=lambda contact: contact.time,
    )
    flights = []
    for trajectory in split_trajectories(collect_ball_samples(frames), image_width):
        inside = [
            contact for contact in contacts
            if trajectory[0].time <= contact.time <= trajectory[-1].time
        ]
        bounds = [None, *inside, None]
        landing_state = None
        for start, end in zip(bounds, bounds[1:]):
            if start is not None and start.kind == "bounce" and landing_state is not None:
                start = replace(start, landing_state=landing_state)
            landing_state = None
            samples = [
                sample for sample in trajectory
                if (start is None or sample.time >= start.time)
                and (end is None or sample.time < end.time)
            ]
            if not samples:
                continue
            # Without a bounce or a hit to pin its depth, only a long stretch constrains the fit.
            if start is None and end is None and (
                len(samples) < MIN_UNANCHORED_FLIGHT_SAMPLES
                or samples[-1].time - samples[0].time < MIN_UNANCHORED_FLIGHT_SECONDS
            ):
                continue
            flight = fit_flight(
                samples,
                [cameras[sample.frame_position] for sample in samples],
                image_width,
                start,
                end,
            )
            if flight is not None:
                flights.append((flight, samples, start, end))
                if end is not None and end.kind == "bounce":
                    landing_state = flight.state_at(end.time)
    return flights


def fill_flight_gaps(
    frames: Sequence[dict],
    cameras: Sequence[Camera | None],
    image_size: tuple[int, int],
    flights: Sequence[tuple[Flight, list[BallSample], Contact | None, Contact | None]],
) -> None:
    """Place the ball where its fitted flight says it was in the frames it was not seen in.

    The flight obeys gravity and drag and is pinned by the measurements on both sides of the
    gap, so this is a better estimate than the image interpolation it replaces.
    """
    for flight, samples, _, _ in flights:
        widths = sorted(sample.ball["bbox"][2] - sample.ball["bbox"][0] for sample in samples)
        heights = sorted(sample.ball["bbox"][3] - sample.ball["bbox"][1] for sample in samples)
        half_width, half_height = widths[len(widths) // 2] / 2, heights[len(heights) // 2] / 2
        first = samples[0].frame_position
        while first > 0 and frames[first - 1]["timestamp_seconds"] >= flight.start_time:
            first -= 1
        last = samples[-1].frame_position
        while last + 1 < len(frames) and frames[last + 1]["timestamp_seconds"] <= flight.end_time:
            last += 1
        for position in range(first, last + 1):
            frame = frames[position]
            time = frame["timestamp_seconds"]
            camera = cameras[position]
            if (
                camera is None
                or not flight.start_time <= time <= flight.end_time
                or best_ball(frame) is not None
            ):
                continue
            x, y, z = flight.position_at(time)
            pixel = camera.project((x, y, max(0.0, z)))
            if pixel is None or not (0 <= pixel[0] < image_size[0] and 0 <= pixel[1] < image_size[1]):
                continue
            estimate = next(
                (
                    detection for detection in frame["detections"]
                    if detection["class"] == "ball" and detection.get("interpolated")
                ),
                None,
            )
            if estimate is None:
                estimate = {"class": "ball"}
                frame["detections"].append(estimate)
            estimate.update({
                "confidence": FLIGHT_BALL_CONFIDENCE,
                "bbox": [
                    pixel[0] - half_width,
                    pixel[1] - half_height,
                    pixel[0] + half_width,
                    pixel[1] + half_height,
                ],
                "x_meters": x,
                "y_meters": y,
                "z_meters": max(0.0, z),
                "interpolated": True,
                "source": "flight3d",
            })


def bounce_is_physical(landing: Flight, leaving: Flight, time: float) -> bool:
    """Whether two flights meeting at `time` look like one ball bouncing off the ground."""
    x_in, y_in, _, vx_in, vy_in, vz_in = landing.state_at(time)
    x_out, y_out, _, vx_out, vy_out, vz_out = leaving.state_at(time)
    if math.hypot(x_out - x_in, y_out - y_in) > BOUNCE_MAX_FLIGHT_DISAGREEMENT_METERS:
        return False
    if vz_in >= 0 or not BOUNCE_MIN_RESTITUTION <= vz_out / -vz_in <= BOUNCE_MAX_RESTITUTION:
        return False
    if vx_in * vx_out + vy_in * vy_out <= 0:
        return False
    if math.hypot(vx_out, vy_out) > BOUNCE_MAX_SPEED_GAIN * math.hypot(vx_in, vy_in):
        return False
    return (
        -BOUNCE_OUT_MARGIN_METERS <= x_in <= COURT_LENGTH_METERS + BOUNCE_OUT_MARGIN_METERS
        and -BOUNCE_OUT_MARGIN_METERS <= y_in <= COURT_WIDTH_METERS + BOUNCE_OUT_MARGIN_METERS
    )


def _racket_can_reach(camera: Camera | None, sample: BallSample) -> bool:
    """Whether a player close to the ball on screen could also reach it on court.

    A ball landing a few meters in front of the far player overlaps them on screen; only the
    camera ray through it tells the bounce apart from a stroke.
    """
    for detection in sample.frame["detections"]:
        if detection["class"] != "player":
            continue
        left, top, right, bottom = detection["bbox"]
        reach = max(HIT_MIN_PLAYER_REACH_PIXELS, (bottom - top) * HIT_PLAYER_REACH_HEIGHT_RATIO)
        if not (left - reach <= sample.x <= right + reach and top - reach <= sample.y <= bottom + reach):
            continue
        if _metric_position(detection) is None or _ray_reaches_player(camera, sample, detection):
            return True
    return False


def detect_bounce_kinks(
    trajectories: Sequence[Sequence[BallSample]],
    image_width: float,
    event_timestamps: Sequence[float],
    cameras: Sequence[Camera | None] | None = None,
) -> list[BallSample]:
    """Samples where the image velocity jumps upwards away from players and known events.

    With `cameras`, a player counts as close only when the ball can be within their reach on court.
    """
    threshold = image_width * KINK_MIN_UPWARD_IMPULSE_WIDTHS_PER_SECOND
    kinks: list[BallSample] = []
    for trajectory in trajectories:
        candidates: list[tuple[BallSample, float]] = []
        for contact in trajectory:
            before = [
                sample for sample in trajectory
                if 0 <= contact.time - sample.time <= KINK_WINDOW_SECONDS
            ]
            after = [
                sample for sample in trajectory
                if 0 <= sample.time - contact.time <= KINK_WINDOW_SECONDS
            ]
            if len(before) < KINK_MIN_WINDOW_SAMPLES or len(after) < KINK_MIN_WINDOW_SAMPLES:
                continue
            impulse = fit_velocity(before)[1] - fit_velocity(after)[1]
            if (
                impulse < threshold
                or (
                    _within_player_reach(contact)
                    if cameras is None
                    else _racket_can_reach(cameras[contact.frame_position], contact)
                )
                or _center_inside_player(contact)
                or any(abs(time - contact.time) <= KINK_EVENT_EXCLUSION_SECONDS for time in event_timestamps)
            ):
                continue
            candidates.append((contact, impulse))

        cluster: list[tuple[BallSample, float]] = []
        for candidate in candidates:
            if cluster and candidate[0].time - cluster[-1][0].time > KINK_EVENT_EXCLUSION_SECONDS:
                kinks.append(max(cluster, key=lambda item: item[1])[0])
                cluster = []
            cluster.append(candidate)
        if cluster:
            kinks.append(max(cluster, key=lambda item: item[1])[0])
    return kinks


def confirm_bounce_kinks(
    frames: Sequence[dict],
    cameras: Sequence[Camera | None],
    image_width: float,
    bounces: Sequence[dict],
    hits: Sequence[dict],
) -> list[dict]:
    """Bounces without an image reversal, accepted only when 3D flights on both sides agree."""
    trajectories = split_trajectories(collect_ball_samples(frames), image_width)
    contacts = sorted(
        [Contact("bounce", bounce["timestamp_seconds"]) for bounce in bounces]
        + [Contact("hit", hit["timestamp_seconds"], hit["player_position"]["x"]) for hit in hits],
        key=lambda contact: contact.time,
    )
    steps = sorted(
        later.time - earlier.time
        for trajectory in trajectories
        for earlier, later in zip(trajectory, trajectory[1:])
    )
    median_frame_seconds = steps[len(steps) // 2] if steps else 0.0
    confirmed = []
    for kink in detect_bounce_kinks(trajectories, image_width, [contact.time for contact in contacts], cameras):
        trajectory = next(
            trajectory for trajectory in trajectories
            if trajectory[0].time <= kink.time <= trajectory[-1].time
        )
        start = next(
            (other for other in reversed(contacts) if trajectory[0].time <= other.time < kink.time),
            None,
        )
        end = next(
            (other for other in contacts if kink.time < other.time <= trajectory[-1].time),
            None,
        )
        previous_time = max(
            (sample.time for sample in trajectory if sample.time < kink.time),
            default=kink.time,
        )
        frame_seconds = kink.time - previous_time

        def fit_bounce(
            start: Contact | None,
            end: Contact | None,
            first_time: float = -math.inf,
            last_time: float = math.inf,
        ) -> tuple[float, Contact, Flight] | None:
            seen = [
                sample for sample in trajectory
                if first_time <= sample.time <= last_time
                and (start is None or sample.time >= start.time)
                and (end is None or sample.time < end.time)
            ]
            # The contact falls between two frames, and a short flight fitted from the wrong
            # instant can settle on a mirrored depth, so nearby instants compete.
            best = None
            for offset in KINK_TIME_OFFSETS_FRAMES:
                contact = Contact("bounce", kink.time + offset * frame_seconds)
                before = [sample for sample in seen if sample.time < contact.time]
                after = [sample for sample in seen if sample.time >= contact.time]
                landing = fit_flight(
                    before, [cameras[sample.frame_position] for sample in before], image_width, start, contact
                )
                if landing is None:
                    continue
                leaving = fit_flight(
                    after,
                    [cameras[sample.frame_position] for sample in after],
                    image_width,
                    replace(contact, landing_state=landing.state_at(contact.time)),
                    end,
                )
                if leaving is None or not bounce_is_physical(landing, leaving, contact.time):
                    continue
                error = math.sqrt(
                    (len(before) * landing.rms_pixels ** 2 + len(after) * leaving.rms_pixels ** 2)
                    / (len(before) + len(after))
                )
                if best is None or error < best[0]:
                    best = (error, contact, landing)
            if best is None:
                return None
            uninterrupted = fit_flight(seen, [cameras[sample.frame_position] for sample in seen], image_width, start, end)
            if uninterrupted is not None and uninterrupted.rms_pixels <= (
                KINK_MIN_SINGLE_FLIGHT_ERROR_RATIO * best[0] + KINK_SINGLE_FLIGHT_ERROR_MARGIN_PIXELS
            ):
                return None
            return best

        best = fit_bounce(start, end)
        if best is None:
            # A racket can strike the ball while it is unseen, and the detector often loses the
            # player at the stroke, so a missed hit can join two flights on either side of the
            # kink. The bounce is then fitted only to the ball seen without interruption since
            # its last long gap and over a short stretch after it.
            unseen_since = max(
                (
                    later.time for earlier, later in zip(trajectory, trajectory[1:])
                    if later.time <= kink.time
                    and later.time - earlier.time >= KINK_UNSEEN_GAP_FRAMES * median_frame_seconds
                ),
                default=-math.inf,
            )
            last_time = kink.time + KINK_SEEN_AFTER_SECONDS
            trimmed_start = start if start is None or start.time >= unseen_since else None
            trimmed_end = end if end is not None and end.time <= last_time else None
            if trimmed_start is not start or trimmed_end is not end or (
                end is None and trajectory[-1].time > last_time
            ):
                best = fit_bounce(trimmed_start, trimmed_end, unseen_since, last_time)
        if best is None and start is not None and start.kind == "hit":
            # Heavy spin bends a stroke away from the drag-only model, which then cannot also
            # start the flight at the racket; the ball's own path still shows where it landed.
            best = fit_bounce(None, end, first_time=start.time) or fit_bounce(
                None, None, first_time=start.time, last_time=kink.time + KINK_SEEN_AFTER_SECONDS
            )
        if best is None:
            continue
        error, contact, landing = best
        x_meters, y_meters, _ = landing.position_at(contact.time)
        confirmed.append({
            "timestamp_seconds": contact.time,
            "frame_index": kink.frame["frame_index"],
            "x_meters": x_meters,
            "y_meters": y_meters,
            "side": side_of(x_meters),
            "confidence": CONFIDENCE_TWO_FLIGHTS,
            "method": "fit3d",
        })
        contacts = sorted([*contacts, contact], key=lambda other: other.time)
    return confirmed


def _sample_at_frame(samples: Sequence[BallSample], frame_index: int) -> BallSample | None:
    return next((sample for sample in samples if sample.frame["frame_index"] == frame_index), None)


def _ray_reaches_player(camera: Camera | None, sample: BallSample, player: dict) -> bool:
    """Whether the ball, wherever it is along its camera ray, can be within a player's reach."""
    if camera is None:
        return True
    player_x, player_y = _metric_position(player)
    steps = round(CONTACT_MAX_HEIGHT_METERS / REACH_HEIGHT_STEP_METERS)
    for step in range(steps + 1):
        point = camera.backproject(sample.x, sample.y, step * REACH_HEIGHT_STEP_METERS)
        if point is not None and math.hypot(point[0] - player_x, point[1] - player_y) <= PLAYER_REACH_METERS:
            return True
    return False


def reversal_is_hit(
    frames: Sequence[dict],
    cameras: Sequence[Camera | None],
    image_width: float,
    bounce: dict,
) -> bool:
    """Whether an image reversal next to a player was the racket rather than the ground."""
    samples = collect_ball_samples(frames)
    sample = _sample_at_frame(samples, bounce["frame_index"])
    if sample is None or not _within_player_reach(sample):
        return False
    time = bounce["timestamp_seconds"]
    trajectory = next(
        (
            trajectory for trajectory in split_trajectories(samples, image_width)
            if trajectory[0].time <= time <= trajectory[-1].time
        ),
        None,
    )
    hitter = _find_hitter(sample)
    # With the camera behind the near baseline, a stroke by the far player turns the ball from
    # moving up the image to moving down it, the opposite of a bounce, so only the near player's
    # strokes can pass for one.
    if trajectory is None or hitter is None or side_of(_metric_position(hitter)[0]) != "near":
        return False
    # Close on screen is not close on court: the racket has to reach the ball somewhere along
    # the camera ray through it, at a height a stroke can be played at.
    if not _ray_reaches_player(cameras[sample.frame_position], sample, hitter):
        return False

    # A serve toss falls slowly above the server's head and leaves several times faster;
    # a bounce never speeds the ball up like that.
    toss_before = [s for s in trajectory if 0 < time - s.time <= KINK_WINDOW_SECONDS]
    toss_after = [s for s in trajectory if 0 <= s.time - time <= KINK_WINDOW_SECONDS]
    if (
        sample.y < hitter["bbox"][1]
        and len(toss_before) >= KINK_MIN_WINDOW_SAMPLES
        and len(toss_after) >= KINK_MIN_WINDOW_SAMPLES
        and math.hypot(*fit_velocity(toss_after))
        >= TOSS_MIN_SPEED_RATIO * math.hypot(*fit_velocity(toss_before))
    ):
        return True

    # Otherwise the reversal is fitted as a bounce. A slow ball leaves its depth loosely
    # constrained, so only a clear turn back along the court gives the racket away: the
    # ball often just overlaps a player on screen while it lands far behind them.
    before = [s for s in trajectory if time - REVERSAL_WINDOW_SECONDS <= s.time < time]
    after = [s for s in trajectory if time <= s.time <= time + REVERSAL_WINDOW_SECONDS]
    ground = Contact("bounce", time)
    landing = fit_flight(before, [cameras[s.frame_position] for s in before], image_width, None, ground)
    leaving = fit_flight(after, [cameras[s.frame_position] for s in after], image_width, ground, None)
    if landing is None or leaving is None:
        return False
    incoming = landing.state_at(time)[3]
    outgoing = leaving.state_at(time)[3]
    if incoming * outgoing >= 0 or min(abs(incoming), abs(outgoing)) < REVERSAL_MIN_SPEED_METERS_PER_SECOND:
        return False
    # Read as a stroke by the near player instead, the ball has to leave towards the far side
    # at a stroke's pace; a ball drifting back towards the camera was not hit by them.
    return _sent_towards_opponent(after, cameras, image_width, time, hitter) is not False


def _sent_towards_opponent(
    after: Sequence[BallSample],
    cameras: Sequence[Camera | None],
    image_width: float,
    time: float,
    hitter: dict,
) -> bool | None:
    """Whether a stroke at `time` sends the ball to the other side; None when it cannot be told."""
    stroke = fit_flight(
        after,
        [cameras[s.frame_position] for s in after],
        image_width,
        Contact("hit", time, _metric_position(hitter)[0]),
        None,
    )
    if stroke is None:
        return None
    towards_far = stroke.state_at(time)[3] <= -STROKE_MIN_SPEED_METERS_PER_SECOND
    towards_near = stroke.state_at(time)[3] >= STROKE_MIN_SPEED_METERS_PER_SECOND
    return towards_far if side_of(_metric_position(hitter)[0]) == "near" else towards_near


def stroke_is_plausible(
    frames: Sequence[dict],
    cameras: Sequence[Camera | None],
    image_width: float,
    hit: BallSample,
) -> bool:
    """A racket sends the ball towards the opponent; a ball drifting back is something else."""
    hitter = _find_hitter(hit)
    if hitter is None:
        return True
    trajectory = next(
        (
            trajectory for trajectory in split_trajectories(collect_ball_samples(frames), image_width)
            if trajectory[0].time <= hit.time <= trajectory[-1].time
        ),
        None,
    )
    if trajectory is None:
        return True
    after = [s for s in trajectory if hit.time <= s.time <= hit.time + REVERSAL_WINDOW_SECONDS]
    return _sent_towards_opponent(after, cameras, image_width, hit.time, hitter) is not False


def detect_gap_bounces(
    frames: Sequence[dict],
    cameras: Sequence[Camera | None],
    image_width: float,
    bounces: Sequence[dict],
    hits: Sequence[dict],
) -> list[dict]:
    """Bounces hidden in a stretch of frames where the ball was not seen."""
    samples = collect_ball_samples(frames)
    if len(samples) < 2:
        return []
    steps = sorted(b.time - a.time for a, b in zip(samples, samples[1:]) if b.time > a.time)
    frame_seconds = steps[len(steps) // 2] if steps else 0.0
    if frame_seconds <= 0:
        return []
    contacts = sorted(
        [Contact("bounce", bounce["timestamp_seconds"]) for bounce in bounces]
        + [Contact("hit", hit["timestamp_seconds"], hit["player_position"]["x"]) for hit in hits],
        key=lambda contact: contact.time,
    )
    hits_by_time = sorted(hits, key=lambda hit: hit["timestamp_seconds"])
    found: list[dict] = []

    for position in range(len(samples) - 1):
        last_seen, reappeared = samples[position], samples[position + 1]
        gap = reappeared.time - last_seen.time
        if gap < GAP_MIN_FRAMES * frame_seconds or gap > GAP_MAX_SECONDS:
            continue
        # The ball often vanishes right at a contact (a serve leaves too fast to be seen), so
        # only a contact inside the gap or where the ball is seen again rules it out.
        if any(
            last_seen.time < contact.time <= reappeared.time + GAP_EVENT_EXCLUSION_SECONDS
            for contact in contacts
        ):
            continue
        if not _inside_court(reappeared.ball) or _within_player_reach(reappeared):
            continue
        last_hit = next(
            (hit for hit in reversed(hits_by_time) if hit["timestamp_seconds"] <= last_seen.time),
            None,
        )
        receiver_side = _metric_position(reappeared.ball)
        if last_hit is None or side_of(receiver_side[0]) == last_hit["player"]:
            continue
        next_hit = next(
            (hit for hit in hits_by_time if hit["timestamp_seconds"] > reappeared.time),
            None,
        )
        reply_time = next_hit["timestamp_seconds"] if next_hit is not None else math.inf
        if any(
            last_hit["timestamp_seconds"] < contact.time < reply_time and contact.kind == "bounce"
            for contact in contacts
        ):
            continue

        start = next((c for c in reversed(contacts) if c.time <= last_seen.time), None)
        end = next((c for c in contacts if c.time >= reappeared.time), None)
        after = [reappeared]
        for sample in samples[position + 2:]:
            if (
                sample.time - after[-1].time > GAP_MAX_SAMPLE_STEP_SECONDS
                or sample.time - reappeared.time > GAP_AFTER_WINDOW_SECONDS
                or (end is not None and sample.time >= end.time)
            ):
                break
            after.append(sample)
        if len(after) < GAP_MIN_AFTER_SAMPLES:
            continue
        end = end if end is not None and end.time <= after[-1].time + GAP_MAX_SAMPLE_STEP_SECONDS else None
        before = [
            sample for sample in samples[:position + 1]
            if last_seen.time - sample.time <= GAP_BEFORE_WINDOW_SECONDS
            and (start is None or sample.time >= start.time)
        ]
        before_start = start if start is not None and before and start.time <= before[0].time else None
        after_cameras = [cameras[sample.frame_position] for sample in after]
        before_cameras = [cameras[sample.frame_position] for sample in before]

        # When the ball before and after the gap is one flight, nothing happened in between.
        joined = fit_flight(before + after, before_cameras + after_cameras, image_width, before_start, end)
        if joined is not None:
            continue

        def plausible(flight: Flight, time: float) -> tuple[float, float] | None:
            x_meters, y_meters, _ = flight.position_at(time)
            if (
                flight.state[5] < GAP_MIN_LAUNCH_VERTICAL_SPEED
                or side_of(x_meters) == last_hit["player"]
                or not -BOUNCE_OUT_MARGIN_METERS <= x_meters <= COURT_LENGTH_METERS + BOUNCE_OUT_MARGIN_METERS
                or not -BOUNCE_OUT_MARGIN_METERS <= y_meters <= COURT_WIDTH_METERS + BOUNCE_OUT_MARGIN_METERS
            ):
                return None
            return x_meters, y_meters

        def fit_leaving(contact: Contact) -> Flight | None:
            # The next hit only hints at the depth; a fast ball fitted short of it can disagree.
            return (
                fit_flight(after, after_cameras, image_width, contact, end)
                or (fit_flight(after, after_cameras, image_width, contact, None) if end is not None else None)
            )

        # With the ball seen on its way down, the bounce is the instant where a flight landing
        # there and one leaving from there agree; both are fitted freely and then checked.
        best = None
        steps_in_gap = max(1, round(gap / frame_seconds))
        for step in range(1, steps_in_gap + 1):
            contact = Contact("bounce", last_seen.time + gap * step / steps_in_gap)
            landing = fit_flight(before, before_cameras, image_width, before_start, contact)
            leaving = fit_leaving(contact)
            if landing is None or leaving is None or not bounce_is_physical(landing, leaving, contact.time):
                continue
            position = plausible(leaving, contact.time)
            if position is None:
                continue
            error = math.sqrt(
                (len(before) * landing.rms_pixels ** 2 + len(after) * leaving.rms_pixels ** 2)
                / (len(before) + len(after))
            )
            if best is None or error < best[0]:
                best = (error, contact, *position, True)

        # Unseen all the way down, a single flight cannot tell when it left the ground: any
        # instant in the gap fits. The ball is then placed where it is seen again, which is
        # right after the bounce when nothing of its descent was visible.
        if best is None:
            contact = Contact("bounce", reappeared.time)
            leaving = fit_leaving(contact)
            position = None if leaving is None else plausible(leaving, contact.time)
            if position is not None:
                best = (leaving.rms_pixels, contact, *position, False)
        if best is None:
            continue
        _, contact, x_meters, y_meters, physical = best
        frame = min(frames, key=lambda other: abs(other["timestamp_seconds"] - contact.time))
        found.append({
            "timestamp_seconds": contact.time,
            "frame_index": frame["frame_index"],
            "x_meters": x_meters,
            "y_meters": y_meters,
            "side": side_of(x_meters),
            "confidence": CONFIDENCE_TWO_FLIGHTS if physical else CONFIDENCE_ONE_FLIGHT,
            "method": "fit3d",
        })
        contacts = sorted([*contacts, contact], key=lambda other: other.time)
    return found


def _contact_point(camera: Camera | None, sample: BallSample, player: dict) -> tuple[float, float, float] | None:
    """Where along the camera ray through the ball it passes closest above the hitter's feet."""
    if camera is None:
        return None
    player_x, player_y = player["x"], player["y"]
    best = None
    steps = round(CONTACT_MAX_HEIGHT_METERS / REACH_HEIGHT_STEP_METERS)
    for step in range(steps + 1):
        height = step * REACH_HEIGHT_STEP_METERS
        point = camera.backproject(sample.x, sample.y, height)
        if point is None:
            continue
        distance = math.hypot(point[0] - player_x, point[1] - player_y)
        if distance <= PLAYER_REACH_METERS and (best is None or distance < best[0]):
            best = (distance, (point[0], point[1], height))
    return None if best is None else best[1]


def _speed_to_next_bounce(
    hit: dict,
    sample: BallSample,
    camera: Camera | None,
    bounces: Sequence[dict],
    hits: Sequence[dict],
) -> tuple[float, tuple[float, float, float]] | None:
    """Launch speed (km/h) and contact point of a ball too fast to be seen until it bounced.

    A fast serve is not detected between the racket and the ground, so no flight can be fitted
    to it; the contact and the bounce across the net pin the flight down instead. The bounce is
    placed where the ball is seen again, at or after the real one, so the speed errs low.
    """
    time = hit["timestamp_seconds"]
    bounce = min(
        (bounce for bounce in bounces if bounce["timestamp_seconds"] > time),
        key=lambda bounce: bounce["timestamp_seconds"],
        default=None,
    )
    if (
        bounce is None
        or bounce["side"] == hit["player"]
        or bounce["timestamp_seconds"] - time > GAP_MAX_SECONDS + HIT_VELOCITY_WINDOW_SECONDS
        or any(time < other["timestamp_seconds"] < bounce["timestamp_seconds"] for other in hits)
    ):
        return None
    contact = _contact_point(camera, sample, hit["player_position"])
    if contact is None:
        return None
    velocity = launch_velocity(
        contact, (bounce["x_meters"], bounce["y_meters"], 0.0), bounce["timestamp_seconds"] - time
    )
    if velocity is None:
        return None
    speed = math.hypot(*velocity) * 3.6
    return (speed, contact) if speed <= MAX_PLAUSIBLE_SPEED_KMH else None


def build_events(
    frames: list[dict],
    image_width: int,
    image_height: int,
    handedness: dict[str, str] | None = None,
) -> dict:
    """Detect bounces and hits and write the reconstructed ball height into the frames."""
    for frame in frames:
        for detection in frame["detections"]:
            if detection["class"] == "ball":
                detection.setdefault("z_meters", None)
    if not frames or not image_width or not image_height:
        return {"bounces": [], "hits": []}

    cameras = build_cameras(frames, (image_width, image_height))
    # Hits, and reversals that may be hits, are judged with the players the detector lost at
    # the stroke put back; the frames themselves keep only what was detected.
    hit_frames = with_lost_players(frames)
    bounces = [
        bounce for bounce in detect_bounces(frames, image_width, image_height)
        if not reversal_is_hit(hit_frames, cameras, image_width, bounce)
    ]
    hit_samples = [
        hit for hit in detect_hits(hit_frames, image_width, [bounce["timestamp_seconds"] for bounce in bounces])
        if stroke_is_plausible(hit_frames, cameras, image_width, hit)
    ]
    hit_samples = sorted(
        hit_samples + detect_vanishing_strokes(hit_frames, image_width, hit_samples, bounces),
        key=lambda hit: hit.time,
    )
    hits = classify_hits(frames, hit_samples, bounces, handedness)

    gap_bounces = detect_gap_bounces(frames, cameras, image_width, bounces, hits)
    if gap_bounces:
        bounces = sorted(bounces + gap_bounces, key=lambda bounce: bounce["timestamp_seconds"])
    extra_bounces = confirm_bounce_kinks(frames, cameras, image_width, bounces, hits)
    if extra_bounces:
        bounces = sorted(bounces + extra_bounces, key=lambda bounce: bounce["timestamp_seconds"])
    # A groundstroke hidden behind the hitter is told by the bounce before it, which the gap
    # and kink detectors above may only just have found.
    hidden_strokes = (
        detect_vanishing_strokes(hit_frames, image_width, hit_samples, bounces)
        if gap_bounces or extra_bounces
        else []
    )
    if hidden_strokes:
        hit_samples = sorted(hit_samples + hidden_strokes, key=lambda hit: hit.time)
    if gap_bounces or extra_bounces:
        # Volleys are told apart from groundstrokes by the bounces between two hits.
        hits = classify_hits(frames, hit_samples, bounces, handedness)
    flights = reconstruct_flights(frames, cameras, image_width, bounces, hits)

    for bounce in bounces:
        time = bounce["timestamp_seconds"]
        landing = [flight for flight, _, _, end in flights if end is not None and end.kind == "bounce" and end.time == time]
        leaving = [flight for flight, _, start, _ in flights if start is not None and start.kind == "bounce" and start.time == time]
        positions = [flight.position_at(time) for flight in landing + leaving]
        if positions:
            bounce["x_meters"] = sum(position[0] for position in positions) / len(positions)
            bounce["y_meters"] = sum(position[1] for position in positions) / len(positions)
            bounce["side"] = side_of(bounce["x_meters"])
            bounce["method"] = "fit3d"
            bounce["confidence"] = (
                CONFIDENCE_TWO_FLIGHTS
                if landing and leaving and bounce_is_physical(landing[0], leaving[0], time)
                else CONFIDENCE_ONE_FLIGHT
            )

    flown = set()
    for hit in hits:
        time = hit["timestamp_seconds"]
        leaving = next(
            (flight for flight, _, start, _ in flights if start is not None and start.kind == "hit" and start.time == time),
            None,
        )
        arriving = next(
            (flight for flight, _, _, end in flights if end is not None and end.kind == "hit" and end.time == time),
            None,
        )
        flight = leaving or arriving
        if flight is None:
            continue
        x, y, z = flight.position_at(time)
        hit["ball"] = {"x": x, "y": y, "z": max(0.0, z)}
        hit["confidence"] = CONFIDENCE_TWO_FLIGHTS if leaving and arriving else CONFIDENCE_ONE_FLIGHT
        # A flight that is not pinned down by a later bounce or hit has an unreliable depth.
        if leaving is not None and leaving.bounded_end:
            speed = leaving.speed_at(time) * 3.6
            if speed <= MAX_PLAUSIBLE_SPEED_KMH:
                hit["speed_kmh"] = speed
                flown.add(id(hit))

    # Without a flight leaving the racket, the speed would come from the ground projection of a
    # ball in the air; the contact and the bounce that follows it pin the flight down better.
    for hit in hits:
        if id(hit) in flown:
            continue
        sample = next((sample for sample in hit_samples if sample.time == hit["timestamp_seconds"]), None)
        if sample is None:
            continue
        estimate = _speed_to_next_bounce(hit, sample, cameras[sample.frame_position], bounces, hits)
        if estimate is not None:
            hit["speed_kmh"], contact = estimate
            if hit["ball"]["z"] is None:
                hit["ball"] = {"x": contact[0], "y": contact[1], "z": contact[2]}
                hit["confidence"] = CONFIDENCE_ONE_FLIGHT

    # Ground projections are replaced last: the 2D speed fallback above relies on them.
    for flight, samples, _, _ in flights:
        for sample in samples:
            x, y, z = flight.position_at(sample.time)
            sample.ball["x_meters"] = x
            sample.ball["y_meters"] = y
            sample.ball["z_meters"] = max(0.0, z)
    fill_flight_gaps(frames, cameras, (image_width, image_height), flights)

    return {"bounces": bounces, "hits": hits}

