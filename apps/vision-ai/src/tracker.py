import cv2
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
PLAYER_BASELINE_MARGIN_METERS = 2.0


class TennisTracker:
    def __init__(self, model_size: str = "yolov8n.pt"):
        print(f"🔄 Cargando modelo YOLOv8 ({model_size})...")
        self.model = YOLO(model_size)
        self.court_detector = CourtDetector()
        # Clases de COCO: 0 = persona (jugadores), 32 = pelota de tenis
        self.target_classes = [0, 32]

    def process_video(self, video_path: str, max_frames: int | None = None):
        cap = cv2.VideoCapture(video_path)
        if not cap.isOpened():
            raise FileNotFoundError(f"No se pudo abrir el vídeo: {video_path}")

        fps = cap.get(cv2.CAP_PROP_FPS)
        frame_count = 0
        telemetry = []
        homography_matrix = None
        last_player_by_side = {}
        print("🚀 Iniciando inferencia con YOLOv8...")

        while cap.isOpened() and (max_frames is None or frame_count < max_frames):
            ret, frame = cap.read()
            if not ret:
                break

            if homography_matrix is None and (
                frame_count < CALIBRATION_WINDOW_FRAMES
                or (frame_count - CALIBRATION_WINDOW_FRAMES)
                % CALIBRATION_RETRY_INTERVAL == 0
            ):
                if frame_count == CALIBRATION_WINDOW_FRAMES:
                    print(
                        f"⚠️ No se encontró la pista en los primeros "
                        f"{CALIBRATION_WINDOW_FRAMES} frames; se reintentará "
                        f"cada {CALIBRATION_RETRY_INTERVAL} frames."
                    )
                court_corners = self.court_detector.detect_corners(frame)
                if court_corners is not None and len(court_corners) == 4:
                    try:
                        homography_matrix = get_homography_matrix(court_corners)
                    except (ValueError, cv2.error):
                        pass

            # Inferencia filtrada por personas y pelotas de tenis
            results = self.model(frame, classes=self.target_classes, verbose=False)
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

                detection = {
                    "class": "player" if class_id == 0 else "ball",
                    "confidence": float(box.conf[0].item()),
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

            if homography_matrix is not None:
                selected_players = []
                for side in ("left", "right"):
                    player = player_candidates_by_side.get(side)
                    if player is not None:
                        last_player_by_side[side] = player
                    else:
                        player = last_player_by_side.get(side)
                    if player is not None:
                        selected_players.append(player.copy())
                detections = selected_players + detections

            telemetry.append({
                "frame_index": frame_index,
                "timestamp_seconds": timestamp_seconds,
                "detections": detections,
            })
            frame_count += 1

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