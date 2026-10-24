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
PLAYER_MIN_CONFIDENCE = 0.2
PLAYER_SIDELINE_EDGE_MARGIN_METERS = 0.5
PLAYER_SIDELINE_EDGE_MIN_CONFIDENCE = 0.3
MAX_PLAYER_CARRY_FORWARD_FRAMES = 3


def detect_tennis_ball_color(
    frame: np.ndarray,
    court_corners: list[tuple[int, int]],
) -> tuple[list[float], float] | None:
    hsv = cv2.cvtColor(frame, cv2.COLOR_BGR2HSV)
    mask = cv2.inRange(
        hsv,
        np.asarray((18, 100, 180), dtype=np.uint8),
        np.asarray((42, 255, 255), dtype=np.uint8),
    )
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    frame_area = frame.shape[0] * frame.shape[1]
    min_area = max(3.0, frame_area * 0.000005)
    max_area = max(50.0, frame_area * 0.00015)
    max_diameter = max(10, min(frame.shape[:2]) * 0.015)
    court_polygon = np.asarray(court_corners, dtype=np.float32)
    candidates = []

    for contour in contours:
        area = cv2.contourArea(contour)
        if not min_area <= area <= max_area:
            continue
        x, y, width, height = cv2.boundingRect(contour)
        if max(width, height) > max_diameter or min(width, height) == 0:
            continue
        aspect_ratio = width / height
        if not 0.45 <= aspect_ratio <= 2.2:
            continue
        center = (x + width / 2, y + height / 2)
        if cv2.pointPolygonTest(court_polygon, center, True) < 0:
            continue

        perimeter = cv2.arcLength(contour, True)
        circularity = 4 * math.pi * area / max(perimeter * perimeter, 1)
        candidates.append((circularity, area, [float(x), float(y), float(x + width), float(y + height)]))

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

                    baseline_margin = (
                        PLAYER_BASELINE_MARGIN_METERS if class_id == 0 else 0.0
                    )
                    if not (
                        -baseline_margin <= x_meters
                        <= COURT_LENGTH_METERS + baseline_margin
                        and 0 <= y_meters <= COURT_WIDTH_METERS
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

            if homography_matrix is not None and not any(
                detection["class"] == "ball" for detection in detections
            ):
                ball_candidate = detect_tennis_ball_color(frame, calibrated_corners)
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
                    if (
                        x_meters is not None
                        and y_meters is not None
                        and 0 <= x_meters <= COURT_LENGTH_METERS
                        and 0 <= y_meters <= COURT_WIDTH_METERS
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