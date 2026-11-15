"""Pinhole camera recovered from the four calibrated court corners.

World frame: x along the court length (far baseline at 0), y along its width, z up, in meters.
"""

import math
from collections.abc import Sequence
from dataclasses import dataclass

import cv2
import numpy as np

from homography import get_homography_matrix


MIN_FOCAL_RATIO = 0.3
MAX_FOCAL_RATIO = 30.0
MAX_CORNER_REPROJECTION_RATIO = 0.01
MIN_CAMERA_HEIGHT_METERS = 0.5


@dataclass(frozen=True)
class Camera:
    projection: np.ndarray
    focal_length: float

    def project(self, point: Sequence[float]) -> tuple[float, float] | None:
        u, v, w = self.projection @ np.asarray([point[0], point[1], point[2], 1.0])
        if w <= 1e-9:
            return None
        return float(u / w), float(v / w)

    def backproject(self, u: float, v: float, z: float = 0.0) -> tuple[float, float] | None:
        """Court position of the point seen at pixel (u, v) that lies at height z."""
        p = self.projection
        plane = np.column_stack((p[:, 0], p[:, 1], p[:, 2] * z + p[:, 3]))
        try:
            x, y, w = np.linalg.solve(plane, np.asarray([u, v, 1.0]))
        except np.linalg.LinAlgError:
            return None
        if abs(w) < 1e-12:
            return None
        return float(x / w), float(y / w)


def _centered_court_to_image(
    corners: Sequence[Sequence[float]],
    image_size: tuple[int, int],
) -> np.ndarray | None:
    try:
        court_to_image = np.linalg.inv(get_homography_matrix(corners).astype(np.float64))
    except (ValueError, cv2.error, np.linalg.LinAlgError):
        return None
    width, height = image_size
    shift = np.asarray([[1.0, 0.0, -width / 2], [0.0, 1.0, -height / 2], [0.0, 0.0, 1.0]])
    return shift @ court_to_image


def estimate_focal_length(
    corners: Sequence[Sequence[float]],
    image_size: tuple[int, int],
) -> float | None:
    """Focal length in pixels, assuming square pixels and a centered principal point."""
    homography = _centered_court_to_image(corners, image_size)
    if homography is None:
        return None
    h1, h2 = homography[:, 0], homography[:, 1]
    scale = math.sqrt(np.linalg.norm(h1) * np.linalg.norm(h2))
    if scale <= 0:
        return None
    h1, h2 = h1 / scale, h2 / scale

    # Two constraints on the image of the absolute conic; a broadcast view makes one of them
    # degenerate (a vanishing point at infinity), so the better conditioned one is used.
    orthogonality = (-(h1[0] * h2[0] + h1[1] * h2[1]), h1[2] * h2[2])
    equal_norm = (h1[0] ** 2 + h1[1] ** 2 - h2[0] ** 2 - h2[1] ** 2, h2[2] ** 2 - h1[2] ** 2)
    numerator, denominator = max((orthogonality, equal_norm), key=lambda pair: abs(pair[1]))
    if abs(denominator) < 1e-12:
        return None
    focal_squared = numerator / denominator
    if not math.isfinite(focal_squared) or focal_squared <= 0:
        return None
    focal = math.sqrt(focal_squared)
    largest_side = max(image_size)
    if not MIN_FOCAL_RATIO * largest_side <= focal <= MAX_FOCAL_RATIO * largest_side:
        return None
    return focal


def estimate_camera(
    corners: Sequence[Sequence[float]],
    image_size: tuple[int, int],
    focal_length: float | None = None,
) -> Camera | None:
    focal = focal_length or estimate_focal_length(corners, image_size)
    homography = _centered_court_to_image(corners, image_size)
    if focal is None or homography is None:
        return None

    pose = np.diag([1 / focal, 1 / focal, 1.0]) @ homography
    scale = (np.linalg.norm(pose[:, 0]) + np.linalg.norm(pose[:, 1])) / 2
    if scale <= 0:
        return None
    pose = pose / scale
    if pose[2, 2] < 0:
        pose = -pose
    r1, r2, translation = pose[:, 0], pose[:, 1], pose[:, 2]
    u, _, vt = np.linalg.svd(np.column_stack((r1, r2, np.cross(r1, r2))))
    rotation = u @ vt

    width, height = image_size
    intrinsics = np.asarray([[focal, 0.0, width / 2], [0.0, focal, height / 2], [0.0, 0.0, 1.0]])
    image_points = np.asarray(corners, dtype=np.float64)
    court_points = cv2.perspectiveTransform(
        image_points.reshape(-1, 1, 2), get_homography_matrix(corners).astype(np.float64)
    ).reshape(-1, 2)
    object_points = np.column_stack((court_points, np.zeros(4)))
    try:
        refined, rotation_vector, translation_vector = cv2.solvePnP(
            object_points,
            image_points,
            intrinsics,
            None,
            cv2.Rodrigues(rotation)[0],
            translation.reshape(3, 1).copy(),
            useExtrinsicGuess=True,
            flags=cv2.SOLVEPNP_ITERATIVE,
        )
    except cv2.error:
        refined = False
    if refined:
        rotation = cv2.Rodrigues(rotation_vector)[0]
        translation = translation_vector.reshape(3)

    camera_center = -rotation.T @ translation
    if abs(camera_center[2]) < MIN_CAMERA_HEIGHT_METERS:
        return None
    if camera_center[2] < 0:
        # The planar pose leaves the plane normal pointing down; flip it so z is height.
        rotation = rotation @ np.diag([1.0, 1.0, -1.0])

    camera = Camera(intrinsics @ np.column_stack((rotation, translation)), focal)
    tolerance = max(image_size) * MAX_CORNER_REPROJECTION_RATIO
    for (x, y), (u_pixel, v_pixel) in zip(court_points, image_points):
        projected = camera.project((x, y, 0.0))
        if projected is None or math.dist(projected, (u_pixel, v_pixel)) > tolerance:
            return None
    return camera
