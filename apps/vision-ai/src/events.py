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
    BallSample,
    Contact,
    Flight,
    best_ball,
    collect_ball_samples,
    fit_flight,
    fit_velocity,
    is_finite_number,
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
HIT_PLAYER_REACH_HEIGHT_RATIO = 0.4
HIT_MIN_PLAYER_REACH_PIXELS = 28
HIT_COOLDOWN_SECONDS = 0.5
HIT_BOUNCE_EXCLUSION_SECONDS = 0.1

SPEED_SEGMENT_COUNT = 3
SPEED_WINDOW_SECONDS = 0.25
SPEED_MAX_SEGMENT_GAP_SECONDS = 0.12
MAX_PLAUSIBLE_SPEED_KMH = 265
POINT_GAP_SECONDS = 4
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
BOUNCE_SIDEWAYS_DEADBAND_RATIO = 0.003
BOUNCE_MAX_FLIGHT_DISAGREEMENT_METERS = 1.0
BOUNCE_MIN_RESTITUTION = 0.3
BOUNCE_MAX_RESTITUTION = 1.1
BOUNCE_MAX_SPEED_GAIN = 1.1
BOUNCE_OUT_MARGIN_METERS = 3.0

MIN_UNANCHORED_FLIGHT_SAMPLES = 10
MIN_UNANCHORED_FLIGHT_SECONDS = 0.4

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
    samples = collect_ball_samples(frames, predicate=_inside_court)
    bounces: list[dict] = []
    rise_threshold = max(2.0, image_height * BOUNCE_MIN_RISE_RATIO)
    sideways_threshold = max(12.0, image_width * BOUNCE_MAX_SIDEWAYS_DEVIATION_RATIO)
    sideways_deadband = image_width * BOUNCE_SIDEWAYS_DEADBAND_RATIO

    for trajectory in split_trajectories(samples, image_width, vertical=lambda sample: sample.bottom):
        for index in range(2, len(trajectory) - 2):
            candidate = trajectory[index]
            previous, following = trajectory[index - 1], trajectory[index + 1]
            if candidate.bottom <= previous.bottom or candidate.bottom < following.bottom:
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
    for detection in sample.frame["detections"]:
        if detection["class"] != "player" or detection.get("carried_forward"):
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
    return hits


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
        starts_point = previous is None or sample.time - previous["timestamp_seconds"] > POINT_GAP_SECONDS
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


def detect_bounce_kinks(
    trajectories: Sequence[Sequence[BallSample]],
    image_width: float,
    event_timestamps: Sequence[float],
) -> list[BallSample]:
    """Samples where the image velocity jumps upwards away from players and known events."""
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
                or _within_player_reach(contact)
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
    confirmed = []
    for kink in detect_bounce_kinks(trajectories, image_width, [contact.time for contact in contacts]):
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

        # The contact falls between two frames, and a short flight fitted from the wrong
        # instant can settle on a mirrored depth, so nearby instants compete.
        best = None
        for offset in KINK_TIME_OFFSETS_FRAMES:
            contact = Contact("bounce", kink.time + offset * frame_seconds)
            before = [
                sample for sample in trajectory
                if sample.time < contact.time and (start is None or sample.time >= start.time)
            ]
            after = [
                sample for sample in trajectory
                if sample.time >= contact.time and (end is None or sample.time < end.time)
            ]
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
            continue
        error, contact, landing = best
        samples = [
            sample for sample in trajectory
            if (start is None or sample.time >= start.time) and (end is None or sample.time < end.time)
        ]
        uninterrupted = fit_flight(
            samples, [cameras[sample.frame_position] for sample in samples], image_width, start, end
        )
        if uninterrupted is not None and uninterrupted.rms_pixels <= (
            KINK_MIN_SINGLE_FLIGHT_ERROR_RATIO * error + KINK_SINGLE_FLIGHT_ERROR_MARGIN_PIXELS
        ):
            continue
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

    bounces = detect_bounces(frames, image_width, image_height)
    hit_samples = detect_hits(
        frames,
        image_width,
        [bounce["timestamp_seconds"] for bounce in bounces],
    )
    hits = classify_hits(frames, hit_samples, bounces, handedness)

    cameras = build_cameras(frames, (image_width, image_height))
    extra_bounces = confirm_bounce_kinks(frames, cameras, image_width, bounces, hits)
    if extra_bounces:
        bounces = sorted(bounces + extra_bounces, key=lambda bounce: bounce["timestamp_seconds"])
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

    # Ground projections are replaced last: the 2D speed fallback above relies on them.
    for flight, samples, _, _ in flights:
        for sample in samples:
            x, y, z = flight.position_at(sample.time)
            sample.ball["x_meters"] = x
            sample.ball["y_meters"] = y
            sample.ball["z_meters"] = max(0.0, z)

    return {"bounces": bounces, "hits": hits}

