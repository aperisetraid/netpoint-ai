"""Ball samples, 2D trajectories and monocular 3D flight reconstruction."""

import math
from collections.abc import Sequence
from dataclasses import dataclass

import numpy as np

from camera import Camera


MAX_TRAJECTORY_GAP_SECONDS = 0.35
MAX_BALL_IMAGE_SPEED_WIDTHS_PER_SECOND = 1.5

GRAVITY = 9.81
# 0.5 * air density * drag coefficient * cross-section / mass of a tennis ball, in 1/m.
DRAG_PER_METER = 0.5 * 1.2 * 0.55 * (math.pi * 0.0335 ** 2) / 0.057
INTEGRATION_STEP_SECONDS = 0.01

MIN_FLIGHT_SAMPLES = 4
MIN_FLIGHT_SECONDS = 0.1
MAX_FLIGHT_RMS_RATIO = 0.002
MIN_FLIGHT_RMS_PIXELS = 3.0
MAX_BALL_SPEED_METERS_PER_SECOND = 75.0
MAX_BALL_HEIGHT_METERS = 12.0
GROUND_TOLERANCE_METERS = 0.3
# Constraint weights, in pixels of reprojection error per meter of violation.
GROUND_ANCHOR_WEIGHT = 200.0
HEIGHT_BOUND_WEIGHT = 200.0
CONTACT_HINT_WEIGHT = 40.0
CONTACT_DEPTH_TOLERANCE_METERS = 2.0
CONTACT_MAX_HEIGHT_METERS = 3.5
# A flight leaving a bounce continues the one that landed: same spot, slower, and rebounding
# with a plausible restitution. Weights are pixels per meter and per meter per second.
REBOUND_POSITION_WEIGHT = 100.0
REBOUND_VELOCITY_WEIGHT = 20.0
REBOUND_MIN_SPEED_RATIO = 0.4
REBOUND_MAX_SPEED_RATIO = 1.0
REBOUND_MIN_RESTITUTION = 0.4
REBOUND_MAX_RESTITUTION = 0.95


@dataclass
class BallSample:
    frame_position: int
    frame: dict
    ball: dict
    time: float
    x: float
    y: float

    @property
    def bottom(self) -> float:
        return self.ball["bbox"][3]


def is_finite_number(value) -> bool:
    return isinstance(value, (int, float)) and math.isfinite(value)


def best_ball(frame: dict, min_confidence: float = 0.0, predicate=None) -> dict | None:
    """The measured ball of a frame; estimated positions are not evidence of how it moved."""
    best = None
    for detection in frame["detections"]:
        if (
            detection["class"] != "ball"
            or detection.get("carried_forward")
            or detection.get("interpolated")
            or detection["confidence"] < min_confidence
            or not all(is_finite_number(value) for value in detection["bbox"])
            or (predicate is not None and not predicate(detection))
        ):
            continue
        if best is None or detection["confidence"] > best["confidence"]:
            best = detection
    return best


def collect_ball_samples(
    frames: Sequence[dict],
    min_confidence: float = 0.0,
    predicate=None,
) -> list[BallSample]:
    samples = []
    for position, frame in enumerate(frames):
        ball = best_ball(frame, min_confidence, predicate)
        if ball is None:
            continue
        bbox = ball["bbox"]
        samples.append(BallSample(
            position,
            frame,
            ball,
            frame["timestamp_seconds"],
            (bbox[0] + bbox[2]) / 2,
            (bbox[1] + bbox[3]) / 2,
        ))
    return samples


def split_trajectories(
    samples: Sequence[BallSample],
    image_width: float,
    vertical=lambda sample: sample.y,
) -> list[list[BallSample]]:
    """Split wherever time or position jumps, so detector switches are not read as ball motion."""
    trajectories: list[list[BallSample]] = []
    current: list[BallSample] = []
    for sample in samples:
        if current:
            previous = current[-1]
            elapsed = sample.time - previous.time
            max_distance = max(12.0, image_width * MAX_BALL_IMAGE_SPEED_WIDTHS_PER_SECOND * elapsed)
            if (
                elapsed <= 0
                or elapsed > MAX_TRAJECTORY_GAP_SECONDS
                or math.hypot(sample.x - previous.x, vertical(sample) - vertical(previous)) > max_distance
            ):
                trajectories.append(current)
                current = []
        current.append(sample)
    if current:
        trajectories.append(current)
    return trajectories


def fit_velocity(samples: Sequence[BallSample]) -> tuple[float, float]:
    """Least-squares image velocity in pixels per second."""
    mean_time = sum(sample.time for sample in samples) / len(samples)
    time_variance = x_covariance = y_covariance = 0.0
    for sample in samples:
        centered = sample.time - mean_time
        time_variance += centered * centered
        x_covariance += centered * sample.x
        y_covariance += centered * sample.y
    if time_variance <= 0:
        return 0.0, 0.0
    return x_covariance / time_variance, y_covariance / time_variance


@dataclass(frozen=True)
class Contact:
    """What bounds one end of a flight: a bounce (ball on the ground) or a racket hit."""
    kind: str
    time: float
    depth_hint: float | None = None
    landing_state: tuple[float, ...] | None = None


@dataclass
class Flight:
    start_time: float
    end_time: float
    state: tuple[float, float, float, float, float, float]
    rms_pixels: float
    bounded_end: bool = False

    def state_at(self, time: float) -> tuple[float, float, float, float, float, float]:
        return _simulate(self.state, [max(0.0, time - self.start_time)])[0]

    def position_at(self, time: float) -> tuple[float, float, float]:
        return self.state_at(time)[:3]

    def speed_at(self, time: float) -> float:
        return math.hypot(*self.state_at(time)[3:])


def _simulate(state: Sequence[float], offsets: Sequence[float]) -> list[tuple]:
    """Integrate gravity plus quadratic drag; offsets are ascending seconds from the state."""
    x, y, z, vx, vy, vz = (float(value) for value in state)
    elapsed = 0.0
    states = []
    for offset in offsets:
        while elapsed < offset - 1e-9:
            step = min(INTEGRATION_STEP_SECONDS, offset - elapsed)
            drag = DRAG_PER_METER * math.sqrt(vx * vx + vy * vy + vz * vz)
            mid_vx = vx - drag * vx * step / 2
            mid_vy = vy - drag * vy * step / 2
            mid_vz = vz - (GRAVITY + drag * vz) * step / 2
            mid_drag = DRAG_PER_METER * math.sqrt(mid_vx * mid_vx + mid_vy * mid_vy + mid_vz * mid_vz)
            x += mid_vx * step
            y += mid_vy * step
            z += mid_vz * step
            vx -= mid_drag * mid_vx * step
            vy -= mid_drag * mid_vy * step
            vz -= (GRAVITY + mid_drag * mid_vz) * step
            elapsed += step
        states.append((x, y, z, vx, vy, vz))
    return states


def _hinge(value: float, low: float, high: float) -> float:
    return value - high if value > high else value - low if value < low else 0.0


class _FlightProblem:
    def __init__(
        self,
        samples: Sequence[BallSample],
        cameras: Sequence[Camera],
        start: Contact | None,
        end: Contact | None,
    ):
        self.start = start
        self.end = end
        self.start_time = start.time if start is not None else samples[0].time
        self.end_time = end.time if end is not None else samples[-1].time
        self.sample_offsets = [sample.time - self.start_time for sample in samples]
        self.offsets = self.sample_offsets + [self.end_time - self.start_time]
        self.observed = np.asarray([(sample.x, sample.y) for sample in samples])
        self.projections = np.stack([camera.projection for camera in cameras])

    def residuals(self, state: np.ndarray) -> np.ndarray:
        states = _simulate(state, self.offsets)
        positions = np.asarray([simulated[:3] for simulated in states[:-1]])
        homogeneous = np.column_stack((positions, np.ones(len(positions))))
        projected = np.einsum("nij,nj->ni", self.projections, homogeneous)
        depth = np.where(projected[:, 2] > 1e-6, projected[:, 2], 1e-6)
        pixels = (projected[:, :2] / depth[:, None] - self.observed).ravel()

        constraints = [
            HEIGHT_BOUND_WEIGHT * _hinge(simulated[2], 0.0, MAX_BALL_HEIGHT_METERS)
            for simulated in states[:-1]
        ]
        if self.start is not None and self.start.landing_state is not None:
            x, y, _, vx, vy, vz = self.start.landing_state
            landing_speed = math.hypot(vx, vy)
            constraints.extend((
                REBOUND_POSITION_WEIGHT * (state[0] - x),
                REBOUND_POSITION_WEIGHT * (state[1] - y),
                REBOUND_VELOCITY_WEIGHT * _hinge(
                    math.hypot(state[3], state[4]),
                    REBOUND_MIN_SPEED_RATIO * landing_speed,
                    REBOUND_MAX_SPEED_RATIO * landing_speed,
                ),
                REBOUND_VELOCITY_WEIGHT * _hinge(
                    state[5],
                    REBOUND_MIN_RESTITUTION * abs(vz),
                    REBOUND_MAX_RESTITUTION * abs(vz),
                ),
            ))
        for contact, simulated in ((self.start, (*state,)), (self.end, states[-1])):
            if contact is None:
                continue
            if contact.kind == "bounce":
                constraints.append(GROUND_ANCHOR_WEIGHT * simulated[2])
            else:
                constraints.append(
                    HEIGHT_BOUND_WEIGHT * _hinge(simulated[2], 0.0, CONTACT_MAX_HEIGHT_METERS)
                )
                constraints.append(
                    0.0 if contact.depth_hint is None else CONTACT_HINT_WEIGHT * _hinge(
                        simulated[0] - contact.depth_hint,
                        -CONTACT_DEPTH_TOLERANCE_METERS,
                        CONTACT_DEPTH_TOLERANCE_METERS,
                    )
                )
        return np.concatenate((pixels, np.asarray(constraints)))

    def pixel_rms(self, state: np.ndarray) -> float:
        pixels = self.residuals(state)[:2 * len(self.sample_offsets)]
        return float(np.sqrt(np.mean(pixels.reshape(-1, 2) ** 2) * 2))

    def initial_states(self, samples: Sequence[BallSample], cameras: Sequence[Camera]) -> list[np.ndarray]:
        duration = max(self.sample_offsets[-1] - self.sample_offsets[0], 1e-3)
        candidates = []
        for start_height, end_height in ((0.0, 0.0), (1.0, 1.0), (2.5, 1.0), (1.0, 2.5)):
            if self.start is not None and self.start.kind == "bounce":
                start_height = 0.0
            if self.end is not None and self.end.kind == "bounce":
                end_height = 0.0
            first = cameras[0].backproject(samples[0].x, samples[0].y, start_height)
            last = cameras[-1].backproject(samples[-1].x, samples[-1].y, end_height)
            if first is None or last is None:
                continue
            if self.start is not None and self.start.landing_state is not None:
                x, y, _, vx, vy, vz = self.start.landing_state
                candidates.append(np.asarray([x, y, 0.0, vx * 0.7, vy * 0.7, -vz * 0.7]))
            velocity = (
                (last[0] - first[0]) / duration,
                (last[1] - first[1]) / duration,
                (end_height - start_height) / duration + GRAVITY * duration / 2,
            )
            lead = self.sample_offsets[0]
            candidates.append(np.asarray([
                first[0] - velocity[0] * lead,
                first[1] - velocity[1] * lead,
                start_height - velocity[2] * lead,
                *velocity,
            ]))
        return candidates


def _levenberg_marquardt(problem: _FlightProblem, state: np.ndarray) -> tuple[np.ndarray, float]:
    residuals = problem.residuals(state)
    cost = float(residuals @ residuals)
    damping = 1e-2
    for _ in range(40):
        jacobian = np.empty((len(residuals), 6))
        for index in range(6):
            shifted = state.copy()
            shifted[index] += 1e-4
            jacobian[:, index] = (problem.residuals(shifted) - residuals) / 1e-4
        normal = jacobian.T @ jacobian
        gradient = jacobian.T @ residuals
        improved = False
        while damping < 1e8:
            try:
                step = np.linalg.solve(
                    normal + damping * np.diag(np.diag(normal)) + 1e-9 * np.eye(6),
                    -gradient,
                )
            except np.linalg.LinAlgError:
                damping *= 10
                continue
            candidate = state + step
            candidate_residuals = problem.residuals(candidate)
            candidate_cost = float(candidate_residuals @ candidate_residuals)
            if math.isfinite(candidate_cost) and candidate_cost < cost:
                converged = cost - candidate_cost < 1e-6 * max(cost, 1e-12)
                state, residuals, cost = candidate, candidate_residuals, candidate_cost
                damping = max(damping * 0.3, 1e-7)
                improved = not converged
                break
            damping *= 5
        if not improved:
            break
    return state, cost


def fit_flight(
    samples: Sequence[BallSample],
    cameras: Sequence[Camera | None],
    image_width: float,
    start: Contact | None = None,
    end: Contact | None = None,
) -> Flight | None:
    """Fit one free flight to image observations; returns None when it is not trustworthy.

    A single camera does not observe depth, so the fit leans on gravity and on the contacts
    that bound the flight (the ball is on the ground at a bounce and near the player at a hit).
    """
    if (
        len(samples) < MIN_FLIGHT_SAMPLES
        or samples[-1].time - samples[0].time < MIN_FLIGHT_SECONDS
        or any(camera is None for camera in cameras)
        or (start is not None and start.time > samples[0].time + 1e-9)
        or (end is not None and end.time < samples[-1].time - 1e-9)
    ):
        return None

    problem = _FlightProblem(samples, cameras, start, end)
    best_state = None
    best_cost = math.inf
    for initial in problem.initial_states(samples, cameras):
        if not np.all(np.isfinite(initial)):
            continue
        state, cost = _levenberg_marquardt(problem, initial)
        if cost < best_cost:
            best_state, best_cost = state, cost
    if best_state is None:
        return None

    rms = problem.pixel_rms(best_state)
    if rms > max(MIN_FLIGHT_RMS_PIXELS, image_width * MAX_FLIGHT_RMS_RATIO):
        return None
    states = _simulate(best_state, problem.offsets)
    for contact, simulated in ((start, (*best_state,)), (end, states[-1])):
        if contact is not None and contact.kind == "bounce" and abs(simulated[2]) > GROUND_TOLERANCE_METERS:
            return None
    for simulated in [(*best_state,)] + states:
        if (
            not -GROUND_TOLERANCE_METERS <= simulated[2] <= MAX_BALL_HEIGHT_METERS + GROUND_TOLERANCE_METERS
            or math.hypot(*simulated[3:]) > MAX_BALL_SPEED_METERS_PER_SECOND
        ):
            return None
    return Flight(
        problem.start_time,
        problem.end_time,
        tuple(float(value) for value in best_state),
        rms,
        end is not None,
    )


def launch_velocity(
    start: Sequence[float],
    end: Sequence[float],
    duration: float,
    iterations: int = 30,
    tolerance_meters: float = 1e-3,
) -> tuple[float, float, float] | None:
    """Velocity that carries the ball from `start` to `end` in `duration` seconds under gravity and drag.

    Solved with Newton's method from the drag-free guess; None when it does not converge.
    """
    if duration <= 0:
        return None
    start_point, target = np.asarray(start, dtype=float), np.asarray(end, dtype=float)
    velocity = (target - start_point) / duration
    velocity[2] += GRAVITY * duration / 2

    def miss(candidate: np.ndarray) -> np.ndarray:
        return np.asarray(_simulate((*start_point, *candidate), [duration])[0][:3]) - target

    step = 1e-4
    for _ in range(iterations):
        error = miss(velocity)
        if np.linalg.norm(error) <= tolerance_meters:
            break
        jacobian = np.column_stack([(miss(velocity + delta) - error) / step for delta in np.eye(3) * step])
        try:
            velocity = velocity - np.linalg.solve(jacobian, error)
        except np.linalg.LinAlgError:
            return None
        if not np.all(np.isfinite(velocity)) or np.linalg.norm(velocity) > MAX_BALL_SPEED_METERS_PER_SECOND * 2:
            return None
    if np.linalg.norm(miss(velocity)) > tolerance_meters:
        return None
    return tuple(float(value) for value in velocity)
