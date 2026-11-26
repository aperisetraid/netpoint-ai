import json
import tempfile
import unittest
from pathlib import Path

import cv2
import numpy as np

import court_colors
from court_colors import COLORS_FILE, court_colors as cached_court_colors, court_to_image, measure_court_colors, with_court_colors

# Corners as the pipeline stores them: far-left, far-right, near-right, near-left (a broadcast view).
CORNERS = [[230, 60], [410, 60], [520, 300], [120, 300]]
SURFACE_BGR = (175, 116, 85)  # US Open blue (#5574AF)
SURROUND_BGR = (119, 155, 118)  # and its green surround (#769B77)


def court_frame() -> np.ndarray:
    """A synthetic broadcast frame: green surround, blue court, white lines."""
    image = np.full((360, 640, 3), SURROUND_BGR, dtype=np.uint8)
    cv2.fillPoly(image, [np.asarray(CORNERS, dtype=np.int32)], SURFACE_BGR)
    homography = court_to_image(CORNERS)
    for start, end in (
        ((0, 1.37), (23.77, 1.37)), ((0, 9.6), (23.77, 9.6)),
        ((5.485, 1.37), (5.485, 9.6)), ((18.285, 1.37), (18.285, 9.6)), ((5.485, 5.485), (18.285, 5.485)),
    ):
        points = cv2.perspectiveTransform(np.asarray([[start, end]], dtype=np.float32), homography)[0]
        cv2.line(image, tuple(int(v) for v in points[0]), tuple(int(v) for v in points[1]), (255, 255, 255), 2)
    cv2.polylines(image, [np.asarray(CORNERS, dtype=np.int32)], True, (255, 255, 255), 2)
    return image


def hex_to_bgr(value: str) -> np.ndarray:
    return np.array([int(value[5:7], 16), int(value[3:5], 16), int(value[1:3], 16)])


class CourtColorsTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.folder = Path(self.directory.name)
        self.video = self.folder / "clip.avi"
        writer = cv2.VideoWriter(str(self.video), cv2.VideoWriter_fourcc(*"MJPG"), 25, (640, 360))
        frame = court_frame()
        # A player standing on the court must not tint the surface.
        cv2.rectangle(frame, (300, 180), (330, 260), (40, 40, 220), -1)
        for _ in range(4):
            writer.write(frame)
        writer.release()
        self.frames = [
            {"frame_index": index, "court_corners": CORNERS,
             "detections": [{"class": "player", "bbox": [300, 180, 330, 260]}]}
            for index in range(4)
        ]

    def assert_close(self, measured: str, expected_bgr: tuple[int, int, int]):
        difference = np.abs(hex_to_bgr(measured) - np.array(expected_bgr))
        self.assertLessEqual(int(difference.max()), 8, f"{measured} vs {expected_bgr}")

    def test_measures_the_surface_and_the_surround_apart(self):
        colors = measure_court_colors(self.video, self.frames)
        self.assert_close(colors["surface"], SURFACE_BGR)
        self.assert_close(colors["surround"], SURROUND_BGR)

    def test_no_calibrated_frame_or_no_video_gives_nothing(self):
        self.assertIsNone(measure_court_colors(self.video, [{"frame_index": 0, "court_corners": None}]))
        self.assertIsNone(measure_court_colors(self.folder / "missing.mp4", self.frames))

    def test_measures_once_and_reuses_the_cache(self):
        telemetry = {"court": {"calibrated": True}, "frames": self.frames}
        first = with_court_colors(self.folder, telemetry, self.video)["court"]["colors"]
        self.assertEqual(json.loads((self.folder / COLORS_FILE).read_text(encoding="utf-8")), first)
        self.video.unlink()
        self.assertEqual(cached_court_colors(self.folder, telemetry, None), first)

    def test_a_video_that_cannot_tell_is_remembered_and_leaves_the_court_alone(self):
        telemetry = {"court": {"calibrated": False}, "frames": [{"frame_index": 0}]}
        self.assertNotIn("colors", with_court_colors(self.folder, telemetry, self.video)["court"])
        self.assertEqual((self.folder / COLORS_FILE).read_text(encoding="utf-8"), "{}")

    def test_samples_avoid_the_lines_and_the_net(self):
        surface = court_colors.SURFACE_POINTS
        self.assertTrue(np.all(np.abs(surface[:, 0] - court_colors.NET_X) >= court_colors.NET_CLEARANCE_METERS))
        self.assertTrue(np.all(np.abs(surface[:, 1] - court_colors.SINGLES_INSET) >= court_colors.LINE_CLEARANCE_METERS))
        apron = court_colors.APRON_POINTS
        outside = (apron[:, 0] < 0) | (apron[:, 0] > court_colors.COURT_LENGTH) | (apron[:, 1] < 0) | (apron[:, 1] > court_colors.COURT_WIDTH)
        self.assertTrue(np.all(outside))


if __name__ == "__main__":
    unittest.main()
