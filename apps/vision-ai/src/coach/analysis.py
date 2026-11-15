"""Tactical model of a match, derived deterministically from the pipeline telemetry.

Coordinates follow the pipeline: `x` runs along the court from the far baseline (0) to the
near baseline (23.77 m) with the net at 11.885 m; `y` runs across the doubles width
(0 is the left sideline as seen from the camera). Lateral zones are expressed from each
player's own point of view, because that is how a coach talks ("to your backhand").

Everything here is a pure function of the telemetry: no I/O, no model calls. Inferences
(point endings, in/out calls) carry a qualitative confidence so the coach can hedge honestly.
"""

from __future__ import annotations

import math
from collections import defaultdict
from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field

COURT_LENGTH = 23.77
COURT_WIDTH = 10.97
NET_X = COURT_LENGTH / 2
CENTER_Y = COURT_WIDTH / 2
SINGLES_MIN_Y = 1.37
SINGLES_MAX_Y = COURT_WIDTH - 1.37
SERVICE_LINE_FROM_NET = 6.40

# Calibration noise: a call closer to a line than this is reported as doubtful.
LINE_TOLERANCE_METERS = 0.25
DEEP_ZONE_METERS = 3.0
LATERAL_THIRD_METERS = (SINGLES_MAX_Y - SINGLES_MIN_Y) / 6
NET_ZONE_METERS = 4.5
BASELINE_BAND_METERS = 1.5

# A point ends when the next one starts or, at the latest, this long after its last shot.
POINT_TAIL_SECONDS = 3.0
RECOVERY_DELAY_SECONDS = 1.0
MOVEMENT_STEP_SECONDS = 0.2
MAX_PLAYER_SPEED_MPS = 9.0
MAX_MOVEMENT_GAP_SECONDS = 1.0

SIDES = ("far", "near")
SIDE_LABELS = {"far": "Fondo", "near": "Cámara"}
SHOT_LABELS = {"serve": "saque", "volley": "volea", "forehand": "derecha", "backhand": "revés"}


def opponent(side: str) -> str:
    return "near" if side == "far" else "far"


def side_of(x: float) -> str:
    return "far" if x < NET_X else "near"


def depth_from_baseline(side: str, x: float) -> float:
    """Metres inside the court from that side's baseline; negative means behind it."""
    return x if side == "far" else COURT_LENGTH - x


def lateral_offset(side: str, y: float) -> float:
    """Metres to the right (+) or left (-) of the centre line, as seen by the player on `side`."""
    # The near player faces the far baseline (their right is +y); the far player faces the camera.
    return y - CENTER_Y if side == "near" else CENTER_Y - y


def lateral_zone(side: str, y: float) -> str:
    offset = lateral_offset(side, y)
    if offset > LATERAL_THIRD_METERS:
        return "derecha"
    if offset < -LATERAL_THIRD_METERS:
        return "izquierda"
    return "centro"


def court_zone(side: str, x: float) -> str:
    """Where a player stands on their own half."""
    inside = depth_from_baseline(side, x)
    if abs(x - NET_X) <= NET_ZONE_METERS:
        return "red"
    if inside < -BASELINE_BAND_METERS:
        return "muy atrás"
    if inside <= BASELINE_BAND_METERS:
        return "fondo"
    return "media pista"


def _finite(*values: object) -> bool:
    return all(isinstance(value, (int, float)) and math.isfinite(value) for value in values)


def format_clock(seconds: float) -> str:
    minutes, rest = divmod(max(0.0, seconds), 60)
    return f"{int(minutes)}:{int(rest):02d}"


# ---------------------------------------------------------------------------
# Model
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Landing:
    """First bounce after a shot, described from the receiver's point of view."""

    time: float
    x: float
    y: float
    side: str
    depth: str  # corta | media | profunda
    lateral: str  # derecha | centro | izquierda (receiver's view)
    status: str  # dentro | fuera | dudosa | propio campo
    out_kind: str | None  # larga | ancha
    confidence: float
    method: str


@dataclass(frozen=True)
class Shot:
    index: int
    point: int
    number: int
    time: float
    frame: int
    player: str
    type: str
    speed_kmh: float | None
    confidence: float
    x: float
    y: float
    zone: str
    lateral: str
    landing: Landing | None
    incoming: Landing | None
    tempo: float | None  # seconds since the previous shot of the point
    # The previous detected shot was by the same player: the rival's reply in between was missed.
    after_missed_reply: bool = False


@dataclass(frozen=True)
class Ending:
    kind: str  # ganador | error_fuera | error_red | indeterminado
    last_hitter: str
    winner: str | None
    description: str
    confidence: str  # media | baja


@dataclass(frozen=True)
class Point:
    number: int
    start: float
    end: float
    server: str | None
    shots: tuple[Shot, ...]
    ending: Ending

    @property
    def duration(self) -> float:
        return self.end - self.start

    @property
    def missed_shots(self) -> int:
        """Rival replies the tracker did not detect, inferred from consecutive shots by one player."""
        return sum(1 for shot in self.shots if shot.after_missed_reply)

    @property
    def rally_length(self) -> int:
        return len(self.shots) + self.missed_shots


@dataclass(frozen=True)
class PositionSample:
    time: float
    x: float
    y: float


@dataclass
class StrokeStats:
    count: int = 0
    measured: int = 0
    speed_sum: float = 0.0
    max_speed: float | None = None
    errors: int = 0
    winners: int = 0

    def add_speed(self, speed: float | None) -> None:
        if speed is None:
            return
        self.measured += 1
        self.speed_sum += speed
        self.max_speed = speed if self.max_speed is None else max(self.max_speed, speed)

    @property
    def average_speed(self) -> float | None:
        return self.speed_sum / self.measured if self.measured else None


@dataclass
class PlayerProfile:
    side: str
    strokes: dict[str, StrokeStats] = field(default_factory=lambda: defaultdict(StrokeStats))
    landing_depth: dict[str, int] = field(default_factory=lambda: defaultdict(int))
    landing_lateral: dict[str, int] = field(default_factory=lambda: defaultdict(int))
    landing_status: dict[str, int] = field(default_factory=lambda: defaultdict(int))
    zone_share: dict[str, float] = field(default_factory=dict)
    zone_at_shot: dict[str, int] = field(default_factory=lambda: defaultdict(int))
    average_depth: float | None = None
    distance_m: float = 0.0
    recovery_offset_m: float | None = None
    points_won: int = 0
    points_lost: int = 0
    # Replies to balls that landed on this player's left side (the backhand for a right-hander):
    # which stroke answered, and whether the rally went on or that reply ended the point.
    under_left_pressure: dict[str, int] = field(default_factory=lambda: defaultdict(int))
    left_pressure_outcomes: dict[str, int] = field(default_factory=lambda: defaultdict(int))
    coverage: float = 0.0


@dataclass(frozen=True)
class MinuteBucket:
    minute: int
    shots: dict[str, int]
    errors: dict[str, dict[str, int]]
    winners: dict[str, int]


@dataclass(frozen=True)
class MatchModel:
    duration: float
    fps: float | None
    calibrated: bool
    frame_count: int
    ball_coverage: float
    points: tuple[Point, ...]
    shots: tuple[Shot, ...]
    profiles: dict[str, PlayerProfile]
    timeline: tuple[MinuteBucket, ...]
    tracks: dict[str, tuple[PositionSample, ...]]
    frames: Sequence[dict]

    def point(self, number: int) -> Point | None:
        return next((point for point in self.points if point.number == number), None)

    def point_at(self, time: float) -> Point | None:
        """The point being played at `time`, or the last one that started before it."""
        current = None
        for point in self.points:
            if point.start - 1.0 <= time:
                current = point
        return current

    def position_at(self, side: str, time: float, tolerance: float = 0.5) -> PositionSample | None:
        track = self.tracks.get(side, ())
        best = min(track, key=lambda sample: abs(sample.time - time), default=None)
        return best if best is not None and abs(best.time - time) <= tolerance else None


# ---------------------------------------------------------------------------
# Construction
# ---------------------------------------------------------------------------


def classify_landing(bounce: dict, hitter: str) -> Landing:
    x, y = float(bounce["x_meters"]), float(bounce["y_meters"])
    receiver = opponent(hitter)
    side = side_of(x)
    inside = depth_from_baseline(receiver, x)
    from_net = abs(x - NET_X)
    if from_net <= SERVICE_LINE_FROM_NET:
        depth = "corta"
    elif inside <= DEEP_ZONE_METERS:
        depth = "profunda"
    else:
        depth = "media"

    width_margin = min(y - SINGLES_MIN_Y, SINGLES_MAX_Y - y)
    if side == hitter:
        status, out_kind = "propio campo", None
    elif inside < -LINE_TOLERANCE_METERS:
        status, out_kind = "fuera", "larga"
    elif width_margin < -LINE_TOLERANCE_METERS:
        status, out_kind = "fuera", "ancha"
    elif inside < LINE_TOLERANCE_METERS or width_margin < LINE_TOLERANCE_METERS:
        status, out_kind = "dudosa", None
    else:
        status, out_kind = "dentro", None

    return Landing(
        time=float(bounce["timestamp_seconds"]),
        x=x,
        y=y,
        side=side,
        depth=depth,
        lateral=lateral_zone(receiver, y),
        status=status,
        out_kind=out_kind,
        confidence=float(bounce.get("confidence") or 0.0),
        method=str(bounce.get("method") or "image2d"),
    )


def _player_tracks(frames: Sequence[dict]) -> dict[str, tuple[PositionSample, ...]]:
    """Best measured position of each player per frame; carried-forward boxes are dropped."""
    tracks: dict[str, list[PositionSample]] = {side: [] for side in SIDES}
    for frame in frames:
        best: dict[str, tuple[float, PositionSample]] = {}
        for detection in frame.get("detections", ()):
            if detection.get("class") != "player" or detection.get("carried_forward"):
                continue
            x, y = detection.get("x_meters"), detection.get("y_meters")
            if not _finite(x, y):
                continue
            side = side_of(x)
            confidence = float(detection.get("confidence") or 0.0)
            if side not in best or confidence > best[side][0]:
                best[side] = (confidence, PositionSample(float(frame["timestamp_seconds"]), float(x), float(y)))
        for side, (_, sample) in best.items():
            tracks[side].append(sample)
    return {side: tuple(samples) for side, samples in tracks.items()}


def _ball_coverage(frames: Sequence[dict]) -> float:
    if not frames:
        return 0.0
    seen = sum(
        1 for frame in frames
        if any(d.get("class") == "ball" and not d.get("interpolated") for d in frame.get("detections", ()))
    )
    return seen / len(frames)


def _bounces_between(bounces: Sequence[dict], start: float, end: float) -> list[dict]:
    return [b for b in bounces if start < b["timestamp_seconds"] < end]


def _infer_ending(last: Shot, bounces_after: Sequence[dict], only_serve: bool) -> Ending:
    hitter, rival = last.player, opponent(last.player)
    label = f"{SHOT_LABELS[last.type]} de {SIDE_LABELS[hitter]}"
    if not bounces_after:
        return Ending(
            "indeterminado", hitter, None,
            f"Sin bote registrado tras el último golpe ({label}): posible red, pelota fuera del encuadre o pérdida de seguimiento.",
            "baja",
        )
    landing = classify_landing(bounces_after[0], hitter)
    measured = "media" if landing.method == "fit3d" else "baja"
    if landing.status == "propio campo":
        # Either the ball never crossed the net or the rival's reply went undetected.
        return Ending(
            "indeterminado", hitter, None,
            f"Tras {label} el siguiente bote cae en su propio campo: o no pasó la red o hubo una devolución del rival no detectada.",
            "baja",
        )
    if landing.status == "fuera":
        return Ending("error_fuera", hitter, rival, f"{label[0].upper() + label[1:]} {landing.out_kind}: error probable.", measured)
    if landing.status == "dudosa":
        return Ending(
            "indeterminado", hitter, None,
            f"Bote sobre la línea (±{LINE_TOLERANCE_METERS:.2f} m) tras {label}: no se puede cantar.", "baja",
        )
    detail = "saque no devuelto (ace o saque ganador)" if only_serve else "el rival no devolvió la pelota (ganador o error forzado)"
    return Ending("ganador", hitter, hitter, f"{label[0].upper() + label[1:]} dentro y {detail}.", measured)


def _build_points(hits: Sequence[dict], bounces: Sequence[dict]) -> tuple[tuple[Point, ...], tuple[Shot, ...]]:
    grouped: dict[int, list[dict]] = defaultdict(list)
    for hit in sorted(hits, key=lambda h: h["timestamp_seconds"]):
        grouped[int(hit.get("point_index", 0))].append(hit)
    ordered = [grouped[key] for key in sorted(grouped)]
    starts = [group[0]["timestamp_seconds"] for group in ordered]

    points: list[Point] = []
    all_shots: list[Shot] = []
    for number, group in enumerate(ordered, start=1):
        next_start = starts[number] if number < len(starts) else math.inf
        shots: list[Shot] = []
        for position, hit in enumerate(group):
            time = float(hit["timestamp_seconds"])
            hitter = hit["player"]
            following = float(group[position + 1]["timestamp_seconds"]) if position + 1 < len(group) else min(
                next_start, time + POINT_TAIL_SECONDS
            )
            # Landing: the first bounce after the shot, only if it is on the rival's half. A bounce
            # back on the hitter's half means another shot happened in between, so it is unknown.
            after = _bounces_between(bounces, time, following)
            landing = classify_landing(after[0], hitter) if after and side_of(after[0]["x_meters"]) != hitter else None
            # Incoming: the last bounce on the hitter's half since the previous shot, even when the
            # rival shot that produced it was not detected.
            previous_time = shots[-1].time if shots else time - POINT_TAIL_SECONDS
            before = [b for b in _bounces_between(bounces, previous_time, time) if side_of(b["x_meters"]) == hitter]
            incoming = classify_landing(before[-1], opponent(hitter)) if before and shots else None
            player_position = hit.get("player_position") or {}
            px, py = player_position.get("x"), player_position.get("y")
            px, py = (float(px), float(py)) if _finite(px, py) else (math.nan, math.nan)
            speed = hit.get("speed_kmh")
            shot = Shot(
                index=len(all_shots) + len(shots) + 1,
                point=number,
                number=position + 1,
                time=time,
                frame=int(hit.get("frame_index", 0)),
                player=hit["player"],
                type=hit["type"],
                speed_kmh=float(speed) if _finite(speed) else None,
                confidence=float(hit.get("confidence") or 0.0),
                x=px,
                y=py,
                zone=court_zone(hit["player"], px) if _finite(px) else "desconocida",
                lateral=lateral_zone(hit["player"], py) if _finite(py) else "desconocida",
                landing=landing,
                incoming=incoming,
                tempo=time - shots[-1].time if shots else None,
                after_missed_reply=bool(shots) and shots[-1].player == hitter,
            )
            shots.append(shot)

        last = shots[-1]
        tail_end = min(next_start, last.time + POINT_TAIL_SECONDS)
        after = [b for b in bounces if last.time < b["timestamp_seconds"] < tail_end]
        ending = _infer_ending(last, after, only_serve=len(shots) == 1 and last.type == "serve")
        end = max([last.time] + [b["timestamp_seconds"] for b in after[:2]])
        points.append(Point(
            number=number,
            start=shots[0].time,
            end=float(end),
            server=shots[0].player if shots[0].type == "serve" else None,
            shots=tuple(shots),
            ending=ending,
        ))
        all_shots.extend(shots)
    return tuple(points), tuple(all_shots)


def _resample(track: Sequence[PositionSample], start: float, end: float, step: float) -> list[PositionSample]:
    """One sample per `step` seconds inside [start, end], taken from the nearest measurement."""
    selected: list[PositionSample] = []
    next_time = start
    for sample in track:
        if sample.time < start:
            continue
        if sample.time > end:
            break
        if sample.time >= next_time:
            selected.append(sample)
            next_time = sample.time + step
    return selected


def path_length(samples: Sequence[PositionSample]) -> float:
    """Distance walked, ignoring gaps and jumps a human cannot make (tracking noise)."""
    total = 0.0
    for previous, current in zip(samples, samples[1:]):
        elapsed = current.time - previous.time
        if elapsed <= 0 or elapsed > MAX_MOVEMENT_GAP_SECONDS:
            continue
        step = math.dist((previous.x, previous.y), (current.x, current.y))
        if step / elapsed <= MAX_PLAYER_SPEED_MPS:
            total += step
    return total


def _in_point_windows(time: float, points: Sequence[Point]) -> bool:
    return any(point.start - 0.5 <= time <= point.end + 1.0 for point in points)


def _build_profiles(
    points: Sequence[Point],
    shots: Sequence[Shot],
    tracks: dict[str, tuple[PositionSample, ...]],
    frame_count: int,
) -> dict[str, PlayerProfile]:
    profiles = {side: PlayerProfile(side=side) for side in SIDES}

    for shot in shots:
        profile = profiles[shot.player]
        stats = profile.strokes[shot.type]
        stats.count += 1
        stats.add_speed(shot.speed_kmh)
        profile.zone_at_shot[shot.zone] += 1
        if shot.landing is not None:
            profile.landing_status[shot.landing.status] += 1
            if shot.landing.status in ("dentro", "dudosa"):
                profile.landing_depth[shot.landing.depth] += 1
                profile.landing_lateral[shot.landing.lateral] += 1
        if shot.incoming is not None and shot.incoming.lateral == "izquierda":
            profile.under_left_pressure[shot.type] += 1

    for point in points:
        last = point.shots[-1]
        stroke = profiles[last.player].strokes[last.type]
        if point.ending.kind == "ganador":
            stroke.winners += 1
        elif point.ending.kind in ("error_fuera", "error_red"):
            stroke.errors += 1
        if point.ending.winner is not None:
            profiles[point.ending.winner].points_won += 1
            profiles[opponent(point.ending.winner)].points_lost += 1
        # What the reply to a ball on the left side led to: the rally went on, or it ended the point.
        for shot in point.shots:
            if shot.incoming is None or shot.incoming.lateral != "izquierda":
                continue
            if shot is not last:
                outcome = "continúa"
            elif point.ending.kind.startswith("error"):
                outcome = "error"
            elif point.ending.kind == "ganador":
                outcome = "ganador"
            else:
                outcome = "indeterminado"
            profiles[shot.player].left_pressure_outcomes[outcome] += 1

    for side, profile in profiles.items():
        track = tracks.get(side, ())
        profile.coverage = len(track) / frame_count if frame_count else 0.0
        in_play = [sample for sample in track if _in_point_windows(sample.time, points)]
        if in_play:
            zones: dict[str, int] = defaultdict(int)
            for sample in in_play:
                zones[court_zone(side, sample.x)] += 1
            profile.zone_share = {zone: count / len(in_play) for zone, count in zones.items()}
            profile.average_depth = sum(depth_from_baseline(side, s.x) for s in in_play) / len(in_play)
        for point in points:
            profile.distance_m += path_length(_resample(track, point.start - 0.5, point.end, MOVEMENT_STEP_SECONDS))

        offsets = []
        for shot in shots:
            if shot.player != side:
                continue
            target = shot.time + RECOVERY_DELAY_SECONDS
            nearest = min(track, key=lambda sample: abs(sample.time - target), default=None)
            if nearest is not None and abs(nearest.time - target) <= 0.3:
                offsets.append(abs(lateral_offset(side, nearest.y)))
        profile.recovery_offset_m = sum(offsets) / len(offsets) if offsets else None
    return profiles


def _build_timeline(points: Sequence[Point], shots: Sequence[Shot], duration: float) -> tuple[MinuteBucket, ...]:
    minutes = max(1, math.ceil(duration / 60)) if duration > 0 else 1
    buckets = []
    for minute in range(minutes):
        start, end = minute * 60, (minute + 1) * 60
        shot_counts = {side: 0 for side in SIDES}
        for shot in shots:
            if start <= shot.time < end:
                shot_counts[shot.player] += 1
        errors: dict[str, dict[str, int]] = {side: defaultdict(int) for side in SIDES}
        winners = {side: 0 for side in SIDES}
        for point in points:
            last = point.shots[-1]
            if not start <= last.time < end:
                continue
            if point.ending.kind.startswith("error"):
                errors[last.player][last.type] += 1
            elif point.ending.kind == "ganador":
                winners[last.player] += 1
        buckets.append(MinuteBucket(minute, shot_counts, {s: dict(e) for s, e in errors.items()}, winners))
    return tuple(buckets)


def build_match_model(telemetry: dict) -> MatchModel:
    if not isinstance(telemetry, dict) or "frames" not in telemetry or "events" not in telemetry:
        raise ValueError("La telemetría no tiene el formato v2 (frames + events).")
    video = telemetry.get("video") or {}
    frames: list[dict] = telemetry.get("frames") or []
    events = telemetry.get("events") or {}
    bounces = sorted(
        (b for b in events.get("bounces", ()) if _finite(b.get("x_meters"), b.get("y_meters"), b.get("timestamp_seconds"))),
        key=lambda b: b["timestamp_seconds"],
    )
    hits = [h for h in events.get("hits", ()) if _finite(h.get("timestamp_seconds")) and h.get("player") in SIDES]
    fps = video.get("fps") if _finite(video.get("fps")) and video.get("fps") > 0 else None
    frame_count = int(video.get("frame_count") or len(frames))
    if frames:
        duration = float(frames[-1]["timestamp_seconds"])
    else:
        duration = frame_count / fps if fps else 0.0

    points, shots = _build_points(hits, bounces)
    tracks = _player_tracks(frames)
    return MatchModel(
        duration=duration,
        fps=fps,
        calibrated=bool((telemetry.get("court") or {}).get("calibrated")),
        frame_count=frame_count,
        ball_coverage=_ball_coverage(frames),
        points=points,
        shots=shots,
        profiles=_build_profiles(points, shots, tracks, len(frames) or frame_count),
        timeline=_build_timeline(points, shots, duration),
        tracks=tracks,
        frames=frames,
    )


# ---------------------------------------------------------------------------
# Queries shared by the digest, the tools and the UI highlights
# ---------------------------------------------------------------------------


def longest_point(model: MatchModel) -> Point | None:
    return max(model.points, key=lambda p: (p.rally_length, p.duration), default=None)


def fastest_shot(model: MatchModel, types: Iterable[str] | None = None) -> Shot | None:
    allowed = set(types) if types else None
    candidates = [s for s in model.shots if s.speed_kmh is not None and (allowed is None or s.type in allowed)]
    return max(candidates, key=lambda s: s.speed_kmh, default=None)


def track_window(model: MatchModel, side: str, start: float, end: float, step: float) -> list[PositionSample]:
    return _resample(model.tracks.get(side, ()), start, end, step)


def ball_samples(model: MatchModel, start: float, end: float) -> list[dict]:
    samples = []
    for frame in model.frames:
        time = frame.get("timestamp_seconds", 0.0)
        if time < start:
            continue
        if time > end:
            break
        balls = [d for d in frame.get("detections", ()) if d.get("class") == "ball"]
        if not balls:
            continue
        ball = max(balls, key=lambda d: d.get("confidence") or 0.0)
        samples.append({
            "t": round(float(time), 2),
            "x": round(ball["x_meters"], 2) if _finite(ball.get("x_meters")) else None,
            "y": round(ball["y_meters"], 2) if _finite(ball.get("y_meters")) else None,
            "z": round(ball["z_meters"], 2) if _finite(ball.get("z_meters")) else None,
            "fuente": ball.get("source") or ("interpolada" if ball.get("interpolated") else "yolo"),
        })
    return samples
