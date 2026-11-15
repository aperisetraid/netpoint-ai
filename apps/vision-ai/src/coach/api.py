"""HTTP surface of the coach: session read, streamed turns (SSE) and reset."""

from __future__ import annotations

import asyncio
import json
import threading
from collections import OrderedDict
from collections.abc import Callable
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from . import agent
from .analysis import SHOT_LABELS, SIDE_LABELS, MatchModel, build_match_model, fastest_shot, longest_point
from .digest import fingerprint, render_digest
from .prompts import REPORT_PROMPT, build_system
from .session import delete_session, load_session

TELEMETRY_FILE = "telemetry_output.json"
MODEL_CACHE_SIZE = 6


class PlayerNamesInput(BaseModel):
    far: str = Field(default="", max_length=80)
    near: str = Field(default="", max_length=80)


class CoachMessageRequest(BaseModel):
    message: str = Field(min_length=1, max_length=4000)
    players: PlayerNamesInput = Field(default_factory=PlayerNamesInput)
    perspective: Literal["far", "near", "coach"] | None = None
    currentTime: float | None = Field(default=None, ge=0)


@dataclass(frozen=True)
class CoachContext:
    model: MatchModel
    digest: str
    fingerprint: str
    system: list[dict]


_contexts: OrderedDict[tuple[Path, int], CoachContext] = OrderedDict()
_contexts_lock = threading.Lock()
_busy: set[Path] = set()


def load_context(folder: Path) -> CoachContext:
    """Tactical model and prompt of a stored match, cached by telemetry mtime."""
    telemetry_path = folder / TELEMETRY_FILE
    key = (folder.resolve(), telemetry_path.stat().st_mtime_ns)
    with _contexts_lock:
        if key in _contexts:
            _contexts.move_to_end(key)
            return _contexts[key]
    telemetry = json.loads(telemetry_path.read_text(encoding="utf-8"))
    model = build_match_model(telemetry)
    digest = render_digest(model)
    context = CoachContext(model, digest, fingerprint(digest), build_system(digest))
    with _contexts_lock:
        _contexts[key] = context
        while len(_contexts) > MODEL_CACHE_SIZE:
            _contexts.popitem(last=False)
    return context


def build_highlights(model: MatchModel) -> list[dict]:
    """Deterministic facts for the empty chat: free, instant, and each one jumps to the video."""
    highlights = []
    longest = longest_point(model)
    if longest is not None and len(longest.shots) > 1:
        highlights.append({
            "label": "Punto más largo",
            "value": f"{longest.rally_length} golpes",
            "detail": f"P{longest.number} · {longest.duration:.0f} s",
            "time": round(longest.start, 2),
        })
    fastest = fastest_shot(model)
    if fastest is not None:
        highlights.append({
            "label": "Golpe más rápido",
            "value": f"{fastest.speed_kmh:.0f} km/h",
            "detail": f"{SHOT_LABELS[fastest.type].capitalize()} · {SIDE_LABELS[fastest.player]}",
            "time": round(fastest.time, 2),
        })
    serve = fastest_shot(model, ("serve",))
    if serve is not None and serve is not fastest:
        highlights.append({
            "label": "Saque más rápido",
            "value": f"{serve.speed_kmh:.0f} km/h",
            "detail": SIDE_LABELS[serve.player],
            "time": round(serve.time, 2),
        })
    return highlights


def build_suggestions(model: MatchModel) -> list[str]:
    suggestions = []
    longest = longest_point(model)
    if longest is not None and len(longest.shots) > 1:
        suggestions.append("¿Cuál fue el intercambio más largo y cómo terminó?")
    suggestions.append("¿Por qué perdí los puntos que perdí?")
    if any(shot.type == "backhand" for shot in model.shots):
        suggestions.append("¿Qué patrón se repite cuando me atacan el revés?")
    suggestions.append("¿Cómo puedo mejorar mi posicionamiento en este partido?")
    return suggestions


def _sse(event: dict) -> bytes:
    return f"data: {json.dumps(event, ensure_ascii=False)}\n\n".encode("utf-8")


def create_coach_router(resolve_folder: Callable[[str], Path | None]) -> APIRouter:
    router = APIRouter(prefix="/coach", tags=["coach"])

    def folder_for(match_id: str) -> Path:
        folder = resolve_folder(match_id)
        if folder is None or not (folder / TELEMETRY_FILE).is_file():
            raise HTTPException(status_code=404, detail="Partido no encontrado en la biblioteca.")
        return folder

    async def context_for(folder: Path) -> CoachContext:
        try:
            return await asyncio.to_thread(load_context, folder)
        except (OSError, ValueError, KeyError, TypeError):
            raise HTTPException(status_code=422, detail="La telemetría de este partido no es compatible con el coach.")

    @router.get("/{match_id}")
    async def get_coach_session(match_id: str):
        folder = folder_for(match_id)
        context = await context_for(folder)
        session = await asyncio.to_thread(load_session, folder, context.fingerprint)
        return {
            "available": agent.credentials_configured(),
            "model": agent.MODEL,
            "messages": [asdict(entry) for entry in session.transcript],
            "highlights": build_highlights(context.model),
            "suggestions": build_suggestions(context.model),
            "reportPrompt": REPORT_PROMPT,
        }

    @router.post("/{match_id}/messages")
    async def post_coach_message(match_id: str, request: CoachMessageRequest):
        folder = folder_for(match_id)
        context = await context_for(folder)
        key = folder.resolve()
        if key in _busy:
            raise HTTPException(status_code=409, detail="El coach todavía está respondiendo en este partido.")
        session = await asyncio.to_thread(load_session, folder, context.fingerprint)
        turn = agent.TurnRequest(
            question=request.message.strip(),
            players=request.players.model_dump(),
            perspective=request.perspective,
            current_time=request.currentTime,
        )
        _busy.add(key)

        async def events():
            try:
                async for event in agent.run_turn(context.model, context.system, session, folder, turn):
                    yield _sse(event)
            finally:
                _busy.discard(key)

        return StreamingResponse(
            events(),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    @router.delete("/{match_id}", status_code=204)
    async def reset_coach_session(match_id: str):
        folder = folder_for(match_id)
        if folder.resolve() in _busy:
            raise HTTPException(status_code=409, detail="Espera a que el coach termine de responder.")
        await asyncio.to_thread(delete_session, folder)

    return router
