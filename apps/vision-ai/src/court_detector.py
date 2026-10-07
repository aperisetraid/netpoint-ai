import math
from typing import Dict, List, Optional, Tuple

import cv2


Point = Tuple[int, int]
Segment = Tuple[int, int, int, int, float]
Line = Tuple[float, float, float]


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
        """Detect the four outer court corners in a BGR or grayscale frame."""
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
        if len(segments) < 4:
            return None

        orientations = self._dominant_orientations(segments)
        if orientations is None:
            return None

        angle1, angle2 = orientations
        angle_tolerance = math.radians(25)
        first_family = [
            segment for segment in segments
            if self._angle_distance(segment[4], angle1) <= angle_tolerance
        ]
        second_family = [
            segment for segment in segments
            if self._angle_distance(segment[4], angle2) <= angle_tolerance
        ]
        cluster_distance = max(10.0, min(width, height) * 0.015)
        first_lines = self._outer_lines(first_family, angle1, cluster_distance)
        second_lines = self._outer_lines(second_family, angle2, cluster_distance)
        if first_lines is None or second_lines is None:
            return None

        corners = [
            self._intersection(first_line, second_line)
            for first_line in first_lines
            for second_line in second_lines
        ]
        if any(corner is None for corner in corners):
            return None

        points = [corner for corner in corners if corner is not None]
        top_left = min(points, key=lambda point: point[0] + point[1])
        bottom_right = max(points, key=lambda point: point[0] + point[1])
        top_right = min(points, key=lambda point: point[1] - point[0])
        bottom_left = max(points, key=lambda point: point[1] - point[0])
        ordered = [top_left, top_right, bottom_right, bottom_left]
        if len(set(ordered)) != 4:
            return None
        return [(round(x), round(y)) for x, y in ordered]

    @staticmethod
    def _segments(detected_lines) -> List[Segment]:
        segments = []
        for detected_line in detected_lines:
            x1, y1, x2, y2 = (int(value) for value in detected_line[0])
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

    @classmethod
    def _dominant_orientations(
        cls,
        segments: List[Segment],
    ) -> Optional[Tuple[float, float]]:
        bin_count = 36
        histogram = [0.0] * bin_count
        for x1, y1, x2, y2, angle in segments:
            bin_index = int(angle / math.pi * bin_count) % bin_count
            histogram[bin_index] += math.hypot(x2 - x1, y2 - y1)

        first_index = max(range(bin_count), key=histogram.__getitem__)
        minimum_separation = round(bin_count / 6)
        second_candidates = [
            index for index in range(bin_count)
            if min(
                abs(index - first_index),
                bin_count - abs(index - first_index),
            ) >= minimum_separation
        ]
        if not second_candidates:
            return None
        second_index = max(second_candidates, key=histogram.__getitem__)
        if histogram[first_index] == 0 or histogram[second_index] == 0:
            return None

        return (
            (first_index + 0.5) * math.pi / bin_count,
            (second_index + 0.5) * math.pi / bin_count,
        )

    @staticmethod
    def _outer_lines(
        segments: List[Segment],
        orientation: float,
        cluster_distance: float,
    ) -> Optional[Tuple[Line, Line]]:
        normal_x = -math.sin(orientation)
        normal_y = math.cos(orientation)
        clusters: List[Dict[str, object]] = []

        for x1, y1, x2, y2, angle in segments:
            midpoint_x = (x1 + x2) / 2
            midpoint_y = (y1 + y2) / 2
            offset = midpoint_x * normal_x + midpoint_y * normal_y
            length = math.hypot(x2 - x1, y2 - y1)
            cluster = next(
                (
                    candidate for candidate in clusters
                    if abs(float(candidate["offset"]) - offset) <= cluster_distance
                ),
                None,
            )
            if cluster is None:
                clusters.append({
                    "offset": offset,
                    "segments": [(x1, y1, x2, y2, angle, length)],
                })
            else:
                cluster["segments"].append((x1, y1, x2, y2, angle, length))
                cluster_segments = cluster["segments"]
                total_length = sum(segment[5] for segment in cluster_segments)
                cluster["offset"] = sum(
                    (
                        (segment[0] + segment[2]) / 2 * normal_x
                        + (segment[1] + segment[3]) / 2 * normal_y
                    ) * segment[5]
                    for segment in cluster_segments
                ) / total_length

        if len(clusters) < 2:
            return None

        clusters.sort(key=lambda cluster: float(cluster["offset"]))
        return (
            CourtDetector._representative_line(clusters[0]["segments"]),
            CourtDetector._representative_line(clusters[-1]["segments"]),
        )

    @staticmethod
    def _representative_line(segments) -> Line:
        weighted_cosine = sum(length * math.cos(2 * angle) for *_, angle, length in segments)
        weighted_sine = sum(length * math.sin(2 * angle) for *_, angle, length in segments)
        angle = (0.5 * math.atan2(weighted_sine, weighted_cosine)) % math.pi
        normal_x = -math.sin(angle)
        normal_y = math.cos(angle)
        total_length = sum(segment[5] for segment in segments)
        offset = sum(
            (
                (segment[0] + segment[2]) / 2 * normal_x
                + (segment[1] + segment[3]) / 2 * normal_y
            ) * segment[5]
            for segment in segments
        ) / total_length
        return normal_x, normal_y, offset

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