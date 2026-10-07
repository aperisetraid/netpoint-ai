import math
from typing import Sequence, Tuple

import cv2
import numpy as np


COURT_LENGTH_METERS = 23.77
COURT_WIDTH_METERS = 10.97


def get_homography_matrix(src_points: Sequence[Sequence[float]]) -> np.ndarray:
    """Map image TL, TR, BR, BL to a horizontal court, far baseline to left."""
    source = np.asarray(src_points, dtype=np.float32)
    if source.shape != (4, 2):
        raise ValueError("src_points must contain exactly four 2D points")
    if not all(math.isfinite(float(value)) for row in source for value in row):
        raise ValueError("src_points must contain only finite coordinates")

    area = abs(sum(
        source[index][0] * source[(index + 1) % 4][1]
        - source[(index + 1) % 4][0] * source[index][1]
        for index in range(4)
    )) / 2
    if area <= 1e-6:
        raise ValueError("src_points must describe a non-degenerate quadrilateral")

    destination = np.asarray(
        [
            [0.0, 0.0],
            [0.0, COURT_WIDTH_METERS],
            [COURT_LENGTH_METERS, COURT_WIDTH_METERS],
            [COURT_LENGTH_METERS, 0.0],
        ],
        dtype=np.float32,
    )
    return cv2.getPerspectiveTransform(source, destination)


def transform_point(
    point: Sequence[float],
    H: np.ndarray,
) -> Tuple[float, float]:
    """Transform one pixel coordinate to meters using a 3x3 homography."""
    pixel = np.asarray(point, dtype=np.float32)
    matrix = np.asarray(H, dtype=np.float64)
    if pixel.shape != (2,):
        raise ValueError("point must contain exactly two coordinates")
    if matrix.shape != (3, 3):
        raise ValueError("H must be a 3x3 homography matrix")

    transformed = cv2.perspectiveTransform(pixel.reshape(1, 1, 2), matrix)[0, 0]
    x_meters, y_meters = float(transformed[0]), float(transformed[1])
    if not math.isfinite(x_meters) or not math.isfinite(y_meters):
        raise ValueError("point cannot be transformed to a finite court coordinate")
    return x_meters, y_meters