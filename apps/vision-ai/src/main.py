import json
from pathlib import Path

from downloader import download_youtube_video
from tracker import TennisTracker

def run_pipeline(youtube_url: str, max_frames: int | None = None):
    print("--- INICIANDO PIPELINE DE VISION AI ---")
    video_file = download_youtube_video(youtube_url)
    
    tracker = TennisTracker(model_size="yolov8n.pt")
    telemetry = tracker.process_video(video_file, max_frames=max_frames)

    output_path = Path("./temp/telemetry_output.json")
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("w", encoding="utf-8") as output_file:
        json.dump(telemetry, output_file, indent=2)
    print(f"📄 Telemetría guardada en: {output_path}")
    return telemetry

if __name__ == "__main__":
    # URL de prueba (vídeo de punto corto)
    TEST_URL = "https://www.youtube.com/watch?v=S7uWnTMWvYc"
    run_pipeline(TEST_URL)