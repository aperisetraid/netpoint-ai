"""Streaming agent loop: one user turn in, UI events out.

The loop streams Claude's answer token by token, runs the frame-level tools it asks for and
feeds the results back until the answer is complete. The turn is committed to the session only
when it finishes, so an aborted or failed turn never leaves a half-written history.

UI events (dicts, serialised as SSE by the API layer):
- {"type": "text", "delta": str}          answer text as it is generated
- {"type": "replace", "text": str}        rewind the visible draft (a round was re-issued)
- {"type": "status", "label": str}        progress: tool calls and the model's progress notes
- {"type": "done", "message": {...}}      the committed answer (transcript entry)
- {"type": "error", "message": str}       the turn failed; nothing was committed
"""

from __future__ import annotations

import asyncio
import logging
import os
from collections.abc import AsyncIterator
from dataclasses import asdict, dataclass
from pathlib import Path

import anthropic
from anthropic import AsyncAnthropic

from .analysis import MatchModel
from .prompts import build_context_block
from .session import CoachSession, TranscriptEntry, save_session
from .tools import TOOL_DEFINITIONS, describe_tool_call, run_tool

logger = logging.getLogger(__name__)

MODEL = os.environ.get("NETPOINT_COACH_MODEL", "claude-opus-5-5")
EFFORT = os.environ.get("NETPOINT_COACH_EFFORT", "medium")
MAX_TOKENS = 32000
MAX_TOOL_ROUNDS = 6
MAX_JSON_RETRIES = 2
BETAS = [
    # Re-runs a classifier-declined turn on the recommended model instead of failing it.
    "server-side-fallback-2026-07-01",
    # Safety net: a thinking block that fails the prefix check is dropped instead of a 400.
    "thinking-binding-controls-2026-08-01",
    # Short progress notes between tool calls, shown as status while reasoning stays hidden.
    "thinking-display-updates-2026-08-18",
]
THINKING = {
    "type": "adaptive",
    "display": "updates",
    "block_binding": {"prefix_mismatch_behavior": "drop_block"},
}
MISSING_CREDENTIALS = (
    "No hay credenciales de Anthropic configuradas. Define ANTHROPIC_API_KEY antes de arrancar el servicio de visión."
)
LIMIT_NOTICE ="Has alcanzado el límite de consultas para esta respuesta: contesta ya con la información que tienes."

_client: AsyncAnthropic | None = None


def get_client() -> AsyncAnthropic:
    global _client
    if _client is None:
        # Without credentials the SDK only fails later, while building the request, with a bare TypeError.
        if not credentials_configured():
            raise CoachError(MISSING_CREDENTIALS)
        _client = AsyncAnthropic()
    return _client


def credentials_configured() -> bool:
    """Best-effort check for the UI; the SDK also resolves `ant auth login` profiles."""
    if any(os.environ.get(name) for name in ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_PROFILE")):
        return True
    return (Path.home() / ".config" / "anthropic").is_dir()


@dataclass(frozen=True)
class TurnRequest:
    question: str
    players: dict[str, str]
    perspective: str | None
    current_time: float | None


class CoachError(Exception):
    """A failure the user should read; the message is already in Spanish."""


def _describe_api_error(error: Exception) -> str:
    if isinstance(error, (anthropic.AuthenticationError, anthropic.PermissionDeniedError)):
        return "Las credenciales de Anthropic no son válidas. Revisa ANTHROPIC_API_KEY en el servicio de visión."
    if isinstance(error, anthropic.RateLimitError):
        return "Se alcanzó el límite de uso de la API de Claude. Espera unos segundos y vuelve a intentarlo."
    if isinstance(error, anthropic.APIConnectionError):
        return "No se pudo conectar con la API de Claude. Comprueba la conexión a internet."
    if isinstance(error, anthropic.APIStatusError):
        if error.status_code >= 500:
            return "La API de Claude está saturada o no disponible ahora mismo. Inténtalo de nuevo en un momento."
        return f"La API de Claude rechazó la petición ({error.status_code})."
    if isinstance(error, anthropic.AnthropicError):
        return MISSING_CREDENTIALS
    return "El coach no pudo completar la respuesta."


def _serialize(block) -> dict:
    """The block exactly as the API sent it, ready to be replayed in the next request."""
    return block.to_dict(mode="json", exclude_none=True)


def sanitize_fallback(content: list[dict]) -> list[dict]:
    """After a mid-output fallback, drop the declined model's thinking and tool calls before the boundary."""
    boundary = max((i for i, block in enumerate(content) if block.get("type") == "fallback"), default=None)
    if boundary is None:
        return content
    dropped = {"thinking", "redacted_thinking", "tool_use"}
    return [block for i, block in enumerate(content) if i >= boundary or block.get("type") not in dropped]


def _text_of(content: list[dict]) -> str:
    return "".join(block.get("text", "") for block in content if block.get("type") == "text").strip()


async def run_turn(
    model: MatchModel,
    system: list[dict],
    session: CoachSession,
    folder: Path,
    request: TurnRequest,
) -> AsyncIterator[dict]:
    context = build_context_block(model, request.players, request.perspective, request.current_time)
    pending: list[dict] = [{
        "role": "user",
        "content": [{"type": "text", "text": context}, {"type": "text", "text": request.question}],
    }]
    answer_parts: list[str] = []
    tool_labels: list[str] = []

    try:
        client = get_client()
        for round_index in range(MAX_TOOL_ROUNDS + 1):
            committed = "\n\n".join(answer_parts)
            message = None
            for attempt in range(MAX_JSON_RETRIES + 1):
                round_started = False
                note = ""
                try:
                    async with client.beta.messages.stream(
                        model=MODEL,
                        max_tokens=MAX_TOKENS,
                        betas=BETAS,
                        fallbacks="default",
                        system=system,
                        tools=TOOL_DEFINITIONS,
                        messages=[*session.messages, *pending],
                        thinking=THINKING,
                        output_config={"effort": EFFORT},
                        # Moves the cache breakpoint to the end of the history on every request.
                        cache_control={"type": "ephemeral"},
                    ) as stream:
                        async for event in stream:
                            if event.type == "text" and event.text:
                                if not round_started and answer_parts:
                                    yield {"type": "text", "delta": "\n\n"}
                                round_started = True
                                yield {"type": "text", "delta": event.text}
                            elif event.type == "thinking":
                                note += event.thinking
                            elif event.type == "content_block_stop" and note.strip():
                                yield {"type": "status", "label": note.strip()}
                                note = ""
                        message = await stream.get_final_message()
                    break
                except ValueError:
                    # A tool input the SDK could not parse at all: re-issue the round (bounded).
                    if attempt == MAX_JSON_RETRIES:
                        raise CoachError("El coach generó una consulta ilegible. Vuelve a intentarlo.")
                    logger.warning("Coach round %s re-issued after unparseable tool input", round_index)
                    yield {"type": "replace", "text": committed}

            assert message is not None
            usage = message.usage
            logger.info(
                "Coach round %s: stop=%s model=%s in=%s cache_read=%s out=%s",
                round_index, message.stop_reason, message.model, usage.input_tokens,
                usage.cache_read_input_tokens, usage.output_tokens,
            )
            if message.stop_reason == "refusal":
                raise CoachError("El coach no puede responder a esta consulta. Prueba a reformularla.")

            content = sanitize_fallback([_serialize(block) for block in message.content])
            pending.append({"role": "assistant", "content": content})
            text = _text_of(content)
            if text:
                answer_parts.append(text)

            tool_uses = [block for block in content if block.get("type") == "tool_use"]
            if message.stop_reason == "pause_turn":
                continue
            if message.stop_reason == "max_tokens" and tool_uses:
                raise CoachError("La respuesta se cortó por longitud. Prueba con una pregunta más acotada.")
            if not tool_uses:
                break

            labels = [describe_tool_call(block["name"], block.get("input")) for block in tool_uses]
            for label in labels:
                yield {"type": "status", "label": label}
            tool_labels.extend(labels)
            outputs = await asyncio.to_thread(
                lambda: [run_tool(model, block["name"], block.get("input")) for block in tool_uses]
            )
            results: list[dict] = [
                {"type": "tool_result", "tool_use_id": block["id"], "content": output, **({"is_error": True} if failed else {})}
                for block, (output, failed) in zip(tool_uses, outputs)
            ]
            if round_index == MAX_TOOL_ROUNDS - 1:
                results.append({"type": "text", "text": LIMIT_NOTICE})
            pending.append({"role": "user", "content": results})
        else:
            raise CoachError("El coach no llegó a una respuesta tras varias consultas. Prueba a acotar la pregunta.")

        answer_text = "\n\n".join(answer_parts).strip()
        if not answer_text:
            raise CoachError("El coach no devolvió ninguna respuesta. Vuelve a intentarlo.")

        question_entry = TranscriptEntry(role="user", text=request.question)
        answer_entry = TranscriptEntry(role="assistant", text=answer_text, tools=tool_labels)
        session.commit_turn(pending, question_entry, answer_entry)
        await asyncio.to_thread(save_session, folder, session)
        yield {"type": "done", "question": asdict(question_entry), "message": asdict(answer_entry)}
    except CoachError as error:
        yield {"type": "error", "message": str(error)}
    except anthropic.AnthropicError as error:
        logger.warning("Coach turn failed: %s", error)
        yield {"type": "error", "message": _describe_api_error(error)}
    except Exception:
        # The stream is a boundary: the browser must always get a terminal event, never a silent cut.
        logger.exception("Unexpected failure in a coach turn")
        yield {"type": "error", "message": "El coach no pudo completar la respuesta."}
