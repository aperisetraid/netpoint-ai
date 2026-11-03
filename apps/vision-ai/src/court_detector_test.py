import unittest
from pathlib import Path

import cv2
import numpy as np

from court_detector import CourtDetector


class CourtDetectorTests(unittest.TestCase):
    def test_selects_court_baseline_over_contaminated_hough_cluster(self):
        video_path = Path(__file__).resolve().parents[2] / "assets" / "Test - Trim.mp4"
        capture = cv2.VideoCapture(str(video_path))
        self.addCleanup(capture.release)
        self.assertTrue(capture.isOpened())
        capture.set(cv2.CAP_PROP_POS_FRAMES, 14)
        success, frame = capture.read()
        self.assertTrue(success)

        corners = CourtDetector().detect_corners(frame)

        self.assertIsNotNone(corners)
        expected = np.asarray(
            [[643, 270], [1273, 270], [1558, 847], [342, 851]],
            dtype=np.int32,
        )
        np.testing.assert_allclose(corners, expected, atol=25)

    def test_selects_outer_doubles_sideline_over_inner_singles_line(self):
        video_path = Path(__file__).resolve().parents[2] / "assets" / "Test - Trim.mp4"
        capture = cv2.VideoCapture(str(video_path))
        self.addCleanup(capture.release)
        self.assertTrue(capture.isOpened())
        capture.set(cv2.CAP_PROP_POS_FRAMES, 375)
        success, frame = capture.read()
        self.assertTrue(success)

        corners = CourtDetector().detect_corners(frame)

        self.assertIsNotNone(corners)
        expected = np.asarray(
            [[643, 270], [1273, 270], [1558, 847], [342, 851]],
            dtype=np.int32,
        )
        np.testing.assert_allclose(corners, expected, atol=25)

    def test_selects_far_baseline_from_sequentially_decoded_video_frame(self):
        video_path = Path(__file__).resolve().parents[2] / "assets" / "Test - Trim.mp4"
        capture = cv2.VideoCapture(str(video_path))
        self.addCleanup(capture.release)
        self.assertTrue(capture.isOpened())
        for _ in range(201):
            success, frame = capture.read()
            self.assertTrue(success)

        corners = CourtDetector().detect_corners(frame)

        self.assertIsNotNone(corners)
        expected = np.asarray(
            [[644, 270], [1272, 271], [1558, 847], [350, 845]],
            dtype=np.int32,
        )
        np.testing.assert_allclose(corners, expected, atol=25)

    def test_selects_court_over_advertising_net_and_center_lines(self):
        frame = np.full((720, 962, 3), (30, 30, 180), dtype=np.uint8)
        expected = np.asarray(
            [[260, 105], [700, 105], [900, 650], [60, 650]],
            dtype=np.int32,
        )
        cv2.polylines(frame, [expected], True, (245, 245, 245), 3)
        cv2.line(frame, (0, 50), (961, 50), (245, 245, 245), 3)
        cv2.line(frame, (0, 290), (961, 290), (245, 245, 245), 3)
        cv2.line(frame, (530, 40), (530, 700), (245, 245, 245), 3)

        corners = CourtDetector().detect_corners(frame)

        self.assertIsNotNone(corners)
        np.testing.assert_allclose(corners, expected, atol=20)

    def test_rejects_background_lines_without_diagonal_court_sides(self):
        frame = np.zeros((720, 962, 3), dtype=np.uint8)
        cv2.line(frame, (0, 50), (961, 50), (255, 255, 255), 3)
        cv2.line(frame, (0, 290), (961, 290), (255, 255, 255), 3)
        cv2.line(frame, (0, 650), (961, 650), (255, 255, 255), 3)
        cv2.line(frame, (530, 40), (530, 700), (255, 255, 255), 3)

        self.assertIsNone(CourtDetector().detect_corners(frame))

    def test_selects_court_when_both_sides_converge_in_same_direction(self):
        frame = np.full((720, 962, 3), (30, 30, 180), dtype=np.uint8)
        expected = np.asarray(
            [[280, 110], [720, 95], [590, 650], [80, 590]],
            dtype=np.int32,
        )
        cv2.polylines(frame, [expected], True, (245, 245, 245), 3)
        cv2.line(frame, (0, 50), (961, 50), (245, 245, 245), 3)
        cv2.line(frame, (0, 300), (961, 300), (245, 245, 245), 3)
        cv2.line(frame, (520, 40), (520, 700), (245, 245, 245), 3)

        corners = CourtDetector().detect_corners(frame)

        self.assertIsNotNone(corners)
        np.testing.assert_allclose(corners, expected, atol=25)

    def test_rejects_signage_line_above_far_baseline(self):
        frame = np.full((420, 752, 3), (50, 130, 50), dtype=np.uint8)
        expected = np.asarray(
            [[250, 78], [490, 75], [690, 395], [78, 348]],
            dtype=np.int32,
        )
        cv2.polylines(frame, [expected], True, (245, 245, 245), 3)
        cv2.line(frame, (0, 48), (751, 48), (245, 245, 245), 3)
        cv2.line(frame, (0, 200), (751, 200), (245, 245, 245), 3)
        cv2.line(frame, (480, 30), (480, 400), (245, 245, 245), 3)

        corners = CourtDetector().detect_corners(frame)

        self.assertIsNotNone(corners)
        np.testing.assert_allclose(corners, expected, atol=25)
        self.assertGreaterEqual(sum(point[1] for point in corners[:2]) / 2, 420 * 0.13)

    def test_rejects_court_with_corners_outside_frame(self):
        frame = np.full((720, 962, 3), (30, 30, 180), dtype=np.uint8)
        clipped_court = np.asarray(
            [[-25, 110], [700, 110], [950, 650], [-20, 650]],
            dtype=np.int32,
        )
        cv2.polylines(frame, [clipped_court], True, (245, 245, 245), 3)

        self.assertIsNone(CourtDetector().detect_corners(frame))


if __name__ == "__main__":
    unittest.main()