import os
import yt_dlp

def download_youtube_video(url: str, output_dir: str = "./temp") -> str:
    """Descarga un vídeo de YouTube, fusionando vídeo+audio con FFmpeg si hace falta."""
    os.makedirs(output_dir, exist_ok=True)
    
    ydl_opts = {
        # YouTube ya no sirve streams progresivos para muchos vídeos; fusionamos con FFmpeg
        'format': 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
        'merge_output_format': 'mp4',
        'outtmpl': os.path.join(output_dir, '%(id)s.%(ext)s'),
        'quiet': False,
        'no_warnings': True,
    }
    
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        info_dict = ydl.extract_info(url, download=True)
        # tras el merge, el contenedor final es mp4 aunque el stream de vídeo original no lo fuera
        filename = ydl.prepare_filename(info_dict, outtmpl=os.path.join(output_dir, '%(id)s.mp4'))
        print(f"✅ Vídeo descargado con éxito: {filename}")
        return filename