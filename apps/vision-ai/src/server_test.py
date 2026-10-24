import asyncio
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import cv2
import numpy as np

import server
from tracker import TennisTracker, detect_tennis_ball_color


class FrameInspectionTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.video_path = Path(self.directory.name) / "video.mp4"
        writer = cv2.VideoWriter(
            str(self.video_path), cv2.VideoWriter_fourcc(*"mp4v"), 25, (64, 48)
        )
        for intensity in (30, 180):
            writer.write(np.full((48, 64, 3), intensity, dtype=np.uint8))
        writer.release()
        self.addCleanup(server.processed_videos.clear)
        self.addCleanup(server.progress_by_match.clear)

    def test_frame_extraction_and_missing_frames(self):
        server.processed_videos["test"] = (self.video_path, 2)
        response = asyncio.run(server.get_video_frame("test", 1))
        image = cv2.imdecode(
            np.frombuffer(response.body, dtype=np.uint8), cv2.IMREAD_COLOR
        )
        self.assertEqual(response.media_type, "image/jpeg")
        self.assertEqual(image.shape, (48, 64, 3))
        self.assertGreater(image.mean(), 150)
        for match_id, frame_index in (("missing", 0), ("test", 2)):
            with self.assertRaises(server.HTTPException) as caught:
                asyncio.run(server.get_video_frame(match_id, frame_index))
            self.assertEqual(caught.exception.status_code, 404)

    def test_tracker_exports_image_dimensions_and_calibration(self):
        tracker = TennisTracker.__new__(TennisTracker)
        tracker.target_classes = [0, 32]
        tracker.model = lambda *args, **kwargs: [SimpleNamespace(boxes=[])]
        corners = [(0, 0), (63, 0), (63, 47), (0, 47)]
        tracker.court_detector = SimpleNamespace(detect_corners=lambda frame: corners)
        with patch(
            "tracker.detect_tennis_ball_color",
            return_value=([30.0, 20.0, 34.0, 24.0], 0.6),
        ):
            telemetry = tracker.process_video(str(self.video_path))
        self.assertEqual(len(telemetry), 2)
        self.assertEqual(telemetry[1]["image_width"], 64)
        self.assertEqual(telemetry[1]["image_height"], 48)
        self.assertEqual(telemetry[1]["court_corners"], corners)
        self.assertTrue(any(
            detection["class"] == "ball"
            for detection in telemetry[1]["detections"]
        ))

    def test_tracker_refreshes_court_calibration_every_five_frames(self):
        video_path = Path(self.directory.name) / "long-video.mp4"
        writer = cv2.VideoWriter(
            str(video_path), cv2.VideoWriter_fourcc(*"mp4v"), 25, (64, 48)
        )
        for _ in range(12):
            writer.write(np.zeros((48, 64, 3), dtype=np.uint8))
        writer.release()

        tracker = TennisTracker.__new__(TennisTracker)
        tracker.target_classes = [0, 32]
        tracker.model = lambda *args, **kwargs: [SimpleNamespace(boxes=[])]
        corners = [(0, 0), (63, 0), (63, 47), (0, 47)]
        detected_frames = []
        tracker.court_detector = SimpleNamespace(
            detect_corners=lambda frame: detected_frames.append(frame) or corners
        )
        progress_updates = []

        telemetry = tracker.process_video(
            str(video_path),
            progress_callback=lambda processed, total: progress_updates.append((processed, total)),
        )

        self.assertEqual(len(telemetry), 12)
        self.assertEqual(len(detected_frames), 3)
        self.assertEqual(progress_updates, [(0, 12), (5, 12), (10, 12), (12, 12)])

    def test_video_progress_endpoint_returns_current_frame_count(self):
        server.progress_by_match["progress-test"] = {
            "processedFrames": 25,
            "totalFrames": 447,
        }

        response = asyncio.run(server.get_video_progress("progress-test"))

        self.assertEqual(response, {"processedFrames": 25, "totalFrames": 447})
        self.assertEqual(
            asyncio.run(server.get_video_progress("unknown")),
            {"processedFrames": 0, "totalFrames": None},
        )

    def test_tracker_keeps_player_just_behind_near_baseline(self):
        tracker = TennisTracker.__new__(TennisTracker)
        tracker.target_classes = [0, 32]
        box = SimpleNamespace(
            cls=np.asarray([0]),
            conf=np.asarray([0.9]),
            xyxy=np.asarray([[20, 20, 40, 44]], dtype=np.float32),
        )
        tracker.model = lambda *args, **kwargs: [SimpleNamespace(boxes=[box])]
        corners = [(0, 0), (63, 0), (63, 40), (0, 40)]
        tracker.court_detector = SimpleNamespace(detect_corners=lambda frame: corners)

        telemetry = tracker.process_video(str(self.video_path))

        player = next(
            detection
            for detection in telemetry[0]["detections"]
            if detection["class"] == "player"
        )
        self.assertGreater(player["x_meters"], 23.77)
        self.assertLessEqual(player["x_meters"], 23.77 + 5.0)

    def test_tracker_keeps_player_behind_far_baseline(self):
        tracker = TennisTracker.__new__(TennisTracker)
        tracker.target_classes = [0, 32]
        box = SimpleNamespace(
            cls=np.asarray([0]),
            conf=np.asarray([0.9]),
            xyxy=np.asarray([[20, 6, 40, 16]], dtype=np.float32),
        )
        tracker.model = lambda *args, **kwargs: [SimpleNamespace(boxes=[box])]
        corners = [(0, 20), (63, 20), (63, 40), (0, 40)]
        tracker.court_detector = SimpleNamespace(detect_corners=lambda frame: corners)

        telemetry = TennisTracker.process_video(tracker, str(self.video_path))

        player = next(
            detection
            for detection in telemetry[0]["detections"]
            if detection["class"] == "player"
        )
        self.assertGreaterEqual(player["x_meters"], -5.0)
        self.assertLess(player["x_meters"], 0)

    def test_tracker_rejects_low_confidence_person_at_sideline_post(self):
        tracker = TennisTracker.__new__(TennisTracker)
        tracker.target_classes = [0, 32]
        box = SimpleNamespace(
            cls=np.asarray([0]),
            conf=np.asarray([0.15]),
            xyxy=np.asarray([[59, 18, 63, 22]], dtype=np.float32),
        )
        tracker.model = lambda *args, **kwargs: [SimpleNamespace(boxes=[box])]
        corners = [(0, 0), (63, 0), (63, 40), (0, 40)]
        tracker.court_detector = SimpleNamespace(detect_corners=lambda frame: corners)

        telemetry = tracker.process_video(str(self.video_path))

        self.assertFalse(any(
            detection["class"] == "player"
            for detection in telemetry[0]["detections"]
        ))

    def test_tracker_expires_stale_player_boxes(self):
        video_path = Path(self.directory.name) / "carry-video.mp4"
        writer = cv2.VideoWriter(
            str(video_path), cv2.VideoWriter_fourcc(*"mp4v"), 25, (64, 48)
        )
        for _ in range(8):
            writer.write(np.zeros((48, 64, 3), dtype=np.uint8))
        writer.release()

        tracker = TennisTracker.__new__(TennisTracker)
        tracker.target_classes = [0, 32]
        box = SimpleNamespace(
            cls=np.asarray([0]),
            conf=np.asarray([0.9]),
            xyxy=np.asarray([[20, 10, 40, 39]], dtype=np.float32),
        )
        model_frame = [0]

        def model(*args, **kwargs):
            boxes = [box] if model_frame[0] == 0 else []
            model_frame[0] += 1
            return [SimpleNamespace(boxes=boxes)]

        tracker.model = model
        corners = [(0, 0), (63, 0), (63, 40), (0, 40)]
        tracker.court_detector = SimpleNamespace(detect_corners=lambda frame: corners)

        telemetry = tracker.process_video(str(video_path))

        self.assertTrue(any(
            detection.get("carried_forward")
            for detection in telemetry[3]["detections"]
        ))
        self.assertFalse(any(
            detection["class"] == "player"
            for detection in telemetry[4]["detections"]
        ))

    def test_upload_stream_is_saved_and_processed_from_disk(self):
        chunks = [b"video ", b"content"]

        class UploadRequest:
            async def stream(self):
                for chunk in chunks:
                    yield chunk

        with tempfile.TemporaryDirectory() as directory:
            with patch.object(server, "match_video_root", Path(directory)):
                with patch.object(server, "process_video_file", return_value=[{"frame_index": 0}]) as process:
                    response = asyncio.run(server.process_video_upload(
                        UploadRequest(), "upload-test", "final%20match.mp4"
                    ))

            self.assertEqual(response["matchId"], "upload-test")
            self.assertEqual(response["telemetry"], [{"frame_index": 0}])
            uploaded_path = process.call_args.args[0]
            self.assertEqual(uploaded_path.name, "final match.mp4")
            self.assertEqual(uploaded_path.read_bytes(), b"video content")
            self.assertEqual(server.processed_videos["upload-test"], (uploaded_path, 1))
            uploaded_path.unlink()

    def test_color_ball_fallback_selects_small_ball_inside_court(self):
        frame = np.full((240, 320, 3), (40, 120, 40), dtype=np.uint8)
        court = [(20, 20), (300, 20), (300, 220), (20, 220)]
        cv2.circle(frame, (10, 10), 5, (0, 255, 255), -1)
        cv2.circle(frame, (160, 100), 4, (0, 255, 255), -1)
        cv2.rectangle(frame, (40, 50), (75, 100), (0, 255, 255), -1)

        candidate = detect_tennis_ball_color(frame, court)

        self.assertIsNotNone(candidate)
        bbox, confidence = candidate
        self.assertAlmostEqual((bbox[0] + bbox[2]) / 2, 160, delta=3)
        self.assertAlmostEqual((bbox[1] + bbox[3]) / 2, 100, delta=3)
        self.assertGreater(confidence, 0.45)

    def test_color_ball_fallback_ignores_yellow_outside_court(self):
        frame = np.zeros((240, 320, 3), dtype=np.uint8)
        cv2.circle(frame, (10, 10), 5, (0, 255, 255), -1)
        court = [(20, 20), (300, 20), (300, 220), (20, 220)]

        self.assertIsNone(detect_tennis_ball_color(frame, court))

    def test_color_ball_fallback_rejects_candidate_just_outside_court(self):
        frame = np.zeros((240, 320, 3), dtype=np.uint8)
        court = [(40, 20), (280, 20), (280, 220), (40, 220)]
        cv2.circle(frame, (35, 120), 4, (0, 255, 255), -1)
        cv2.circle(frame, (160, 100), 4, (0, 255, 255), -1)

        candidate = detect_tennis_ball_color(frame, court)

        self.assertIsNotNone(candidate)
        bbox, _ = candidate
        self.assertAlmostEqual((bbox[0] + bbox[2]) / 2, 160, delta=3)

    def test_completed_analysis_registers_its_own_video(self):
        telemetry = [{"frame_index": 0}]
        with patch.object(server, "run_pipeline", return_value=telemetry) as pipeline:
            with patch.object(Path, "glob", return_value=iter([self.video_path])):
                response = asyncio.run(server.process_video(
                    server.ProcessVideoRequest(youtubeUrl="https://example.com", matchId="test")
                ))
        self.assertEqual(response["telemetry"], telemetry)
        self.assertEqual(server.processed_videos["test"], (self.video_path, 1))
        self.assertEqual(pipeline.call_args.args[:2], ("https://example.com", None))
        self.assertEqual(Path(pipeline.call_args.args[2]).parent, Path("./temp/matches"))


if __name__ == "__main__":
    unittest.main()