import unittest

from tracker import MAX_PLAYER_CARRY_FORWARD_FRAMES, fill_skipped_player_frames, median_corners


class CourtSmoothingTests(unittest.TestCase):
    def test_one_tilted_detection_does_not_move_the_calibration(self):
        steady = [(633, 261), (1279, 265), (1509, 815), (412, 809)]
        jittered = [(632, 262), (1278, 264), (1510, 814), (411, 808)]
        tilted = [(637, 247), (1282, 275), (1511, 816), (410, 808)]
        self.assertEqual(median_corners([steady, tilted, jittered]), [(633, 261), (1279, 265), (1510, 815), (411, 808)])


def player(x, y=5.0, bbox=(0.0, 0.0, 10.0, 20.0), confidence=0.9, **extra):
    return {"class": "player", "confidence": confidence, "bbox": list(bbox), "x_meters": x, "y_meters": y, **extra}


def telemetry(frames):
    return [
        {"frame_index": index, "timestamp_seconds": index / 25, "detections": list(detections)}
        for index, detections in enumerate(frames)
    ]


class PlayerInterpolationTests(unittest.TestCase):
    def test_skipped_frame_is_interpolated_between_detections_per_side(self):
        frames = telemetry([
            [player(2.0, bbox=(0, 0, 10, 20)), player(20.0, bbox=(100, 0, 110, 20))],
            [],
            [player(4.0, bbox=(10, 0, 20, 20), confidence=0.7), player(18.0, bbox=(90, 0, 100, 20))],
        ])

        fill_skipped_player_frames(frames, [1])

        far, near = frames[1]["detections"]
        self.assertEqual((far["x_meters"], far["bbox"], far["confidence"]), (3.0, [5.0, 0.0, 15.0, 20.0], 0.7))
        self.assertEqual((near["x_meters"], near["bbox"]), (19.0, [95.0, 0.0, 105.0, 20.0]))
        self.assertTrue(far["interpolated"] and near["interpolated"])
        self.assertNotIn("interpolated", frames[0]["detections"][0])

    def test_without_a_later_detection_the_last_one_is_carried_for_a_few_frames_only(self):
        frames = telemetry([[player(2.0)]] + [[] for _ in range(MAX_PLAYER_CARRY_FORWARD_FRAMES + 2)])
        skipped = list(range(1, len(frames)))

        fill_skipped_player_frames(frames, skipped)

        for index in range(1, MAX_PLAYER_CARRY_FORWARD_FRAMES + 1):
            self.assertTrue(frames[index]["detections"][0]["carried_forward"])
        self.assertEqual(frames[MAX_PLAYER_CARRY_FORWARD_FRAMES + 1]["detections"], [])

    def test_a_side_with_no_player_gets_nothing_and_balls_stay_after_players(self):
        ball = {"class": "ball", "confidence": 0.5, "bbox": [1, 1, 2, 2], "x_meters": None, "y_meters": None}
        frames = telemetry([[player(2.0)], [ball], [player(3.0)]])

        fill_skipped_player_frames(frames, [1])

        classes = [detection["class"] for detection in frames[1]["detections"]]
        self.assertEqual(classes, ["player", "ball"])

    def test_carried_forward_detections_are_not_used_as_anchors(self):
        frames = telemetry([[player(2.0)], [], [player(9.0, carried_forward=True)]])

        fill_skipped_player_frames(frames, [1])

        self.assertEqual(frames[1]["detections"][0]["x_meters"], 2.0)
        self.assertTrue(frames[1]["detections"][0]["carried_forward"])


if __name__ == "__main__":
    unittest.main()
