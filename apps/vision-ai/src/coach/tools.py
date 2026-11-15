"""Frame-level retrieval tools the coach calls on demand.

The digest already holds every event; these tools answer what the digest cannot: where both
players stood between shots, how the ball flew, and filtered shot lists. Inputs are validated
with Pydantic before running: with eager input streaming the API no longer validates them.
"""

from __future__ import annotations

import json
import math
from collections.abc import Callable
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from .analysis import (
    SHOT_LABELS,
    SIDE_LABELS,
    SIDES,
    Landing,
    MatchModel,
    Shot,
    court_zone,
    depth_from_baseline,
    format_clock,
    lateral_offset,
    path_length,
    track_window,
    ball_samples,
)

MAX_POSITION_WINDOW_SECONDS = 90.0
MAX_POSITION_SAMPLES = 160
MAX_BALL_WINDOW_SECONDS = 12.0
MAX_BALL_SAMPLES = 150
MAX_SHOT_RESULTS = 60

Side = Literal["far", "near"]
ShotType = Literal["serve", "forehand", "backhand", "volley"]


class _Input(BaseModel):
    model_config = ConfigDict(extra="forbid")


class GetPointInput(_Input):
    point_number: int = Field(ge=1)


class FindShotsInput(_Input):
    player: Side | None = None
    shot_type: ShotType | None = None
    min_speed_kmh: float | None = Field(default=None, ge=0)
    max_speed_kmh: float | None = Field(default=None, ge=0)
    landing: Literal["corta", "media", "profunda", "fuera", "sin_bote"] | None = None
    incoming_side: Literal["derecha", "centro", "izquierda"] | None = None
    ends_point: Literal["error", "ganador", "indeterminado", "no"] | None = None
    start_s: float | None = Field(default=None, ge=0)
    end_s: float | None = Field(default=None, ge=0)
    limit: int = Field(default=40, ge=1, le=MAX_SHOT_RESULTS)


class GetPositionsInput(_Input):
    start_s: float = Field(ge=0)
    end_s: float = Field(ge=0)
    player: Side | Literal["both"] = "both"
    step_s: float = Field(default=0.4, ge=0.04, le=5.0)


class GetBallTrackInput(_Input):
    start_s: float = Field(ge=0)
    end_s: float = Field(ge=0)
    step_s: float = Field(default=0.12, ge=0.04, le=1.0)


PLAYER_SCHEMA = {"type": "string", "enum": list(SIDES), "description": "far = Fondo (lado lejano), near = Cámara."}

TOOL_DEFINITIONS: list[dict] = [
    {
        "name": "get_point",
        "description": (
            "Detalle completo de un punto: cada golpe con la posición de AMBOS jugadores en ese instante, "
            "la bola que le llegó, dónde botó, el tempo entre golpes, y el movimiento de cada jugador durante el punto "
            "(distancia, profundidad media, zonas). Úsala para explicar cómo se construyó o se perdió un punto."
        ),
        "input_schema": {
            "type": "object",
            "properties": {"point_number": {"type": "integer", "minimum": 1, "description": "Número de punto (P1, P2...)."}},
            "required": ["point_number"],
            "additionalProperties": False,
        },
    },
    {
        "name": "find_shots",
        "description": (
            "Filtra golpes del partido por jugador, tipo, velocidad, profundidad del bote, lado por el que le llegó la bola, "
            "si cerró el punto y ventana temporal. Devuelve la lista y un resumen agregado. Úsala para contar, comparar "
            "o encontrar ejemplos concretos de un patrón."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "player": PLAYER_SCHEMA,
                "shot_type": {"type": "string", "enum": ["serve", "forehand", "backhand", "volley"]},
                "min_speed_kmh": {"type": "number", "minimum": 0},
                "max_speed_kmh": {"type": "number", "minimum": 0},
                "landing": {
                    "type": "string",
                    "enum": ["corta", "media", "profunda", "fuera", "sin_bote"],
                    "description": "Dónde botó el golpe en campo rival (o fuera / sin bote registrado).",
                },
                "incoming_side": {
                    "type": "string",
                    "enum": ["derecha", "centro", "izquierda"],
                    "description": "Lado del golpeador por el que le llegó la bola (izquierda = revés de un diestro).",
                },
                "ends_point": {
                    "type": "string",
                    "enum": ["error", "ganador", "indeterminado", "no"],
                    "description": "Si el golpe fue el último del punto y cómo terminó; 'no' = el punto siguió.",
                },
                "start_s": {"type": "number", "minimum": 0},
                "end_s": {"type": "number", "minimum": 0},
                "limit": {"type": "integer", "minimum": 1, "maximum": MAX_SHOT_RESULTS},
            },
            "additionalProperties": False,
        },
    },
    {
        "name": "get_positions",
        "description": (
            "Trayectoria de los jugadores en una ventana de tiempo, muestreada cada step_s segundos, con zona de pista, "
            "profundidad respecto a su línea de fondo y desplazamiento lateral desde su punto de vista. Incluye distancia "
            "recorrida. Úsala para analizar posicionamiento, recuperación y cobertura de pista."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "start_s": {"type": "number", "minimum": 0},
                "end_s": {"type": "number", "minimum": 0, "description": f"Ventana máxima {MAX_POSITION_WINDOW_SECONDS:.0f} s."},
                "player": {"type": "string", "enum": ["far", "near", "both"]},
                "step_s": {"type": "number", "minimum": 0.04, "maximum": 5},
            },
            "required": ["start_s", "end_s"],
            "additionalProperties": False,
        },
    },
    {
        "name": "get_ball_track",
        "description": (
            "Posiciones de la pelota fotograma a fotograma (x, y en metros y altura z cuando existe la reconstrucción 3D) "
            "en una ventana corta. Úsala para ver la trayectoria exacta de un golpe concreto, su altura sobre la red o "
            "por qué terminó un punto."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "start_s": {"type": "number", "minimum": 0},
                "end_s": {"type": "number", "minimum": 0, "description": f"Ventana máxima {MAX_BALL_WINDOW_SECONDS:.0f} s."},
                "step_s": {"type": "number", "minimum": 0.04, "maximum": 1},
            },
            "required": ["start_s", "end_s"],
            "additionalProperties": False,
        },
    },
]

# Small tool inputs still stream as they are generated: no buffering pause before each call.
for _definition in TOOL_DEFINITIONS:
    _definition["eager_input_streaming"] = True


class ToolError(Exception):
    """A tool could not run with the given input; the message is returned to the model."""


def _r(value: float | None, digits: int = 2) -> float | None:
    return round(value, digits) if value is not None and math.isfinite(value) else None


def _landing_dict(landing: Landing | None) -> dict | None:
    if landing is None:
        return None
    return {
        "t": _r(landing.time),
        "x": _r(landing.x),
        "y": _r(landing.y),
        "profundidad": landing.depth,
        "lado_receptor": landing.lateral,
        "estado": landing.status,
        "fuera": landing.out_kind,
        "metodo": landing.method,
    }


def _shot_dict(shot: Shot, model: MatchModel, with_rival: bool = False) -> dict:
    data = {
        "golpe": shot.index,
        "punto": shot.point,
        "n_en_punto": shot.number,
        "t": _r(shot.time),
        "reloj": format_clock(shot.time),
        "jugador": SIDE_LABELS[shot.player],
        "tipo": SHOT_LABELS[shot.type],
        "vel_kmh": _r(shot.speed_kmh, 0),
        "confianza": shot.confidence,
        "posicion": {"x": _r(shot.x), "y": _r(shot.y), "zona": shot.zone, "lado": shot.lateral},
        "le_llega": _landing_dict(shot.incoming),
        "bote": _landing_dict(shot.landing),
        "tempo_s": _r(shot.tempo),
    }
    if shot.after_missed_reply:
        data["aviso"] = "falta un golpe del rival antes"
    if with_rival:
        rival = "near" if shot.player == "far" else "far"
        position = model.position_at(rival, shot.time)
        data["rival"] = None if position is None else {
            "x": _r(position.x),
            "y": _r(position.y),
            "zona": court_zone(rival, position.x),
            "lateral_m": _r(lateral_offset(rival, position.y)),
        }
    return data


def _movement_summary(model: MatchModel, side: str, start: float, end: float) -> dict:
    samples = track_window(model, side, start, end, 0.2)
    if not samples:
        return {"jugador": SIDE_LABELS[side], "sin_datos": True}
    depths = [depth_from_baseline(side, s.x) for s in samples]
    zones: dict[str, int] = {}
    for sample in samples:
        zone = court_zone(side, sample.x)
        zones[zone] = zones.get(zone, 0) + 1
    return {
        "jugador": SIDE_LABELS[side],
        "distancia_m": _r(path_length(samples), 1),
        "profundidad_media_m": _r(sum(depths) / len(depths)),
        "zonas": {zone: f"{count / len(samples):.0%}" for zone, count in zones.items()},
        "lateral_max_m": _r(max(abs(lateral_offset(side, s.y)) for s in samples)),
    }


def get_point(model: MatchModel, data: GetPointInput) -> dict:
    point = model.point(data.point_number)
    if point is None:
        raise ToolError(f"No existe el punto {data.point_number}; el partido tiene {len(model.points)} puntos.")
    return {
        "punto": point.number,
        "inicio": {"t": _r(point.start), "reloj": format_clock(point.start)},
        "fin": {"t": _r(point.end), "reloj": format_clock(point.end)},
        "saca": SIDE_LABELS[point.server] if point.server else None,
        "golpes_detectados": len(point.shots),
        "golpes_no_detectados": point.missed_shots,
        "final": {
            "tipo": point.ending.kind,
            "gana": SIDE_LABELS[point.ending.winner] if point.ending.winner else None,
            "confianza": point.ending.confidence,
            "descripcion": point.ending.description,
        },
        "golpes": [_shot_dict(shot, model, with_rival=True) for shot in point.shots],
        "movimiento": [_movement_summary(model, side, point.start - 0.5, point.end) for side in SIDES],
    }


def _ending_of(shot: Shot, model: MatchModel) -> str:
    point = model.point(shot.point)
    if point is None or point.shots[-1] is not shot:
        return "no"
    kind = point.ending.kind
    return "error" if kind.startswith("error") else kind


def find_shots(model: MatchModel, data: FindShotsInput) -> dict:
    matches = []
    for shot in model.shots:
        if data.player and shot.player != data.player:
            continue
        if data.shot_type and shot.type != data.shot_type:
            continue
        if data.min_speed_kmh is not None and (shot.speed_kmh is None or shot.speed_kmh < data.min_speed_kmh):
            continue
        if data.max_speed_kmh is not None and (shot.speed_kmh is None or shot.speed_kmh > data.max_speed_kmh):
            continue
        if data.start_s is not None and shot.time < data.start_s:
            continue
        if data.end_s is not None and shot.time > data.end_s:
            continue
        if data.incoming_side and (shot.incoming is None or shot.incoming.lateral != data.incoming_side):
            continue
        if data.landing:
            if data.landing == "sin_bote":
                if shot.landing is not None:
                    continue
            elif data.landing == "fuera":
                if shot.landing is None or shot.landing.status != "fuera":
                    continue
            elif shot.landing is None or shot.landing.status == "fuera" or shot.landing.depth != data.landing:
                continue
        if data.ends_point and _ending_of(shot, model) != data.ends_point:
            continue
        matches.append(shot)

    speeds = [shot.speed_kmh for shot in matches if shot.speed_kmh is not None]
    by_type: dict[str, int] = {}
    for shot in matches:
        by_type[SHOT_LABELS[shot.type]] = by_type.get(SHOT_LABELS[shot.type], 0) + 1
    return {
        "total": len(matches),
        "mostrados": min(len(matches), data.limit),
        "resumen": {
            "por_tipo": by_type,
            "vel_media_kmh": _r(sum(speeds) / len(speeds), 0) if speeds else None,
            "vel_max_kmh": _r(max(speeds), 0) if speeds else None,
        },
        "golpes": [_shot_dict(shot, model) for shot in matches[: data.limit]],
    }


def _window(start: float, end: float, maximum: float) -> tuple[float, float]:
    if end <= start:
        raise ToolError("end_s debe ser mayor que start_s.")
    if end - start > maximum:
        raise ToolError(f"La ventana máxima es de {maximum:.0f} s; divide la consulta.")
    return start, end


def get_positions(model: MatchModel, data: GetPositionsInput) -> dict:
    start, end = _window(data.start_s, data.end_s, MAX_POSITION_WINDOW_SECONDS)
    step = max(data.step_s, (end - start) / MAX_POSITION_SAMPLES)
    sides = SIDES if data.player == "both" else (data.player,)
    result = {"ventana": [_r(start), _r(end)], "paso_s": _r(step, 3), "jugadores": []}
    for side in sides:
        samples = track_window(model, side, start, end, step)
        result["jugadores"].append({
            **_movement_summary(model, side, start, end),
            "muestras": [
                {
                    "t": _r(s.time),
                    "x": _r(s.x),
                    "y": _r(s.y),
                    "zona": court_zone(side, s.x),
                    "prof_m": _r(depth_from_baseline(side, s.x)),
                    "lateral_m": _r(lateral_offset(side, s.y)),
                }
                for s in samples
            ],
        })
    return result


def get_ball_track(model: MatchModel, data: GetBallTrackInput) -> dict:
    start, end = _window(data.start_s, data.end_s, MAX_BALL_WINDOW_SECONDS)
    step = max(data.step_s, (end - start) / MAX_BALL_SAMPLES)
    selected, next_time = [], start
    for sample in ball_samples(model, start, end):
        if sample["t"] >= next_time:
            selected.append(sample)
            next_time = sample["t"] + step
    return {"ventana": [_r(start), _r(end)], "muestras": selected, "nota": "z = altura en m (null si no hay vuelo 3D)."}


_EXECUTORS: dict[str, tuple[type[_Input], Callable[[MatchModel, _Input], dict]]] = {
    "get_point": (GetPointInput, get_point),
    "find_shots": (FindShotsInput, find_shots),
    "get_positions": (GetPositionsInput, get_positions),
    "get_ball_track": (GetBallTrackInput, get_ball_track),
}


def run_tool(model: MatchModel, name: str, raw_input: object) -> tuple[str, bool]:
    """Runs a tool and returns `(json_text, is_error)`; errors go back to the model as tool results."""
    entry = _EXECUTORS.get(name)
    if entry is None:
        return json.dumps({"error": f"Herramienta desconocida: {name}"}), True
    schema, executor = entry
    try:
        data = schema.model_validate(raw_input if isinstance(raw_input, dict) else {})
        return json.dumps(executor(model, data), ensure_ascii=False, separators=(",", ":")), False
    except ValidationError as error:
        problems = "; ".join(f"{'.'.join(map(str, e['loc'])) or 'input'}: {e['msg']}" for e in error.errors())
        return json.dumps({"error": f"Entrada no válida: {problems}"}, ensure_ascii=False), True
    except ToolError as error:
        return json.dumps({"error": str(error)}, ensure_ascii=False), True


def describe_tool_call(name: str, raw_input: object) -> str:
    """Short Spanish label for the UI while a tool runs."""
    data = raw_input if isinstance(raw_input, dict) else {}

    def clock(key: str) -> str:
        value = data.get(key)
        return format_clock(value) if isinstance(value, (int, float)) else "?"

    if name == "get_point":
        return f"Reconstruyendo el punto {data.get('point_number', '?')}"
    if name == "find_shots":
        filters = [
            SIDE_LABELS.get(data.get("player"), ""),
            SHOT_LABELS.get(data.get("shot_type"), ""),
            f"a su {data['incoming_side']}" if data.get("incoming_side") else "",
        ]
        detail = " ".join(part for part in filters if part)
        return f"Buscando golpes{(' · ' + detail) if detail else ''}"
    if name == "get_positions":
        return f"Siguiendo posiciones {clock('start_s')}–{clock('end_s')}"
    if name == "get_ball_track":
        return f"Trazando la pelota {clock('start_s')}–{clock('end_s')}"
    return "Consultando la telemetría"
