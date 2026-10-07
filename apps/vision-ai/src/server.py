import asyncio

from fastapi import FastAPI
from pydantic import BaseModel, Field

from main import run_pipeline


class ProcessVideoRequest(BaseModel):
    youtubeUrl: str
    matchId: str
    maxFrames: int | None = Field(default=None, ge=1)


app = FastAPI()


@app.post("/process-video")
async def process_video(request: ProcessVideoRequest):
    telemetry = await asyncio.to_thread(
        run_pipeline,
        request.youtubeUrl,
        request.maxFrames,
    )
    return {
        "matchId": request.matchId,
        "telemetry": telemetry,
    }