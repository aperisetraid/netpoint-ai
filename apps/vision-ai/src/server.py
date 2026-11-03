import asyncio
from pathlib import Path
from urllib.parse import unquote
from uuid import uuid4

import cv2
from fastapi import FastAPI, Header, HTTPException, Path as PathParameter, Request
from fastapi.responses import Response
from pydantic import BaseModel, Field

from main import process_video_file, run_pipeline


class ProcessVideoRequest(BaseModel):
    youtubeUrl: str
    matchId: str
    maxFrames: int | None = Field(default=None, ge=1)


app = FastAPI()
processed_videos: dict[str, tuple[Path, int]] = {}
progress_by_match: dict[str, dict[str, int | None]] = {}
match_video_root = Path("./temp/matches")
allowed_video_extensions = {".mp4", ".m4v", ".mov", ".avi", ".mkv", ".webm"}
max_upload_bytes = 1024 * 1024 * 1024


def read_video_frame(video_path: Path, frame_index: int) -> bytes:
    capture = cv2.VideoCapture(str(video_path))
    try:
        if not capture.isOpened():
            raise HTTPException(status_code=404, detail="Video no disponible.")
        capture.set(cv2.CAP_PROP_POS_FRAMES, frame_index)
        success, frame = capture.read()
        if not success:
            raise HTTPException(status_code=404, detail="Fotograma no disponible.")
        encoded, image = cv2.imencode(".jpg", frame)
        if not encoded:
            raise HTTPException(status_code=500, detail="No se pudo codificar el fotograma.")
        return image.tobytes()
    finally:
        capture.release()


def update_match_progress(match_id: str, processed_frames: int, total_frames: int | None):
    progress_by_match[match_id] = {
        "processedFrames": processed_frames,
        "totalFrames": total_frames,
    }


def get_match_progress(match_id: str):
    return progress_by_match.get(
        match_id,
        {"processedFrames": 0, "totalFrames": None},
    )


@app.get("/matches/{match_id}/frames/{frame_index}")
async def get_video_frame(match_id: str, frame_index: int = PathParameter(ge=0)):
    video = processed_videos.get(match_id)
    if video is None or frame_index >= video[1]:
        raise HTTPException(status_code=404, detail="Fotograma no disponible.")
    image = await asyncio.to_thread(read_video_frame, video[0], frame_index)
    return Response(content=image, media_type="image/jpeg", headers={"Cache-Control": "no-store"})


@app.post("/process-video")
async def process_video(request: ProcessVideoRequest):
    output_dir = match_video_root / str(uuid4())
    progress_by_match[request.matchId] = {"processedFrames": 0, "totalFrames": None}
    telemetry = await asyncio.to_thread(
        run_pipeline,
        request.youtubeUrl,
        request.maxFrames,
        str(output_dir),
        lambda processed, total: update_match_progress(request.matchId, processed, total),
    )
    video_path = next(output_dir.glob("*.mp4"), None)
    if video_path is not None:
        processed_videos[request.matchId] = (video_path, len(telemetry))
    return {
        "matchId": request.matchId,
        "telemetry": telemetry,
    }


@app.post("/process-upload")
async def process_video_upload(
    request: Request,
    match_id: str = Header(alias="X-Match-Id"),
    filename: str = Header(alias="X-Video-Filename"),
):
    safe_filename = Path(unquote(filename)).name
    if Path(safe_filename).suffix.lower() not in allowed_video_extensions:
        raise HTTPException(status_code=415, detail="Formato de video no compatible.")

    output_dir = Path("./temp/matches") / str(uuid4())
    output_dir.mkdir(parents=True, exist_ok=True)
    video_path = output_dir / safe_filename
    received_bytes = 0
    try:
        with video_path.open("wb") as video_file:
            async for chunk in request.stream():
                received_bytes += len(chunk)
                if received_bytes > max_upload_bytes:
                    raise HTTPException(status_code=413, detail="El video supera el limite de 1 GB.")
                video_file.write(chunk)

        if received_bytes == 0:
            raise HTTPException(status_code=400, detail="El archivo de video esta vacio.")

        progress_by_match[match_id] = {"processedFrames": 0, "totalFrames": None}
        telemetry = await asyncio.to_thread(
            process_video_file,
            video_path,
            None,
            str(output_dir),
            lambda processed, total: update_match_progress(match_id, processed, total),
        )
    except HTTPException:
        video_path.unlink(missing_ok=True)
        raise
    except Exception:
        video_path.unlink(missing_ok=True)
        raise

    processed_videos[match_id] = (video_path, len(telemetry))
    return {"matchId": match_id, "telemetry": telemetry}


@app.get("/matches/{match_id}/progress")
async def get_video_progress(match_id: str):
    return get_match_progress(match_id)