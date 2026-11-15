import unittest

import cv2
import numpy as np

from tracker import align_to_current, camera_motion_image, estimate_camera_shift


def scene(offset_x=0, offset_y=0):
    rng = np.random.default_rng(7)
    canvas = np.full((360, 640, 3), (160, 90, 40), dtype=np.uint8)
    for _ in range(40):
        x, y = rng.integers(20, 600), rng.integers(20, 320)
        cv2.rectangle(canvas, (int(x) + offset_x, int(y) + offset_y), (int(x) + offset_x + 12, int(y) + offset_y + 5), (255, 255, 255), -1)
    return canvas


class CameraMotionTests(unittest.TestCase):
    def test_panning_is_measured_and_cancelled(self):
        previous, current = scene(), scene(offset_x=4, offset_y=-2)

        shift = estimate_camera_shift(camera_motion_image(previous), camera_motion_image(current), 640)

        self.assertIsNotNone(shift)
        self.assertAlmostEqual(shift[0], 4, delta=0.5)
        self.assertAlmostEqual(shift[1], -2, delta=0.5)
        raw = cv2.absdiff(current, previous).mean()
        aligned = cv2.absdiff(current, align_to_current(previous, shift)).mean()
        self.assertLess(aligned, raw / 3)

    def test_static_camera_is_left_alone(self):
        frame = scene()
        self.assertIsNone(estimate_camera_shift(camera_motion_image(frame), camera_motion_image(frame), 640))


if __name__ == "__main__":
    unittest.main()


class StaticSceneTests(unittest.TestCase):
    def frames(self):
        base = scene()
        gray = lambda image: cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
        return base, gray

    def test_logo_that_follows_the_camera_is_static_but_a_new_blob_is_not(self):
        from tracker import StaticSceneFilter

        base, gray = self.frames()
        scene_filter = StaticSceneFilter(lag=3)
        for step in range(4):
            frame = np.roll(base, 2 * step, axis=1)
            if step == 3:
                cv2.circle(frame, (320, 300), 4, (0, 255, 255), -1)
            scene_filter.push(gray(frame), (2.0, 0.0) if step else None)

        logo = next(
            (x, y) for y in range(30, 330) for x in range(30, 600)
            if gray(np.roll(base, 6, axis=1))[y, x] > 200
        )
        self.assertTrue(scene_filter.is_static([logo[0] - 3, logo[1] - 2, logo[0] + 3, logo[1] + 2]))
        self.assertFalse(scene_filter.is_static([316, 296, 324, 304]))

    def test_overlay_fixed_on_screen_is_static_while_the_camera_pans(self):
        from tracker import StaticSceneFilter

        base, gray = self.frames()
        scene_filter = StaticSceneFilter(lag=3)
        for step in range(4):
            frame = np.roll(base, 2 * step, axis=1)
            # Scoreboard: an opaque box with a digit, fixed on screen.
            cv2.rectangle(frame, (285, 312), (330, 352), (20, 20, 20), -1)
            cv2.putText(frame, "6", (300, 340), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (255, 255, 0), 2)
            scene_filter.push(gray(frame), (2.0, 0.0) if step else None)

        self.assertTrue(scene_filter.is_static([303, 322, 315, 338]))

    def test_needs_enough_history_and_texture(self):
        from tracker import StaticSceneFilter

        base, gray = self.frames()
        scene_filter = StaticSceneFilter(lag=3)
        scene_filter.push(gray(base), None)
        self.assertFalse(scene_filter.is_static([100, 100, 106, 104]))
        for _ in range(3):
            scene_filter.push(gray(np.full_like(base, 90)), None)
        self.assertFalse(scene_filter.is_static([100, 100, 106, 104]))


class BallRegionTests(unittest.TestCase):
    def test_mask_matches_the_tracking_region_beyond_the_baselines(self):
        from tracker import ball_region_mask, point_in_ball_tracking_region

        corners = [(277, 190), (793, 189), (1000, 551), (61, 562)]
        mask = ball_region_mask((720, 1280), corners)
        rng = np.random.default_rng(3)
        disagreements = 0
        for x, y in rng.integers((0, 0), (1280, 720), size=(3000, 2)):
            inside = point_in_ball_tracking_region((float(x), float(y)), corners)
            disagreements += inside != bool(mask[y, x])
        self.assertLess(disagreements, 30)  # only rasterisation at the borders
        self.assertTrue(mask[176, 686])  # ball behind the far baseline in Test 2, frame 110
        self.assertFalse(mask[30, 686])  # stands / advertising boards stay out


class PersonBoxTests(unittest.TestCase):
    def test_point_inside_a_box_with_margin(self):
        from tracker import inside_any_box

        boxes = [[100.0, 100.0, 140.0, 220.0]]
        self.assertTrue(inside_any_box((120, 150), boxes))
        self.assertTrue(inside_any_box((143, 150), boxes, margin=4))
        self.assertFalse(inside_any_box((150, 150), boxes, margin=4))
        self.assertFalse(inside_any_box((120, 150), []))


class ScreenOverlayTests(unittest.TestCase):
    def test_scoreboard_is_found_but_panned_scenery_and_sliding_lines_are_not(self):
        from tracker import ScreenOverlayMask, camera_motion_image

        base = scene()
        cv2.line(base, (0, 200), (639, 200), (255, 255, 255), 3)  # a line parallel to the pan
        overlay = ScreenOverlayMask()
        previous = None
        for step in range(8):
            frame = np.roll(base, 3 * step, axis=1)
            cv2.rectangle(frame, (40, 300), (140, 345), (20, 20, 20), -1)
            cv2.putText(frame, "40", (60, 337), cv2.FONT_HERSHEY_SIMPLEX, 1.0, (255, 255, 255), 2)
            image = camera_motion_image(frame)
            overlay.update(previous, image, (3.0, 0.0) if previous is not None else None, 640)
            previous = image

        self.assertTrue(overlay.contains((75, 322)))   # the digits
        self.assertFalse(overlay.contains((320, 200)))  # the horizontal line sliding along itself
        mask = overlay.mask()
        scenery = mask[20:280, 160:640]
        self.assertLess(scenery.mean(), 0.02)

    def test_static_camera_never_builds_a_mask(self):
        from tracker import ScreenOverlayMask, camera_motion_image

        overlay = ScreenOverlayMask()
        image = camera_motion_image(scene())
        for _ in range(10):
            overlay.update(image, image, None, 640)
        self.assertIsNone(overlay.mask())
        self.assertFalse(overlay.contains((75, 322)))
