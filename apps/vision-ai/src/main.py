from downloader import download_youtube_video
from tracker import TennisTracker

def run_pipeline(youtube_url: str):
    print("--- INICIANDO PIPELINE DE VISION AI ---")
    video_file = download_youtube_video(youtube_url)
    
    tracker = TennisTracker(model_size="yolov8n.pt")
    tracker.process_video(video_file, max_frames=150)

if __name__ == "__main__":
    # URL de prueba (vídeo de punto corto)
    TEST_URL = "https://www.youtube.com/watch?v=S7uWnTMWvYc"
    run_pipeline(TEST_URL)