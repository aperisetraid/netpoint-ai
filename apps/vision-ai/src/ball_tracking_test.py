import math
import unittest

import numpy as np

from ball_tracking import track_ball
from events import build_events
from events_test import IMAGE_SIZE, SyntheticRally
from trajectory import best_ball


WIDTH = 1280
FPS = 25
COURT = [(300, 180), (980, 180), (1180, 620), (100, 620)]


def flight_path(index: int) -> tuple[float, float]:
    """A ball crossing the image on a parabola, as a ballistic flight looks to the camera."""
    return 200 + 22 * index, 500 - 30 * index + 1.1 * index * index


def bounce_path(index: int) -> tuple[float, float]:
    """A ball that falls, bounces at frame 12 and rises again."""
    return 300 + 14 * index, 520 - 16 * abs(index - 12)


def make_frames(count: int, corners=COURT) -> list[dict]:
    return [{
        "frame_index": index,
        "timestamp_seconds": index / FPS,
        "court_corners": corners(index) if callable(corners) else corners,
        "detections": [],
    } for index in range(count)]


def candidate(x: float, y: float, source: str = "color", confidence: float = 0.4, size: float = 4) -> dict:
    return {
        "bbox": [x - size / 2, y - size / 2, x + size / 2, y + size / 2],
        "confidence": confidence,
        "source": source,
    }


def noise(random: np.random.Generator, count: int) -> list[dict]:
    return [
        candidate(random.uniform(120, 1160), random.uniform(190, 610), confidence=0.9)
        for _ in range(count)
    ]


def balls(frames: list[dict]) -> dict[int, dict]:
    found = {}
    for frame in frames:
        frame_balls = [detection for detection in frame["detections"] if detection["class"] == "ball"]
        assert len(frame_balls) <= 1, frame
        if frame_balls:
            found[frame["frame_index"]] = frame_balls[0]
    return found


def center(ball: dict) -> tuple[float, float]:
    return (ball["bbox"][0] + ball["bbox"][2]) / 2, (ball["bbox"][1] + ball["bbox"][3]) / 2


class BallTrackingTests(unittest.TestCase):
    def test_keeps_the_moving_ball_and_rejects_confident_noise(self):
        random = np.random.default_rng(7)
        frames = make_frames(24)
        candidates = []
        for index in range(24):
            x, y = flight_path(index)
            jitter = random.normal(0, 0.8, 2)
            # The real ball is the least confident candidate of every frame.
            candidates.append(
                [candidate(x + jitter[0], y + jitter[1], "yolo", 0.15)] + noise(random, 6)
            )

        summary = track_ball(frames, candidates, WIDTH)

        found = balls(frames)
        self.assertEqual(sorted(found), list(range(24)))
        for index, ball in found.items():
            self.assertLess(math.dist(center(ball), flight_path(index)), 4)
            self.assertEqual(ball["source"], "yolo")
            self.assertNotIn("interpolated", ball)
            self.assertGreaterEqual(ball["confidence"], 0.5)
            self.assertIsNotNone(ball["x_meters"])
        self.assertEqual(summary["measured_frames"], 24)
        self.assertEqual(summary["rejected_candidates"], 24 * 6)

    def test_reports_no_ball_when_nothing_moves_like_one(self):
        random = np.random.default_rng(3)
        frames = make_frames(40)
        track_ball(frames, [noise(random, 6) for _ in frames], WIDTH)
        self.assertEqual(balls(frames), {})

    def test_rejects_a_blob_that_stays_put_however_confident(self):
        random = np.random.default_rng(5)
        frames = make_frames(30)
        candidates = [
            [candidate(640 + random.normal(0, 0.7), 400 + random.normal(0, 0.7), "yolo", 0.9)]
            for _ in frames
        ]
        track_ball(frames, candidates, WIDTH)
        self.assertEqual(balls(frames), {})

    def test_rejects_a_court_mark_that_only_moves_because_the_camera_pans(self):
        def panned(index):
            return [(x + 6 * index, y) for x, y in COURT]

        frames = make_frames(30, panned)
        track_ball(frames, [[candidate(640 + 6 * index, 400)] for index in range(30)], WIDTH)
        self.assertEqual(balls(frames), {})

        # The same image path over a still court is a ball rolling across it.
        frames = make_frames(30)
        track_ball(frames, [[candidate(640 + 6 * index, 400)] for index in range(30)], WIDTH)
        self.assertEqual(len(balls(frames)), 30)

    def test_rejects_a_scoreboard_that_stays_on_screen_while_the_camera_pans(self):
        def panned(index):
            return [(x + 6 * index, y) for x, y in COURT]

        # Fixed on screen, so it drifts against the panning court: only the screen test stops it.
        frames = make_frames(30, panned)
        track_ball(frames, [[candidate(640, 400)] for _ in range(30)], WIDTH)
        self.assertEqual(balls(frames), {})

    def test_rejects_a_blob_that_moves_with_a_player(self):
        def player_at(index):
            x = 400 + 9 * index
            return {"class": "player", "confidence": 0.9, "bbox": [x - 30, 460, x + 30, 600],
                    "x_meters": 5.0, "y_meters": 20.0}

        # A shoe or a shadow: next to the feet, following them as the player runs.
        frames = make_frames(30)
        for index, frame in enumerate(frames):
            frame["detections"].append(player_at(index))
        track_ball(frames, [[candidate(400 + 9 * index - 45, 602)] for index in range(30)], WIDTH)
        self.assertEqual(balls(frames), {})

        # The ball leaving the same player moves relative to them and is kept.
        frames = make_frames(30)
        for index, frame in enumerate(frames):
            frame["detections"].append(player_at(index))
        track_ball(frames, [[candidate(*flight_path(index))] for index in range(30)], WIDTH)
        self.assertGreater(len(balls(frames)), 20)

    def test_interpolates_frames_where_the_ball_is_not_seen(self):
        frames = make_frames(24)
        missing = {9, 10, 11, 12}
        candidates = [
            [] if index in missing else [candidate(*flight_path(index))]
            for index in range(24)
        ]

        summary = track_ball(frames, candidates, WIDTH)

        found = balls(frames)
        self.assertEqual(sorted(found), list(range(24)))
        for index, ball in found.items():
            self.assertEqual(bool(ball.get("interpolated")), index in missing)
            self.assertLess(math.dist(center(ball), flight_path(index)), 5)
        for index in missing:
            self.assertEqual(found[index]["source"], "interpolated")
            self.assertLess(found[index]["confidence"], 0.5)
        self.assertEqual(summary["interpolated_frames"], 4)

    def test_bridges_a_bounce_hidden_in_a_gap_without_cutting_the_corner(self):
        frames = make_frames(25)
        missing = {11, 12, 13}
        candidates = [
            [] if index in missing else [candidate(*bounce_path(index))]
            for index in range(25)
        ]

        track_ball(frames, candidates, WIDTH)

        found = balls(frames)
        self.assertEqual(sorted(found), list(range(25)))
        for index in missing:
            self.assertTrue(found[index]["interpolated"])
            self.assertLess(math.dist(center(found[index]), bounce_path(index)), 6)

    def test_leaves_long_gaps_empty_instead_of_inventing_a_path(self):
        frames = make_frames(40)
        candidates = [
            [candidate(*flight_path(index))] if index < 10
            else [candidate(*flight_path(index - 15))] if index >= 30
            else []
            for index in range(40)
        ]
        track_ball(frames, candidates, WIDTH)
        self.assertEqual(sorted(balls(frames)), [*range(10), *range(30, 40)])

    def test_never_reports_two_balls_or_a_teleport(self):
        frames = make_frames(24)
        candidates = [
            [candidate(*flight_path(index), "yolo", 0.4), candidate(1100 - 20 * index, 300 + 6 * index)]
            for index in range(24)
        ]
        track_ball(frames, candidates, WIDTH)
        found = balls(frames)
        self.assertEqual(len(found), 24)
        self.assertTrue(all(ball["source"] == "yolo" for ball in found.values()))


class EstimatedBallEventsTests(unittest.TestCase):
    def test_estimated_balls_are_not_evidence_for_events(self):
        frame = {"detections": [
            {"class": "ball", "confidence": 0.9, "bbox": [0, 0, 4, 4], "interpolated": True},
        ]}
        self.assertIsNone(best_ball(frame))

    def test_fitted_flight_places_the_ball_where_it_was_not_seen(self):
        rally = SyntheticRally(fps=60)
        hidden = [
            position for position, frame in enumerate(rally.frames)
            if rally.hit + 0.25 < frame["timestamp_seconds"] < rally.hit + 0.4
        ]
        self.assertGreater(len(hidden), 6)
        for position in hidden:
            rally.frames[position]["detections"].pop()

        build_events(rally.frames, *IMAGE_SIZE)

        for position in hidden:
            frame = rally.frames[position]
            ball, = [detection for detection in frame["detections"] if detection["class"] == "ball"]
            self.assertTrue(ball["interpolated"])
            self.assertEqual(ball["source"], "flight3d")
            truth = rally.truth[position]
            self.assertAlmostEqual(ball["z_meters"], truth[2], delta=0.3)
            self.assertAlmostEqual(ball["x_meters"], truth[0], delta=0.6)
            self.assertLess(math.dist(center(ball), rally.camera.project(truth)), 6)
            self.assertIsNone(best_ball(frame))


if __name__ == "__main__":
    unittest.main()
