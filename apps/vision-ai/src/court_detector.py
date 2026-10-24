import math
from typing import List, Optional, Tuple

import cv2
import numpy as np


Point = Tuple[int, int]
Segment = Tuple[int, int, int, int, float]
Line = Tuple[float, float, float]
LineCandidate = Tuple[Line, float, float, float, float]


class CourtDetector:
    def __init__(
        self,
        canny_threshold1: int = 50,
        canny_threshold2: int = 150,
        hough_threshold: int = 80,
        min_line_length: int = 100,
        max_line_gap: int = 20,
    ):
        self.canny_threshold1 = canny_threshold1
        self.canny_threshold2 = canny_threshold2
        self.hough_threshold = hough_threshold
        self.min_line_length = min_line_length
        self.max_line_gap = max_line_gap

    def detect_corners(self, frame) -> Optional[List[Point]]:
        """Find the strongest plausible court quadrilateral in a video frame."""
        if frame is None or len(frame.shape) < 2:
            return None

        if len(frame.shape) == 2:
            grayscale = frame
        elif frame.shape[2] == 4:
            grayscale = cv2.cvtColor(frame, cv2.COLOR_BGRA2GRAY)
        else:
            grayscale = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)

        blurred = cv2.GaussianBlur(grayscale, (5, 5), 0)
        edges = cv2.Canny(
            blurred,
            self.canny_threshold1,
            self.canny_threshold2,
        )
        detected_lines = cv2.HoughLinesP(
            edges,
            rho=1,
            theta=math.pi / 180,
            threshold=self.hough_threshold,
            minLineLength=self.min_line_length,
            maxLineGap=self.max_line_gap,
        )
        if detected_lines is None:
            return None

        height, width = frame.shape[:2]
        segments = self._segments(detected_lines)
        baselines = self._line_candidates(segments, width, height, "baseline")
        left_sides = self._line_candidates(segments, width, height, "left")
        right_sides = self._line_candidates(segments, width, height, "right")
        if not baselines:
            return None

        side_pair_options = [(left_sides, right_sides)]
        if len(left_sides) > 1:
            side_pair_options.append((left_sides, left_sides))
        if len(right_sides) > 1:
            side_pair_options.append((right_sides, right_sides))

        best_corners = None
        best_score = float("-inf")
        for far_baseline in baselines:
            _, far_support, far_y, _, _ = far_baseline
            if not height * 0.13 <= far_y <= height * 0.62:
                continue
            for near_baseline in baselines:
                _, near_support, near_y, _, _ = near_baseline
                if not height * 0.52 <= near_y <= height * 1.04:
                    continue
                if near_y - far_y < height * 0.45:
                    continue

                for first_side_group, second_side_group in side_pair_options:
                    for first_index, first_side in enumerate(first_side_group):
                        second_start = (
                            first_index + 1
                            if first_side_group is second_side_group
                            else 0
                        )
                        for second_side in second_side_group[second_start:]:
                            if first_side[0] == second_side[0]:
                                continue

                            corners = [
                                self._intersection(far_baseline[0], first_side[0]),
                                self._intersection(far_baseline[0], second_side[0]),
                                self._intersection(near_baseline[0], second_side[0]),
                                self._intersection(near_baseline[0], first_side[0]),
                            ]
                            if any(corner is None for corner in corners):
                                continue
                            corner_tolerance = max(width, height) * 0.025
                            if any(
                                not self._intersection_on_candidate(corner, candidate, corner_tolerance)
                                for corner, candidate in (
                                    (corners[0], first_side),
                                    (corners[3], first_side),
                                    (corners[1], second_side),
                                    (corners[2], second_side),
                                )
                            ):
                                continue
                            points = np.asarray(corners, dtype=np.float32)
                            if points[0, 0] > points[1, 0]:
                                points = points[[1, 0, 3, 2]]
                            top_left, top_right, bottom_right, bottom_left = points
                            if top_left[0] >= top_right[0] or bottom_left[0] >= bottom_right[0]:
                                continue
                            if any(
                                point[0] < -width * 0.01
                                or point[0] > width * 1.01
                                or point[1] < -height * 0.01
                                or point[1] > height * 1.01
                                for point in points
                            ):
                                continue

                            far_width = top_right[0] - top_left[0]
                            near_width = bottom_right[0] - bottom_left[0]
                            if far_width < width * 0.18 or near_width < width * 0.3:
                                continue
                            if not 0.25 <= far_width / near_width <= 1.3:
                                continue
                            area = abs(cv2.contourArea(points)) / (width * height)
                            if not 0.12 <= area <= 0.9 or not cv2.isContourConvex(points):
                                continue

                            side_support = (first_side[1] + second_side[1]) / 2
                            score = (
                                area * 2
                                + (far_support + near_support) / (2 * width) * 0.3
                                + side_support / height * 0.3
                                + (near_y - far_y) / height * 0.3
                            )
                            if score > best_score:
                                best_score = score
                                best_corners = points

        if best_corners is None:
            return None
        return [(round(float(x)), round(float(y))) for x, y in best_corners]

    @classmethod
    def _line_candidates(
        cls,
        segments: List[Segment],
        width: int,
        height: int,
        kind: str,
    ) -> List[LineCandidate]:
        groups: List[Tuple[float, List[Segment], float]] = []
        is_baseline = kind == "baseline"
        cluster_distance = (height if is_baseline else width) * 0.025

        for segment in segments:
            x1, y1, x2, y2, angle = segment
            if is_baseline:
                if cls._angle_distance(angle, 0) > math.radians(14) or x1 == x2:
                    continue
                position = y1 + (width / 2 - x1) * (y2 - y1) / (x2 - x1)
            else:
                angle_degrees = math.degrees(angle)
                if kind == "left" and not 98 <= angle_degrees <= 145:
                    continue
                if kind == "right" and not 35 <= angle_degrees <= 82:
                    continue
                if y1 == y2:
                    continue
                position = x1 + (height / 2 - y1) * (x2 - x1) / (y2 - y1)

            segment_length = math.hypot(x2 - x1, y2 - y1)
            group_index = next(
                (
                    index for index, (center, _, _) in enumerate(groups)
                    if abs(center - position) <= cluster_distance
                ),
                None,
            )
            if group_index is None:
                groups.append((position, [segment], segment_length))
            else:
                center, group_segments, support = groups[group_index]
                new_support = support + segment_length
                groups[group_index] = (
                    (center * support + position * segment_length) / new_support,
                    group_segments + [segment],
                    new_support,
                )

        minimum_support = max(
            60,
            (width if is_baseline else height)
            * (0.35 if is_baseline else 0.12),
        )
        candidates: List[LineCandidate] = []
        for position, group_segments, support in groups:
            if support < minimum_support:
                continue
            points = np.asarray(
                [
                    (x, y)
                    for x1, y1, x2, y2, _ in group_segments
                    for x, y in ((x1, y1), (x2, y2))
                ],
                dtype=np.float32,
            )
            vx, vy, x, y = (
                float(value)
                for value in cv2.fitLine(points, cv2.DIST_WELSCH, 0, 0.01, 0.01).flatten()
            )
            line = (-vy, vx, -vy * x + vx * y)
            projections = points[:, 0] * vx + points[:, 1] * vy
            candidates.append((line, support, position, float(projections.min()), float(projections.max())))
        return candidates

    @staticmethod
    def _intersection_on_candidate(
        point: Tuple[float, float],
        candidate: LineCandidate,
        tolerance: float,
    ) -> bool:
        line, _, _, minimum_projection, maximum_projection = candidate
        projection = line[1] * point[0] - line[0] * point[1]
        return minimum_projection - tolerance <= projection <= maximum_projection + tolerance

    @staticmethod
    def _segments(detected_lines) -> List[Segment]:
        segments = []
        for detected_line in np.asarray(detected_lines).reshape(-1, 4):
            x1, y1, x2, y2 = (int(value) for value in detected_line)
            length = math.hypot(x2 - x1, y2 - y1)
            if length == 0:
                continue
            angle = math.atan2(y2 - y1, x2 - x1) % math.pi
            segments.append((x1, y1, x2, y2, angle))
        return segments

    @staticmethod
    def _angle_distance(first: float, second: float) -> float:
        difference = abs(first - second) % math.pi
        return min(difference, math.pi - difference)

    @staticmethod
    def _intersection(first: Line, second: Line) -> Optional[Tuple[float, float]]:
        first_a, first_b, first_c = first
        second_a, second_b, second_c = second
        determinant = first_a * second_b - second_a * first_b
        if abs(determinant) < 1e-6:
            return None

        x = (first_c * second_b - second_c * first_b) / determinant
        y = (first_a * second_c - second_a * first_c) / determinant
        return x, y