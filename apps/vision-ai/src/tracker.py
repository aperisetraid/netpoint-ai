import cv2
from ultralytics import YOLO

from court_detector import CourtDetector
from homography import get_homography_matrix, transform_point


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
        print("🚀 Iniciando inferencia con YOLOv8...")

        while cap.isOpened() and (max_frames is None or frame_count < max_frames):
            ret, frame = cap.read()
            if not ret:
                break

            if frame_count == 0:
                court_corners = self.court_detector.detect_corners(frame)
                if court_corners is not None:
                    try:
                        homography_matrix = get_homography_matrix(court_corners)
                    except ValueError:
                        homography_matrix = None

            # Inferencia filtrada por personas y pelotas de tenis
            results = self.model(frame, classes=self.target_classes, verbose=False)
            frame_index = frame_count
            timestamp_seconds = (
                frame_index / fps
                if fps > 0
                else cap.get(cv2.CAP_PROP_POS_MSEC) / 1000.0
            )
            detections = []
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
                    except ValueError:
                        pass

                detections.append({
                    "class": "player" if class_id == 0 else "ball",
                    "confidence": float(box.conf[0].item()),
                    "bbox": bbox,
                    "x_meters": x_meters,
                    "y_meters": y_meters,
                })

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
        return telemetry