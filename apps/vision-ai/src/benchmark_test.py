import copy
import unittest

import benchmark
import stage_timers as profiling


def frame(index, ball=None, players=()):
    detections = [{"class": "ball", "confidence": 0.5, "bbox": ball, "x_meters": None, "y_meters": None}] if ball else []
    detections += [
        {"class": "player", "confidence": 0.9, "bbox": [0, 0, 1, 1], "x_meters": x, "y_meters": y} for x, y in players
    ]
    return {"frame_index": index, "timestamp_seconds": index / 25, "detections": detections}


def telemetry():
    return {
        "frames": [frame(i, [10 + i, 20, 14 + i, 24], [(2.0, 5.0), (20.0, 5.0)]) for i in range(10)],
        "events": {
            "bounces": [{"frame_index": 4}],
            "hits": [{"frame_index": 2, "player": "far", "type": "serve"}],
        },
    }


class BenchmarkTests(unittest.TestCase):
    def test_identical_output_has_no_problems(self):
        metrics = benchmark.compare(telemetry(), telemetry())
        self.assertTrue(metrics["identical"])
        self.assertEqual(benchmark.verdict(metrics), [])

    def test_small_drift_is_accepted_but_lost_events_are_not(self):
        new = telemetry()
        new["events"]["bounces"][0]["frame_index"] = 5
        new["frames"][3]["detections"][-1]["x_meters"] += 0.1
        self.assertEqual(benchmark.verdict(benchmark.compare(telemetry(), new)), [])

        lost = copy.deepcopy(new)
        lost["events"]["bounces"] = []
        self.assertIn("botes 0/1 (nuevos 0)", benchmark.verdict(benchmark.compare(telemetry(), lost)))

        wrong_type = copy.deepcopy(new)
        wrong_type["events"]["hits"][0]["type"] = "volley"
        self.assertTrue(any(p.startswith("golpes") for p in benchmark.verdict(benchmark.compare(telemetry(), wrong_type))))

    def test_missing_ball_frames_and_position_errors_are_reported(self):
        new = telemetry()
        for index in range(4):
            new["frames"][index]["detections"] = [d for d in new["frames"][index]["detections"] if d["class"] != "ball"]
        problems = benchmark.verdict(benchmark.compare(telemetry(), new))
        self.assertTrue(any("frames con pelota" in problem for problem in problems))

        shifted = telemetry()
        for item in shifted["frames"]:
            item["detections"][0]["bbox"][0] += 6
            item["detections"][0]["bbox"][2] += 6
        self.assertTrue(any("error de pelota" in p for p in benchmark.verdict(benchmark.compare(telemetry(), shifted))))

    def test_profiling_is_a_noop_until_enabled(self):
        profiling.reset()
        with profiling.stage("idle"):
            pass
        self.assertEqual(profiling.report(), {})


if __name__ == "__main__":
    unittest.main()
