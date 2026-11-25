import math
import unittest

import numpy as np

from camera import Camera, estimate_camera, estimate_focal_length
from events import (
    build_events,
    classify_hits,
    detect_bounces,
    detect_hits,
    detect_vanishing_strokes,
    estimate_ground_speed_kmh,
)
from homography import COURT_LENGTH_METERS, COURT_WIDTH_METERS
from trajectory import GRAVITY, Contact, _simulate, collect_ball_samples, fit_flight


IMAGE_SIZE = (1920, 1080)


def broadcast_camera(focal=2600.0, lateral_offset=0.0) -> Camera:
    """Ground-truth camera behind the near baseline, looking down at the court."""
    center = np.asarray([COURT_LENGTH_METERS + 22, COURT_WIDTH_METERS / 2 + lateral_offset, 9.0])
    forward = np.asarray([COURT_LENGTH_METERS / 2 + 1, COURT_WIDTH_METERS / 2, 0.0]) - center
    forward /= np.linalg.norm(forward)
    right = np.cross(forward, [0.0, 0.0, 1.0])
    right /= np.linalg.norm(right)
    rotation = np.vstack((right, np.cross(forward, right), forward))
    intrinsics = np.asarray([
        [focal, 0.0, IMAGE_SIZE[0] / 2],
        [0.0, focal, IMAGE_SIZE[1] / 2],
        [0.0, 0.0, 1.0],
    ])
    return Camera(intrinsics @ np.column_stack((rotation, -rotation @ center)), focal)


def court_corners(camera: Camera) -> list[tuple[int, int]]:
    return [
        tuple(round(value) for value in camera.project(point))
        for point in (
            (0, 0, 0),
            (0, COURT_WIDTH_METERS, 0),
            (COURT_LENGTH_METERS, COURT_WIDTH_METERS, 0),
            (COURT_LENGTH_METERS, 0, 0),
        )
    ]


def landing_time(state) -> float:
    step = 0.001
    return next(
        index * step for index in range(1, 5000)
        if _simulate(state, [index * step])[0][2] <= 0
    )


def bounce_off_ground(state):
    x, y, _, vx, vy, vz = state
    return (x, y, 0.0, vx * 0.7, vy * 0.7, -vz * 0.75)


class SyntheticRally:
    """Far player's ball bounces, the near player hits it back and it bounces again."""

    def __init__(self, fps=60, noise=0.0, seed=0):
        self.camera = broadcast_camera()
        self.corners = court_corners(self.camera)
        self.player = (22.5, 5.6)
        incoming = (4.0, 5.5, 1.0, 14.0, 0.0, 4.0)
        self.first_bounce = landing_time(incoming)
        rebound = bounce_off_ground(_simulate(incoming, [self.first_bounce])[0])
        to_player = next(
            index * 0.001 for index in range(1, 3000)
            if _simulate(rebound, [index * 0.001])[0][0] >= 21.8
        )
        self.hit = self.first_bounce + to_player
        contact = _simulate(rebound, [to_player])[0]
        outgoing = (*contact[:3], -24.0, 0.5, 3.5)
        self.second_bounce = self.hit + landing_time(outgoing)
        self.landing = _simulate(outgoing, [self.second_bounce - self.hit])[0]
        final = bounce_off_ground(self.landing)
        self.legs = [
            (0.0, incoming),
            (self.first_bounce, rebound),
            (self.hit, outgoing),
            (self.second_bounce, final),
        ]
        self.duration = self.second_bounce + 0.35

        random = np.random.default_rng(seed)
        feet = self.camera.project((*self.player, 0.0))
        head = self.camera.project((*self.player, 1.85))
        player_box = [feet[0] - 35, head[1], feet[0] + 35, feet[1]]
        self.frames = []
        self.truth = []
        for index in range(int(self.duration * fps)):
            time = index / fps
            position = self.position_at(time)
            u, v = self.camera.project(position)
            u += random.normal(0, noise) if noise else 0.0
            v += random.normal(0, noise) if noise else 0.0
            ground = self.camera.backproject(u, v + 4, 0.0)
            self.truth.append(position)
            self.frames.append({
                "frame_index": index,
                "timestamp_seconds": time,
                "court_corners": self.corners,
                "detections": [
                    {
                        "class": "player", "confidence": 0.9, "bbox": player_box,
                        "x_meters": self.player[0], "y_meters": self.player[1],
                    },
                    {
                        "class": "ball", "confidence": 0.7, "bbox": [u - 4, v - 4, u + 4, v + 4],
                        "x_meters": ground[0], "y_meters": ground[1],
                    },
                ],
            })

    def position_at(self, time):
        start, state = next(leg for leg in reversed(self.legs) if leg[0] <= time)
        return _simulate(state, [time - start])[0][:3]


class CameraTests(unittest.TestCase):
    def test_recovers_focal_length_and_projection_from_rounded_corners(self):
        for focal, offset in ((2600.0, 0.0), (1800.0, 0.0), (2600.0, 1.5), (3500.0, -3.0)):
            truth = broadcast_camera(focal, offset)
            corners = court_corners(truth)
            self.assertAlmostEqual(estimate_focal_length(corners, IMAGE_SIZE) / focal, 1.0, delta=0.02)
            camera = estimate_camera(corners, IMAGE_SIZE)
            for point in ((12.0, 5.0, 1.0), (3.0, 2.0, 2.5), (20.0, 9.0, 0.0)):
                self.assertLess(math.dist(camera.project(point), truth.project(point)), 2.0)

    def test_backprojection_inverts_projection_at_a_known_height(self):
        camera = broadcast_camera()
        u, v = camera.project((7.0, 3.0, 1.4))
        x, y = camera.backproject(u, v, 1.4)
        self.assertAlmostEqual(x, 7.0, places=6)
        self.assertAlmostEqual(y, 3.0, places=6)

    def test_rejects_corners_that_are_not_a_perspective_view_of_a_court(self):
        self.assertIsNone(estimate_camera([(0, 0), (63, 0), (63, 47), (0, 47)], (64, 48)))


class FlightTests(unittest.TestCase):
    def test_recovers_height_and_speed_of_a_noisy_flight_ending_in_a_bounce(self):
        truth = broadcast_camera()
        camera = estimate_camera(court_corners(truth), IMAGE_SIZE)
        state = (22.0, 5.0, 1.0, -24.0, 0.5, 3.5)
        duration = landing_time(state)
        random = np.random.default_rng(1)
        frames = []
        times = [index / 30 for index in range(int(duration * 30))]
        for index, time in enumerate(times):
            u, v = truth.project(_simulate(state, [time])[0][:3])
            u, v = u + random.normal(0, 1.0), v + random.normal(0, 1.0)
            frames.append({
                "frame_index": index, "timestamp_seconds": time,
                "detections": [{"class": "ball", "confidence": 0.7, "bbox": [u - 3, v - 3, u + 3, v + 3]}],
            })
        samples = collect_ball_samples(frames)

        flight = fit_flight(samples, [camera] * len(samples), IMAGE_SIZE[0], end=Contact("bounce", duration))

        self.assertIsNotNone(flight)
        for time in times:
            self.assertAlmostEqual(flight.position_at(time)[2], _simulate(state, [time])[0][2], delta=0.25)
        self.assertAlmostEqual(flight.speed_at(0.0), math.hypot(*state[3:]), delta=1.5)

    def test_gives_up_without_a_camera_or_enough_samples(self):
        camera = broadcast_camera()
        frames = [{
            "frame_index": index, "timestamp_seconds": index / 30,
            "detections": [{"class": "ball", "confidence": 0.7, "bbox": [100 + index, 100, 106 + index, 106]}],
        } for index in range(8)]
        samples = collect_ball_samples(frames)
        self.assertIsNone(fit_flight(samples, [None] * 8, 1920))
        self.assertIsNone(fit_flight(samples[:3], [camera] * 3, 1920))

    def test_drag_free_fall_matches_gravity(self):
        height = _simulate((0, 0, 10.0, 0, 0, 0), [0.2])[0][2]
        self.assertAlmostEqual(height, 10.0 - GRAVITY * 0.02, delta=0.01)


class SyntheticRallyTests(unittest.TestCase):
    def check(self, rally, tolerance_meters):
        frame_seconds = rally.frames[1]["timestamp_seconds"]
        events = build_events(rally.frames, *IMAGE_SIZE)

        bounce = min(
            events["bounces"],
            key=lambda bounce: abs(bounce["timestamp_seconds"] - rally.second_bounce),
            default=None,
        )
        self.assertIsNotNone(bounce)
        self.assertAlmostEqual(bounce["timestamp_seconds"], rally.second_bounce, delta=2 * frame_seconds)
        self.assertEqual(bounce["method"], "fit3d")
        self.assertEqual(bounce["side"], "far")
        self.assertAlmostEqual(bounce["x_meters"], rally.landing[0], delta=tolerance_meters)
        self.assertAlmostEqual(bounce["y_meters"], rally.landing[1], delta=tolerance_meters)
        for other in events["bounces"]:
            self.assertTrue(any(
                abs(other["timestamp_seconds"] - time) <= 2 * frame_seconds
                for time in (rally.first_bounce, rally.second_bounce)
            ), other)

        self.assertEqual(len(events["hits"]), 1)
        hit = events["hits"][0]
        self.assertAlmostEqual(hit["timestamp_seconds"], rally.hit, delta=4 * frame_seconds)
        self.assertEqual(hit["player"], "near")
        self.assertAlmostEqual(hit["speed_kmh"], math.hypot(24.0, 0.5, 3.5) * 3.6, delta=12)
        self.assertAlmostEqual(hit["ball"]["z"], rally.position_at(rally.hit)[2], delta=tolerance_meters)

        flying = [
            (frame, truth) for frame, truth in zip(rally.frames, rally.truth)
            if rally.hit + 0.1 < frame["timestamp_seconds"] < rally.second_bounce - 0.05
        ]
        self.assertTrue(flying)
        for frame, truth in flying:
            ball = frame["detections"][1]
            self.assertAlmostEqual(ball["z_meters"], truth[2], delta=tolerance_meters)
            self.assertAlmostEqual(ball["x_meters"], truth[0], delta=2 * tolerance_meters)

    def test_reconstructs_a_clean_rally(self):
        self.check(SyntheticRally(fps=60), 0.3)

    def test_reconstructs_a_noisy_rally_at_30_fps(self):
        self.check(SyntheticRally(fps=30, noise=0.8, seed=3), 0.5)

    def test_finds_a_bounce_hidden_in_frames_where_the_ball_was_not_seen(self):
        rally = SyntheticRally(fps=60)
        frame_seconds = rally.frames[1]["timestamp_seconds"]
        # A fast ball over clay is often invisible for the last frames before it lands.
        for frame in rally.frames:
            if rally.second_bounce - 10 * frame_seconds < frame["timestamp_seconds"] < rally.second_bounce:
                frame["detections"] = frame["detections"][:1]

        events = build_events(rally.frames, *IMAGE_SIZE)

        bounce = min(events["bounces"], key=lambda bounce: abs(bounce["timestamp_seconds"] - rally.second_bounce))
        self.assertAlmostEqual(bounce["timestamp_seconds"], rally.second_bounce, delta=2 * frame_seconds)
        self.assertEqual((bounce["side"], bounce["method"]), ("far", "fit3d"))
        self.assertAlmostEqual(bounce["x_meters"], rally.landing[0], delta=1.0)
        self.assertAlmostEqual(bounce["y_meters"], rally.landing[1], delta=1.0)
        self.assertEqual([hit["player"] for hit in events["hits"]], ["near"])

    def assert_second_bounce_found(self, rally, events):
        frame_seconds = rally.frames[1]["timestamp_seconds"]
        bounce = min(events["bounces"], key=lambda bounce: abs(bounce["timestamp_seconds"] - rally.second_bounce))
        self.assertAlmostEqual(bounce["timestamp_seconds"], rally.second_bounce, delta=2 * frame_seconds)
        self.assertEqual((bounce["side"], bounce["method"]), ("far", "fit3d"))
        self.assertAlmostEqual(bounce["x_meters"], rally.landing[0], delta=1.0)

    def test_finds_a_bounce_in_front_of_the_far_player_who_overlaps_it_on_screen(self):
        rally = SyntheticRally(fps=50)
        # Three meters behind the bounce: close on screen, out of reach on court.
        x, y = rally.landing[0] - 3.0, rally.landing[1]
        feet, head = rally.camera.project((x, y, 0.0)), rally.camera.project((x, y, 1.85))
        for frame in rally.frames:
            frame["detections"].insert(1, {
                "class": "player", "confidence": 0.9,
                "bbox": [feet[0] - 20, head[1], feet[0] + 20, feet[1]],
                "x_meters": x, "y_meters": y,
            })

        self.assert_second_bounce_found(rally, build_events(rally.frames, *IMAGE_SIZE))

    def test_finds_a_bounce_after_a_hit_missed_while_the_ball_was_unseen(self):
        rally = SyntheticRally(fps=50)
        frame_seconds = rally.frames[1]["timestamp_seconds"]
        # The ball is lost around the stroke and the detector loses the hitter too.
        for frame in rally.frames:
            offset = abs(frame["timestamp_seconds"] - rally.hit)
            if offset < 8 * frame_seconds:
                frame["detections"] = [d for d in frame["detections"] if d["class"] != "ball"]
            if offset < 0.3:
                frame["detections"] = [d for d in frame["detections"] if d["class"] != "player"]

        self.assert_second_bounce_found(rally, build_events(rally.frames, *IMAGE_SIZE))

    def test_finds_a_hit_while_the_detector_lost_the_hitter(self):
        rally = SyntheticRally(fps=50)
        lost = [frame for frame in rally.frames if abs(frame["timestamp_seconds"] - rally.hit) < 0.25]
        for frame in lost:
            frame["detections"] = [d for d in frame["detections"] if d["class"] != "player"]

        events = build_events(rally.frames, *IMAGE_SIZE)

        self.assertEqual([hit["player"] for hit in events["hits"]], ["near"])
        self.assertAlmostEqual(events["hits"][0]["timestamp_seconds"], rally.hit, delta=0.06)
        # The exported telemetry keeps only what was detected.
        self.assertFalse([d for frame in lost for d in frame["detections"] if d["class"] == "player"])

    def test_finds_a_groundstroke_while_the_ball_is_hidden_behind_the_hitter(self):
        rally = SyntheticRally(fps=50)
        frame_seconds = rally.frames[1]["timestamp_seconds"]
        for frame in rally.frames:
            if 0 < frame["timestamp_seconds"] - rally.hit < 12 * frame_seconds:
                frame["detections"] = frame["detections"][:1]

        events = build_events(rally.frames, *IMAGE_SIZE)

        self.assertEqual([hit["player"] for hit in events["hits"]], ["near"])
        self.assertAlmostEqual(events["hits"][0]["timestamp_seconds"], rally.hit, delta=2 * frame_seconds)

    def test_a_gap_without_a_bounce_adds_no_event(self):
        rally = SyntheticRally(fps=60)
        frame_seconds = rally.frames[1]["timestamp_seconds"]
        middle = (rally.hit + rally.second_bounce) / 2
        for frame in rally.frames:
            if abs(frame["timestamp_seconds"] - middle) < 5 * frame_seconds:
                frame["detections"] = frame["detections"][:1]

        events = build_events(rally.frames, *IMAGE_SIZE)

        self.assertFalse([
            bounce for bounce in events["bounces"]
            if rally.hit < bounce["timestamp_seconds"] < rally.second_bounce - 2 * frame_seconds
        ])

    def test_smooth_flight_has_no_events_and_falls_back_without_calibration(self):
        rally = SyntheticRally(fps=60)
        flight = [
            frame for frame in rally.frames
            if rally.hit + 0.05 < frame["timestamp_seconds"] < rally.second_bounce - 0.05
        ]
        for frame in flight:
            frame["detections"] = frame["detections"][1:]
        self.assertEqual(build_events(flight, *IMAGE_SIZE), {"bounces": [], "hits": []})

        uncalibrated = SyntheticRally(fps=60)
        for frame in uncalibrated.frames:
            frame["court_corners"] = None
        events = build_events(uncalibrated.frames, *IMAGE_SIZE)
        self.assertTrue(all(bounce["method"] == "image2d" for bounce in events["bounces"]))
        self.assertTrue(all(
            detection["z_meters"] is None
            for frame in uncalibrated.frames
            for detection in frame["detections"]
            if detection["class"] == "ball"
        ))


def bounce_frames(positions, width=1000, height=720):
    frames = []
    for index, position in enumerate(positions):
        if isinstance(position, (int, float)):
            position = (100, position)
        frames.append({
            "frame_index": index,
            "timestamp_seconds": index / 30,
            "detections": [] if position is None else [{
                "class": "ball", "confidence": 0.9,
                "bbox": [position[0], position[1] - 5, position[0] + 5, position[1]],
                "x_meters": 10, "y_meters": 4,
            }],
        })
    return frames, width, height


class BounceHeuristicTests(unittest.TestCase):
    def bounce_frames_at(self, positions, **size):
        frames, width, height = bounce_frames(positions, **size)
        return [
            round(bounce["timestamp_seconds"] * 30)
            for bounce in detect_bounces(frames, width, height)
        ]

    def test_detects_a_vertical_reversal_with_its_position_and_time(self):
        frames, width, height = bounce_frames([90, 94, 100, 97, 94])
        bounce, = detect_bounces(frames, width, height)
        self.assertAlmostEqual(bounce["timestamp_seconds"], 2 / 30, delta=1 / 60)
        self.assertEqual((bounce["frame_index"], bounce["x_meters"], bounce["y_meters"]), (2, 10, 4))
        self.assertEqual((bounce["side"], bounce["method"]), ("far", "image2d"))

    def test_ignores_uninterrupted_motion_and_stationary_noise(self):
        self.assertEqual(self.bounce_frames_at([90, 92, 94, 96, 98]), [])
        self.assertEqual(self.bounce_frames_at([100, 101, 102, 101, 100]), [])

    def test_does_not_join_trajectories_across_gaps_or_jumps(self):
        self.assertEqual(self.bounce_frames_at([90, 94, None, None, None, None, None, 100, 97, 94]), [])
        self.assertEqual(self.bounce_frames_at([(100, 90), (100, 94), (500, 100), (500, 97), (500, 94)]), [])
        self.assertEqual(self.bounce_frames_at([(100, 90), (100, 94), (900, 100), (900, 94), (900, 88)]), [])
        self.assertEqual(self.bounce_frames_at([90, *[None] * 11, 100, 94, 88]), [])
        self.assertEqual(self.bounce_frames_at([(900, 330), None, None, (512, 522), (513, 515), (514, 505)]), [])

    def test_counts_flat_and_gradual_peaks_once(self):
        self.assertEqual(self.bounce_frames_at([90, 94, 100, 100, 94, 90]), [2])
        self.assertEqual(self.bounce_frames_at([94, 95, 96, 97, 98, 99, 100, 99, 98, 97, 96, 95, 94]), [6])

    def test_keeps_a_bounce_across_a_short_gap_or_after_a_long_one(self):
        self.assertEqual(self.bounce_frames_at([90, 94, 100, None, 96, 92]), [2])
        self.assertEqual(self.bounce_frames_at([90, *[None] * 12, 90, 94, 100, 97, 94]), [15])

    def test_ignores_reversals_at_a_player(self):
        frames, width, height = bounce_frames([90, 94, 100, 97, 94])
        for frame in frames:
            frame["detections"].append({
                "class": "player", "confidence": 0.9, "bbox": [80, 60, 130, 110], "x_meters": 10, "y_meters": 4,
            })
        self.assertEqual(detect_bounces(frames, width, height), [])

    def test_ignores_wobbles_spikes_and_sideways_reversals(self):
        full_hd = {"width": 1920, "height": 1080}
        self.assertEqual(
            self.bounce_frames_at([354, 362, 372, 384, 388, 416, 426, 422, 454, 473, 486], **full_hd), []
        )
        self.assertEqual(self.bounce_frames_at(
            [(1373, 828), (1388, 831), (1316, 942), (1421, 848), (1442, 853)], **full_hd
        ), [])
        self.assertEqual(self.bounce_frames_at(
            [(100, 90), (120, 94), (140, 100), (120, 97), (100, 94)]
        ), [])
        self.assertEqual(self.bounce_frames_at(
            [(1117, 374), (1123, 381), (1128, 386), (1132, 376), (1136, 366)], **full_hd
        ), [2])

    def test_ignores_candidates_projected_outside_the_court(self):
        frames, width, height = bounce_frames([90, 94, 100, 97, 94])
        for frame in frames:
            frame["detections"][0]["x_meters"] = 24.2
        self.assertEqual(detect_bounces(frames, width, height), [])

    def test_keeps_a_deep_bounce_whose_rising_ball_projects_beyond_the_baseline(self):
        frames, width, height = bounce_frames([90, 94, 100, 97, 94])
        for frame in frames[3:]:
            frame["detections"][0]["x_meters"] = -0.8
        self.assertEqual([bounce["frame_index"] for bounce in detect_bounces(frames, width, height)], [2])


# Ball centres observed in a short real clip, as (frame, x, y) at 60 fps.
SERVE_TOSS_AND_HIT = [
    (82, 1094, 502), (83, 1095, 502), (84, 1098, 502), (85, 1100, 502), (86, 1102, 502),
    (87, 1104, 502), (88, 1106, 502), (89, 1108, 504), (90, 1110, 505), (91, 1111, 507),
    (92, 1113, 509), (93, 1115, 511), (95, 1090, 488), (96, 1076, 478), (98, 1040, 450),
    (99, 1028, 440), (101, 1003, 422), (102, 990, 413), (103, 979, 406), (104, 970, 399),
    (105, 961, 394),
]
APEX_HIT_BY_FAR_PLAYER = [
    (149, 858, 157), (150, 858, 154), (151, 858, 152), (152, 858, 150), (153, 858, 148),
    (154, 858, 146), (155, 858, 144), (156, 858, 144), (157, 858, 142), (158, 858, 142),
    (159, 858, 140), (160, 858, 140), (161, 858, 140), (170, 880, 150), (173, 893, 158),
    (175, 902, 164), (176, 906, 167), (178, 916, 174), (181, 930, 190), (182, 935, 194),
    (184, 947, 205), (185, 951, 210), (187, 956, 216),
]
SMOOTH_FLIGHT_AFTER_SERVE = [
    (101, 1003, 422), (102, 990, 413), (103, 979, 406), (104, 970, 399), (105, 961, 394),
    (107, 945, 384), (108, 938, 380), (109, 934, 378), (110, 928, 375), (111, 924, 374),
    (112, 919, 372), (113, 916, 372), (114, 910, 370), (115, 909, 372), (116, 906, 371),
]
BOUNCE_AT_MID_COURT = [
    (112, 919, 372), (113, 916, 372), (114, 910, 370), (115, 909, 372), (116, 906, 371),
    (117, 903, 371), (118, 901, 372), (119, 900, 372), (120, 898, 374), (121, 896, 373),
    (122, 892, 356), (124, 887, 330), (125, 885, 319), (126, 883, 308), (127, 882, 297),
    (128, 878, 285), (129, 877, 278), (130, 874, 266),
]
FAR_PLAYER_BOX = [791, 108, 833, 201]


def hit_frames(samples, player_box, carried=()):
    return [{
        "frame_index": index,
        "timestamp_seconds": index / 60,
        "detections": [
            {
                "class": "ball", "confidence": 0.65, "bbox": [x - 2, y - 2, x + 2, y + 2],
                "x_meters": 10, "y_meters": 4, "carried_forward": index in carried,
            },
            {"class": "player", "confidence": 0.9, "bbox": player_box, "x_meters": 4, "y_meters": 4},
        ],
    } for index, x, y in samples]


class HitHeuristicTests(unittest.TestCase):
    def hits(self, samples, player_box, bounces=(), **options):
        return [
            round(hit.time * 60)
            for hit in detect_hits(hit_frames(samples, player_box, **options), 1920, bounces)
        ]

    def test_detects_a_serve_after_an_almost_stationary_toss(self):
        hit, = self.hits(SERVE_TOSS_AND_HIT, [1053, 544, 1133, 815])
        self.assertTrue(90 <= hit <= 96, hit)

    def test_detects_a_hit_where_the_ball_stalls_at_its_apex(self):
        hit, = self.hits(APEX_HIT_BY_FAR_PLAYER, FAR_PLAYER_BOX)
        self.assertTrue(158 <= hit <= 168, hit)

    def test_ignores_smooth_flight_bounces_and_tracking_jumps(self):
        self.assertEqual(self.hits(SMOOTH_FLIGHT_AFTER_SERVE, [990, 400, 1130, 600]), [])
        self.assertEqual(self.hits(BOUNCE_AT_MID_COURT, [100, 600, 160, 800]), [])
        self.assertEqual(self.hits(BOUNCE_AT_MID_COURT, [880, 300, 920, 420], bounces=[120 / 60]), [])
        self.assertEqual(self.hits([
            (262, 772, 285), (263, 770, 279), (264, 766, 274), (265, 806, 190), (266, 804, 191),
            (267, 801, 192), (268, 798, 194), (269, 794, 196),
        ], FAR_PLAYER_BOX), [])

    def test_ignores_carried_forward_ball_positions(self):
        samples = [(index, x, 60) for index, x in enumerate((80, 95, 110, 125, 110, 95, 80))]
        box = [115, 35, 175, 115]
        frames = [dict(frame, timestamp_seconds=frame["frame_index"] / 30) for frame in hit_frames(samples, box)]
        self.assertEqual(len(detect_hits(frames, 1920)), 1)
        carried = [
            dict(frame, timestamp_seconds=frame["frame_index"] / 30)
            for frame in hit_frames(samples, box, carried=(2, 3, 4))
        ]
        self.assertEqual(detect_hits(carried, 1920), [])

    def test_a_player_box_carried_forward_at_the_stroke_still_reaches_the_ball(self):
        samples = [(index, x, 60) for index, x in enumerate((80, 95, 110, 125, 110, 95, 80))]
        frames = [
            dict(frame, timestamp_seconds=frame["frame_index"] / 30)
            for frame in hit_frames(samples, [140, 35, 200, 115])
        ]
        for frame in frames[2:5]:
            frame["detections"][1]["carried_forward"] = True
        self.assertEqual(len(detect_hits(frames, 1920)), 1)


def vanishing_frames(reappearance):
    """A far server's toss falls above their head, then the ball is unseen until `reappearance`."""
    server = {"class": "player", "confidence": 0.9, "bbox": [880, 140, 930, 260], "x_meters": -0.5, "y_meters": 4.5}
    frames = []
    for index in range(30):
        detections = [dict(server)]
        if index <= 8:
            detections.append({
                "class": "ball", "confidence": 0.9, "bbox": [915, 70 + 3 * index, 921, 76 + 3 * index],
                "x_meters": -12.0, "y_meters": 4.5,
            })
        elif index == 26:
            x, y, x_meters = reappearance
            detections.append({
                "class": "ball", "confidence": 0.9, "bbox": [x - 3, y - 3, x + 3, y + 3],
                "x_meters": x_meters, "y_meters": 6.0,
            })
        frames.append({"frame_index": index, "timestamp_seconds": index / 50, "detections": detections})
    return frames


class VanishingStrokeTests(unittest.TestCase):
    def test_a_serve_too_fast_to_see_is_placed_at_the_last_sight_of_the_toss(self):
        stroke, = detect_vanishing_strokes(vanishing_frames((1010, 600, 17.0)), 1920, [])
        self.assertEqual(stroke.frame["frame_index"], 8)

    def test_a_ball_that_reappears_where_its_fall_was_taking_it_was_not_struck(self):
        self.assertEqual(detect_vanishing_strokes(vanishing_frames((918, 127, 12.5)), 1920, []), [])

    def test_a_ball_that_reappears_on_the_server_side_was_not_served(self):
        self.assertEqual(detect_vanishing_strokes(vanishing_frames((1010, 600, 8.0)), 1920, []), [])


def shot_frame(index, detections):
    return {"frame_index": index, "timestamp_seconds": index / 50, "detections": detections}


def shot_player(bbox, x, y):
    return {"class": "player", "confidence": 0.9, "bbox": bbox, "x_meters": x, "y_meters": y}


def shot_ball(bbox, x, y):
    return {"class": "ball", "confidence": 0.8, "bbox": bbox, "x_meters": x, "y_meters": y}


class ShotClassificationTests(unittest.TestCase):
    def test_ground_speed_uses_the_median_of_valid_segments(self):
        frames = [
            shot_frame(index, [shot_ball([0, 0, 4, 4], x, 5)])
            for index, x in enumerate((1, 1.5, 4.5, 2.5))
        ]
        self.assertEqual(round(estimate_ground_speed_kmh(frames, 0)), 90)
        frames = [shot_frame(0, [shot_ball([0, 0, 4, 4], 1, 5)]), shot_frame(1, [shot_ball([0, 0, 4, 4], None, None)])]
        self.assertIsNone(estimate_ground_speed_kmh(frames, 0))

    def test_classifies_serve_volley_and_groundstrokes(self):
        far_server = shot_player([900, 100, 960, 220], -0.5, 4)
        near_volleyer = shot_player([800, 600, 900, 800], 15, 5)
        frames = [
            shot_frame(0, [far_server, shot_ball([930, 90, 940, 100], 0, 4)]),
            shot_frame(50, [near_volleyer, shot_ball([920, 650, 930, 660], 15, 5)]),
            shot_frame(100, [near_volleyer, shot_ball([920, 650, 930, 660], 15, 5)]),
        ]
        bounces = [{"timestamp_seconds": 1.5, "side": "near"}]

        hits = classify_hits(frames, collect_ball_samples(frames), bounces)

        self.assertEqual(
            [(hit["player"], hit["type"], hit["point_index"]) for hit in hits],
            [("far", "serve", 0), ("near", "volley", 0), ("near", "forehand", 0)],
        )

    def test_uses_handedness_for_groundstrokes(self):
        frames = [shot_frame(0, [shot_player([800, 600, 900, 800], 20, 5), shot_ball([920, 650, 930, 660], 20, 5)])]
        hit, = classify_hits(frames, collect_ball_samples(frames), [], {"near": "left"})
        self.assertEqual(hit["type"], "backhand")


if __name__ == "__main__":
    unittest.main()
