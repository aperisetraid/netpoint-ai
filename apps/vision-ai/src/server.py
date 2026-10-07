import asyncio

from fastapi import FastAPI
from pydantic import BaseModel

from main import run_pipeline


class ProcessVideoRequest(BaseModel):
    youtubeUrl: str
    matchId: str


app = FastAPI()


@app.post("/process-video")
async def process_video(request: ProcessVideoRequest):
    telemetry = await asyncio.to_thread(run_pipeline, request.youtubeUrl)
    return {
        "matchId": request.matchId,
        "telemetry": telemetry,
    }