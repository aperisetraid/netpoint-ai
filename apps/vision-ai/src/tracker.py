import math
from collections.abc import Callable

import cv2
import numpy as np
from ultralytics import YOLO

from court_detector import CourtDetector
from homography import (
    COURT_LENGTH_METERS,
    COURT_WIDTH_METERS,
    get_homography_matrix,
    transform_point,
)


CALIBRATION_WINDOW_FRAMES = 30
CALIBRATION_RETRY_INTERVAL = 5
PLAYER_BASELINE_MARGIN_METERS = 5.0
PLAYER_SIDELINE_MARGIN_METERS = 3.0
PLAYER_OFF_COURT_MIN_CONFIDENCE = 0.4
PLAYER_SIDELINE_BASELINE_ZONE_METERS = 2.0
PLAYER_MIN_CONFIDENCE = 0.2
PLAYER_SIDELINE_EDGE_MARGIN_METERS = 0.5
PLAYER_SIDELINE_EDGE_MIN_CONFIDENCE = 0.3
MAX_PLAYER_CARRY_FORWARD_FRAMES = 3


def ball_candidate_near_player(
    ball_bbox: list[float],
    player_bboxes: list[list[float]],
) -> bool:
    for player_bbox in player_bboxes:
        if (
            max(ball_bbox[0], player_bbox[0]) < min(ball_bbox[2], player_bbox[2])
            and max(ball_bbox[1], player_bbox[1]) < min(ball_bbox[3], player_bbox[3])
        ):
            return True
    return False


def color_candidate_near_player(
    ball_bbox: list[float],
    player_bboxes: list[list[float]],
) -> bool:
    center_x = (ball_bbox[0] + ball_bbox[2]) / 2
    center_y = (ball_bbox[1] + ball_bbox[3]) / 2
    for player_bbox in player_bboxes:
        margin_x = max(24.0, (player_bbox[2] - player_bbox[0]) * 0.15)
        margin_y = max(12.0, (player_bbox[3] - player_bbox[1]) * 0.04)
        if (
            player_bbox[0] - margin_x <= center_x <= player_bbox[2] + margin_x
            and player_bbox[1] - margin_y <= center_y <= player_bbox[3] + margin_y
        ):
            return True
    return False


def distance_to_nearest_player(
    point: tuple[float, float],
    player_bboxes: list[list[float]],
) -> float | None:
    if not player_bboxes:
        return None
    distances = []
    for player_bbox in player_bboxes:
        dx = max(player_bbox[0] - point[0], 0.0, point[0] - player_bbox[2])
        dy = max(player_bbox[1] - point[1], 0.0, point[1] - player_bbox[3])
        distances.append(math.hypot(dx, dy))
    return min(distances)


def point_near_court_baseline(
    point: tuple[float, float],
    court_corners: list[tuple[int, int]],
) -> bool:
    corners = np.asarray(court_corners, dtype=np.float32)
    edges = [
        (float(np.linalg.norm(end - start)), start, end)
        for start, end in zip(corners, np.roll(corners, -1, axis=0))
    ]
    baselines = sorted(edges, key=lambda edge: edge[0], reverse=True)[:2]
    baseline_midpoints = [(start + end) / 2 for _, start, end in baselines]
    court_depth = float(np.linalg.norm(baseline_midpoints[0] - baseline_midpoints[1]))
    max_extension = max(12.0, court_depth * 0.35)
    point_array = np.asarray(point, dtype=np.float32)

    for _, start, end in baselines:
        edge = end - start
        projection = float(np.dot(point_array - start, edge) / np.dot(edge, edge))
        if not 0 <= projection <= 1:
            continue
        closest_point = start + projection * edge
        if np.linalg.norm(point_array - closest_point) <= max_extension:
            return True
    return False


def point_in_ball_tracking_region(
    point: tuple[float, float],
    court_corners: list[tuple[int, int]],
) -> bool:
    court_polygon = np.asarray(court_corners, dtype=np.float32)
    return (
        cv2.pointPolygonTest(court_polygon, point, True) >= 0
        or point_near_court_baseline(point, court_corners)
    )


def point_outside_court_near_baseline(
    point: tuple[float, float],
    court_corners: list[tuple[int, int]],
) -> bool:
    court_polygon = np.asarray(court_corners, dtype=np.float32)
    return (
        cv2.pointPolygonTest(court_polygon, point, True) < 0
        and point_near_court_baseline(point, court_corners)
    )


def player_within_tracking_region(
    x_meters: float,
    y_meters: float,
    confidence: float,
) -> bool:
    if not -PLAYER_BASELINE_MARGIN_METERS <= x_meters <= COURT_LENGTH_METERS + PLAYER_BASELINE_MARGIN_METERS:
        return False
    if not -PLAYER_SIDELINE_MARGIN_METERS <= y_meters <= COURT_WIDTH_METERS + PLAYER_SIDELINE_MARGIN_METERS:
        return False
    if 0 <= y_meters <= COURT_WIDTH_METERS:
        return True
    return (
        confidence >= PLAYER_OFF_COURT_MIN_CONFIDENCE
        and (
            x_meters <= PLAYER_SIDELINE_BASELINE_ZONE_METERS
            or x_meters >= COURT_LENGTH_METERS - PLAYER_SIDELINE_BASELINE_ZONE_METERS
        )
    )


def detect_tennis_ball_color(
    frame: np.ndarray,
    court_corners: list[tuple[int, int]],
    previous_frame: np.ndarray | None = None,
    player_bboxes: list[list[float]] | None = None,
    previous_ball_bbox: list[float] | None = None,
    previous_ball_near_player: bool = False,
) -> tuple[list[float], float] | None:
    hsv = cv2.cvtColor(frame, cv2.COLOR_BGR2HSV)
    mask = cv2.inRange(
        hsv,
        np.asarray((18, 35, 175), dtype=np.uint8),
        np.asarray((96, 255, 255), dtype=np.uint8),
    )
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    frame_area = frame.shape[0] * frame.shape[1]
    min_area = max(1.0, frame_area * 0.000001)
    max_area = max(100.0, frame_area * 0.00025)
    max_diameter = max(16, min(frame.shape[:2]) * 0.035)
    court_polygon = np.asarray(court_corners, dtype=np.float32)
    motion_mask = None
    if previous_frame is not None and previous_frame.shape == frame.shape:
        difference = cv2.absdiff(frame, previous_frame)
        difference = cv2.cvtColor(difference, cv2.COLOR_BGR2GRAY)
        motion_mask = cv2.threshold(difference, 15, 255, cv2.THRESH_BINARY)[1]
    candidates = []

    for contour in contours:
        area = cv2.contourArea(contour)
        if not min_area <= area <= max_area:
            continue
        x, y, width, height = cv2.boundingRect(contour)
        if max(width, height) > max_diameter or min(width, height) == 0:
            continue
        motion_fraction = 0.0
        if motion_mask is not None:
            motion_fraction = cv2.countNonZero(
                motion_mask[y:y + height, x:x + width]
            ) / (width * height)
            if motion_fraction < 0.35:
                continue
        aspect_ratio = width / height
        if not 0.12 <= aspect_ratio <= 5.0:
            continue
        center = (x + width / 2, y + height / 2)
        if not point_in_ball_tracking_region(center, court_corners):
            continue
        bbox = [float(x), float(y), float(x + width), float(y + height)]
        if player_bboxes and color_candidate_near_player(bbox, player_bboxes):
            if (
                ball_candidate_near_player(bbox, player_bboxes)
                or cv2.pointPolygonTest(court_polygon, center, True) >= 0
                or not point_near_court_baseline(center, court_corners)
            ):
                continue

        perimeter = cv2.arcLength(contour, True)
        circularity = 4 * math.pi * area / max(perimeter * perimeter, 1)
        score = circularity + motion_fraction * 0.5
        player_distance = distance_to_nearest_player(center, player_bboxes or [])
        if player_distance is not None and player_distance <= 120:
            score += 1.5 * (1.0 - player_distance / 120)
        if previous_ball_bbox is not None:
            previous_center = (
                (previous_ball_bbox[0] + previous_ball_bbox[2]) / 2,
                (previous_ball_bbox[1] + previous_ball_bbox[3]) / 2,
            )
            distance = math.dist(center, previous_center)
            max_displacement = max(60.0, min(frame.shape[:2]) * 0.1)
            if distance <= max_displacement:
                continuity_weight = 2.0 if previous_ball_near_player else 0.15
                score += continuity_weight * (1.0 - distance / max_displacement)
        candidates.append((score, area, bbox))

    if not candidates:
        return None
    circularity, _, bbox = max(candidates, key=lambda candidate: candidate[0] + candidate[1] / max_area * 0.1)
    return bbox, min(0.65, 0.45 + circularity * 0.2)


class TennisTracker:
    def __init__(self, model_size: str = "yolov8n.pt"):
        print(f"🔄 Cargando modelo YOLOv8 ({model_size})...")
        self.model = YOLO(model_size)
        self.court_detector = CourtDetector()
        # Clases de COCO: 0 = persona (jugadores), 32 = pelota de tenis
        self.target_classes = [0, 32]

    def process_video(
        self,
        video_path: str,
        max_frames: int | None = None,
        progress_callback: Callable[[int, int | None], None] | None = None,
    ):
        cap = cv2.VideoCapture(video_path)
        if not cap.isOpened():
            raise FileNotFoundError(f"No se pudo abrir el vídeo: {video_path}")

        fps = cap.get(cv2.CAP_PROP_FPS)
        total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT)) or None
        if max_frames is not None and total_frames is not None:
            total_frames = min(total_frames, max_frames)
        frame_count = 0
        telemetry = []
        homography_matrix = None
        calibrated_corners = None
        last_player_by_side = {}
        last_player_frame_by_side = {}
        previous_video_frame = None
        if progress_callback is not None:
            progress_callback(0, total_frames)
        print("🚀 Iniciando inferencia con YOLOv8...")

        while cap.isOpened() and (max_frames is None or frame_count < max_frames):
            ret, frame = cap.read()
            if not ret:
                break

            should_detect_court = (
                frame_count % CALIBRATION_RETRY_INTERVAL == 0
                if homography_matrix is not None
                else frame_count < CALIBRATION_WINDOW_FRAMES
                or frame_count % CALIBRATION_RETRY_INTERVAL == 0
            )
            if should_detect_court:
                if (
                    homography_matrix is None
                    and frame_count == CALIBRATION_WINDOW_FRAMES
                ):
                    print(
                        f"⚠️ No se encontró la pista en los primeros "
                        f"{CALIBRATION_WINDOW_FRAMES} frames; se reintentará "
                        f"cada {CALIBRATION_RETRY_INTERVAL} frames."
                    )
                court_corners = self.court_detector.detect_corners(frame)
                if court_corners is not None and len(court_corners) == 4:
                    try:
                        homography_matrix = get_homography_matrix(court_corners)
                        calibrated_corners = court_corners
                    except (ValueError, cv2.error):
                        pass

            # Inferencia filtrada por personas y pelotas de tenis
            results = self.model(frame, classes=self.target_classes, conf=0.12, verbose=False)
            frame_index = frame_count
            timestamp_seconds = (
                frame_index / fps
                if fps > 0
                else cap.get(cv2.CAP_PROP_POS_MSEC) / 1000.0
            )
            detections = []
            player_candidates_by_side = {}
            player_bboxes = []
            ball_candidates = []
            for box in results[0].boxes:
                class_id = int(box.cls[0].item())
                confidence = float(box.conf[0].item())
                if class_id == 0 and confidence < PLAYER_MIN_CONFIDENCE:
                    continue
                bbox = [float(coordinate) for coordinate in box.xyxy[0].tolist()]
                x1, _, x2, y2 = bbox
                x_meters = None
                y_meters = None
                if homography_matrix is not None:
                    try:
                        x_meters, y_meters = transform_point(
                            ((x1 + x2) / 2, y2),
                            homography_matrix,
                        )
                    except (ValueError, cv2.error):
                        continue

                    if class_id == 0:
                        if not player_within_tracking_region(
                            x_meters,
                            y_meters,
                            confidence,
                        ):
                            continue
                    elif not (
                        0 <= x_meters <= COURT_LENGTH_METERS
                        and 0 <= y_meters <= COURT_WIDTH_METERS
                    ) and not (
                        class_id == 32
                        and calibrated_corners is not None
                        and point_in_ball_tracking_region(
                            ((bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2),
                            calibrated_corners,
                        )
                    ):
                        continue
                    if (
                        class_id == 0
                        and min(y_meters, COURT_WIDTH_METERS - y_meters)
                        < PLAYER_SIDELINE_EDGE_MARGIN_METERS
                        and confidence < PLAYER_SIDELINE_EDGE_MIN_CONFIDENCE
                    ):
                        continue

                detection = {
                    "class": "player" if class_id == 0 else "ball",
                    "confidence": confidence,
                    "bbox": bbox,
                    "x_meters": x_meters,
                    "y_meters": y_meters,
                }
                if class_id == 0:
                    player_bboxes.append(bbox)
                if class_id == 32:
                    ball_candidates.append(detection)
                    continue
                if homography_matrix is None or class_id != 0:
                    detections.append(detection)
                    continue

                side = (
                    "left"
                    if x_meters < COURT_LENGTH_METERS / 2
                    else "right"
                )
                current_candidate = player_candidates_by_side.get(side)
                if (
                    current_candidate is None
                    or detection["confidence"] > current_candidate["confidence"]
                ):
                    player_candidates_by_side[side] = detection

            detections.extend(
                detection
                for detection in ball_candidates
                if not ball_candidate_near_player(detection["bbox"], player_bboxes)
                or (
                    calibrated_corners is not None
                    and point_outside_court_near_baseline(
                        (
                            (detection["bbox"][0] + detection["bbox"][2]) / 2,
                            (detection["bbox"][1] + detection["bbox"][3]) / 2,
                        ),
                        calibrated_corners,
                    )
                )
            )

            if homography_matrix is not None and previous_video_frame is not None and not any(
                detection["class"] == "ball" for detection in detections
            ):
                previous_ball_bbox = None
                previous_ball_near_player = False
                if telemetry:
                    previous_detections = telemetry[-1]["detections"]
                    previous_ball = next(
                        (
                            detection
                            for detection in reversed(previous_detections)
                            if detection["class"] == "ball"
                        ),
                        None,
                    )
                    if previous_ball is not None:
                        previous_ball_bbox = previous_ball["bbox"]
                        previous_players = [
                            detection["bbox"]
                            for detection in previous_detections
                            if detection["class"] == "player"
                        ]
                        previous_ball_center = (
                            (previous_ball_bbox[0] + previous_ball_bbox[2]) / 2,
                            (previous_ball_bbox[1] + previous_ball_bbox[3]) / 2,
                        )
                        previous_player_distance = distance_to_nearest_player(
                            previous_ball_center,
                            previous_players,
                        )
                        previous_ball_near_player = (
                            previous_player_distance is not None
                            and previous_player_distance <= 60
                        )
                ball_candidate = detect_tennis_ball_color(
                    frame,
                    calibrated_corners,
                    previous_video_frame,
                    player_bboxes,
                    previous_ball_bbox,
                    previous_ball_near_player,
                )
                if ball_candidate is not None:
                    bbox, confidence = ball_candidate
                    x1, y1, x2, y2 = bbox
                    try:
                        x_meters, y_meters = transform_point(
                            ((x1 + x2) / 2, y2),
                            homography_matrix,
                        )
                    except (ValueError, cv2.error):
                        x_meters = y_meters = None
                    if point_in_ball_tracking_region(
                        ((bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2),
                        calibrated_corners,
                    ):
                        detections.append({
                            "class": "ball",
                            "confidence": confidence,
                            "bbox": bbox,
                            "x_meters": x_meters,
                            "y_meters": y_meters,
                        })

            if homography_matrix is not None:
                selected_players = []
                for side in ("left", "right"):
                    player = player_candidates_by_side.get(side)
                    if player is not None:
                        last_player_by_side[side] = player
                        last_player_frame_by_side[side] = frame_count
                    else:
                        player = last_player_by_side.get(side)
                        previous_frame = last_player_frame_by_side.get(side, frame_count)
                        if (
                            player is not None
                            and frame_count - previous_frame
                            <= MAX_PLAYER_CARRY_FORWARD_FRAMES
                        ):
                            player = {**player, "carried_forward": True}
                        else:
                            player = None
                            last_player_by_side.pop(side, None)
                            last_player_frame_by_side.pop(side, None)
                    if player is not None:
                        selected_players.append(player.copy())
                detections = selected_players + detections

            telemetry.append({
                "frame_index": frame_index,
                "timestamp_seconds": timestamp_seconds,
                "image_width": frame.shape[1],
                "image_height": frame.shape[0],
                "court_corners": calibrated_corners,
                "detections": detections,
            })
            frame_count += 1
            previous_video_frame = frame
            if progress_callback is not None and (
                frame_count % 5 == 0
                or (total_frames is not None and frame_count >= total_frames)
            ):
                progress_callback(frame_count, total_frames)

            if frame_count % 30 == 0:
                frame_limit = f"/{max_frames}" if max_frames is not None else ""
                print(f"Fotogramas procesados: {frame_count}{frame_limit}")

        cap.release()
        cv2.destroyAllWindows()
        print(f"✨ Inferencia completada. {frame_count} fotogramas analizados.")
        if homography_matrix is None:
            print(
                "⚠️ No se pudo calibrar la pista; las coordenadas métricas "
                "quedan como null."
            )
        return telemetry