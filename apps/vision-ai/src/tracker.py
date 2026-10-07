import cv2
from ultralytics import YOLO

class TennisTracker:
    def __init__(self, model_size: str = "yolov8n.pt"):
        print(f"🔄 Cargando modelo YOLOv8 ({model_size})...")
        self.model = YOLO(model_size)
        # Clases de COCO: 0 = persona (jugadores), 32 = pelota de tenis
        self.target_classes = [0, 32]

    def process_video(self, video_path: str, max_frames: int = 150):
        cap = cv2.VideoCapture(video_path)
        if not cap.isOpened():
            raise FileNotFoundError(f"No se pudo abrir el vídeo: {video_path}")

        frame_count = 0
        print("🚀 Iniciando inferencia con YOLOv8...")

        while cap.isOpened() and frame_count < max_frames:
            ret, frame = cap.read()
            if not ret:
                break

            # Inferencia filtrada por personas y pelotas de tenis
            results = self.model(frame, classes=self.target_classes, verbose=False)
            frame_count += 1

            if frame_count % 30 == 0:
                print(f"Fotogramas procesados: {frame_count}/{max_frames}")

        cap.release()
        cv2.destroyAllWindows()
        print(f"✨ Inferencia completada. {frame_count} fotogramas analizados.")