"""Conversation persisted next to the analysis, so reopening a match resumes its chat.

Two views of the same conversation are stored:
- `messages`: the exact Messages API history (thinking blocks, tool calls and results). It is
  append-only and replayed verbatim, which keeps thinking blocks valid and the cache warm.
- `transcript`: what the UI shows (questions and answers, plus the tools each answer used).

A session is bound to the digest it was created with; if the telemetry is reprocessed the
fingerprint changes and the conversation starts over instead of citing stale data.
"""

from __future__ import annotations

import json
import os
import threading
import uuid
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path

SESSION_FILE = "coach_session.json"
SESSION_VERSION = 1

_locks: dict[Path, threading.Lock] = {}
_locks_guard = threading.Lock()


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


@dataclass
class TranscriptEntry:
    role: str  # user | assistant
    text: str
    id: str = field(default_factory=lambda: uuid.uuid4().hex)
    createdAt: str = field(default_factory=_now)
    tools: list[str] = field(default_factory=list)


@dataclass
class CoachSession:
    fingerprint: str
    messages: list[dict] = field(default_factory=list)
    transcript: list[TranscriptEntry] = field(default_factory=list)

    def commit_turn(self, api_messages: list[dict], question: TranscriptEntry, answer: TranscriptEntry) -> None:
        self.messages.extend(api_messages)
        self.transcript.extend([question, answer])


def _lock_for(path: Path) -> threading.Lock:
    with _locks_guard:
        return _locks.setdefault(path.resolve(), threading.Lock())


def load_session(folder: Path, fingerprint: str) -> CoachSession:
    path = folder / SESSION_FILE
    with _lock_for(path):
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return CoachSession(fingerprint)
    if not isinstance(payload, dict) or payload.get("version") != SESSION_VERSION or payload.get("fingerprint") != fingerprint:
        return CoachSession(fingerprint)
    try:
        transcript = [TranscriptEntry(**entry) for entry in payload.get("transcript", [])]
    except TypeError:
        return CoachSession(fingerprint)
    return CoachSession(fingerprint, list(payload.get("messages", [])), transcript)


def save_session(folder: Path, session: CoachSession) -> None:
    """Atomic write: a crash mid-save never leaves a half-written history behind."""
    path = folder / SESSION_FILE
    payload = {
        "version": SESSION_VERSION,
        "fingerprint": session.fingerprint,
        "updatedAt": _now(),
        "messages": session.messages,
        "transcript": [asdict(entry) for entry in session.transcript],
    }
    temporary = path.with_suffix(f".{uuid.uuid4().hex}.tmp")
    with _lock_for(path):
        temporary.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
        os.replace(temporary, path)


def delete_session(folder: Path) -> None:
    path = folder / SESSION_FILE
    with _lock_for(path):
        path.unlink(missing_ok=True)
