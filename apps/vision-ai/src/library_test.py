import asyncio
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import cv2
import numpy as np

import library
import server

FIRST_ID = "11111111-1111-4111-8111-111111111111"
SECOND_ID = "22222222-2222-4222-8222-222222222222"


def telemetry(frame_count=50, fps=25.0, speeds=(120.0, None, 98.5)):
    return {
        "version": 2,
        "video": {"fps": fps, "width": 64, "height": 48, "frame_count": frame_count},
        "court": {"length_meters": 23.77, "width_meters": 10.97, "calibrated": True},
        "frames": [],
        "events": {
            "bounces": [{"frame_index": 3}],
            "hits": [{"speed_kmh": speed} for speed in speeds],
        },
    }


def write_video(path: Path):
    writer = cv2.VideoWriter(str(path), cv2.VideoWriter_fourcc(*"mp4v"), 25, (64, 48))
    for intensity in (30, 120, 210, 90):
        writer.write(np.full((48, 64, 3), intensity, dtype=np.uint8))
    writer.release()


class LibraryTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.addCleanup(library._summary_cache.clear)
        self.addCleanup(server.processed_videos.clear)

    def add_match(self, match_id, data=None, metadata=None, video=None):
        folder = self.root / match_id
        folder.mkdir()
        (folder / library.TELEMETRY_FILE).write_text(json.dumps(data or telemetry()), encoding="utf-8")
        if metadata is not None:
            (folder / library.METADATA_FILE).write_text(json.dumps(metadata), encoding="utf-8")
        if video:
            write_video(folder / video)
        return folder

    def test_summary_uses_metadata_and_telemetry(self):
        self.add_match(FIRST_ID, metadata={"title": "Final", "source": "upload", "createdAt": "2026-01-02T00:00:00+00:00"},
                       video="clip.mp4")

        [summary] = library.list_matches(self.root)

        self.assertEqual(summary["id"], FIRST_ID)
        self.assertEqual(summary["title"], "Final")
        self.assertEqual(summary["source"], "upload")
        self.assertEqual(summary["durationSeconds"], 2.0)
        self.assertEqual((summary["hitCount"], summary["bounceCount"]), (3, 1))
        self.assertEqual(summary["maxSpeedKmh"], 120.0)
        self.assertTrue(summary["hasVideo"])

    def test_legacy_folder_falls_back_to_video_name_and_orders_newest_first(self):
        self.add_match(FIRST_ID, metadata={"title": "Viejo", "createdAt": "2025-01-01T00:00:00+00:00"})
        self.add_match(SECOND_ID, video="Test 1 - Trim.mp4")

        summaries = library.list_matches(self.root)

        self.assertEqual([item["id"] for item in summaries], [SECOND_ID, FIRST_ID])
        self.assertEqual(summaries[0]["title"], "Test 1 - Trim")
        self.assertIsNone(summaries[0]["source"])
        self.assertFalse(summaries[1]["hasVideo"])

    def test_unreadable_and_foreign_folders_are_ignored(self):
        broken = self.add_match(FIRST_ID)
        (broken / library.TELEMETRY_FILE).write_text("{not json", encoding="utf-8")
        (self.root / "not-a-uuid").mkdir()
        (self.root / "not-a-uuid" / library.TELEMETRY_FILE).write_text("{}", encoding="utf-8")
        self.add_match(SECOND_ID)
        legacy = self.add_match("33333333-3333-4333-8333-333333333333", data=[{"frame_index": 0}])

        with self.assertLogs(library.logger, "WARNING") as logs:
            self.assertEqual([item["id"] for item in library.list_matches(self.root)], [SECOND_ID])
        self.assertEqual(len(logs.records), 2)
        with self.assertNoLogs(library.logger, "WARNING"):
            library.list_matches(self.root)
        self.assertIsNone(library.summarize_match(legacy))
        self.assertEqual(library.list_matches(self.root / "missing"), [])

    def test_resolve_rejects_traversal_and_unknown_ids(self):
        self.add_match(FIRST_ID)

        self.assertIsNotNone(library.resolve_match_dir(self.root, FIRST_ID))
        for bad in ("..", "../x", FIRST_ID + "/..", SECOND_ID, ""):
            self.assertIsNone(library.resolve_match_dir(self.root, bad))

    def test_summary_cache_refreshes_when_metadata_changes(self):
        folder = self.add_match(FIRST_ID, metadata={"title": "Antes"})
        self.assertEqual(library.list_matches(self.root)[0]["title"], "Antes")

        (folder / library.METADATA_FILE).write_text(json.dumps({"title": "Después"}), encoding="utf-8")
        past = folder.joinpath(library.METADATA_FILE).stat().st_mtime_ns + 5_000_000
        import os
        os.utime(folder / library.METADATA_FILE, ns=(past, past))

        self.assertEqual(library.list_matches(self.root)[0]["title"], "Después")

    def test_thumbnail_is_generated_once(self):
        folder = self.add_match(FIRST_ID, video="clip.mp4")

        first = library.ensure_thumbnail(folder)

        self.assertEqual(first, folder / library.THUMBNAIL_FILE)
        image = cv2.imdecode(np.frombuffer(first.read_bytes(), dtype=np.uint8), cv2.IMREAD_COLOR)
        self.assertEqual(image.shape, (48, 64, 3))
        with patch.object(cv2, "VideoCapture", side_effect=AssertionError("regenerated")):
            self.assertEqual(library.ensure_thumbnail(folder), first)
        self.assertIsNone(library.ensure_thumbnail(self.add_match(SECOND_ID)))

    def test_metadata_is_only_written_for_existing_output_folders(self):
        library.write_match_metadata(self.root / "missing", "Título", "url")
        self.assertFalse((self.root / "missing").exists())

        folder = self.root / FIRST_ID
        folder.mkdir()
        library.write_match_metadata(folder, "  Título  ", "url")
        metadata = json.loads((folder / library.METADATA_FILE).read_text(encoding="utf-8"))
        self.assertEqual((metadata["title"], metadata["source"]), ("Título", "url"))


class LibraryEndpointTests(LibraryTests):
    def setUp(self):
        super().setUp()
        patcher = patch.object(server, "match_video_root", self.root)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_open_returns_telemetry_and_registers_video_for_playback(self):
        folder = self.add_match(FIRST_ID, metadata={"title": "Final"}, video="clip.mp4")

        response = asyncio.run(server.open_library_match(FIRST_ID))

        self.assertEqual(response["matchId"], FIRST_ID)
        self.assertEqual(response["title"], "Final")
        self.assertEqual(response["telemetry"]["video"]["frame_count"], 50)
        self.assertEqual(server.processed_videos[FIRST_ID], (folder / "clip.mp4", 50))

    def test_open_and_thumbnail_return_404_for_unknown_matches(self):
        for endpoint in (server.open_library_match, server.get_library_thumbnail):
            for match_id in (FIRST_ID, "../etc"):
                with self.assertRaises(server.HTTPException) as caught:
                    asyncio.run(endpoint(match_id))
                self.assertEqual(caught.exception.status_code, 404)

    def test_list_endpoint_returns_summaries(self):
        self.add_match(FIRST_ID)

        response = asyncio.run(server.list_library_matches())

        self.assertEqual([item["id"] for item in response], [FIRST_ID])


if __name__ == "__main__":
    unittest.main()
