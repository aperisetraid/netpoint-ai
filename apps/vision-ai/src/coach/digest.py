"""Compact, line-oriented rendering of the tactical model for the coach's system prompt.

The digest is the *event layer* of the match: every point, every detected shot, where it
landed and how the point ended, plus per-player profiles and a per-minute timeline. It is
deterministic (same telemetry, same bytes), which keeps the prompt cache warm and the
conversation's thinking blocks valid from turn to turn.
"""

from __future__ import annotations

import hashlib
import math

from .analysis import (
    SHOT_LABELS,
    SIDE_LABELS,
    SIDES,
    Landing,
    MatchModel,
    Point,
    PlayerProfile,
    Shot,
    fastest_shot,
    format_clock,
    longest_point,
)

STROKE_ORDER = ("serve", "forehand", "backhand", "volley")


def _t(seconds: float) -> str:
    """Seconds and clock, the two forms the coach needs to cite a moment."""
    return f"{seconds:.2f}s ({format_clock(seconds)})"


def _speed(value: float | None) -> str:
    return f"{value:.0f} km/h" if value is not None else "vel. ?"


def _share(count: int, total: int) -> str:
    return f"{count} ({count / total:.0%})" if total else str(count)


def _landing(landing: Landing | None) -> str:
    if landing is None:
        return "bote no registrado"
    if landing.status == "fuera":
        return f"FUERA {landing.out_kind} ({landing.x:.1f},{landing.y:.1f})"
    status = "dudosa" if landing.status == "dudosa" else "dentro"
    return f"{landing.depth}·{landing.lateral} del rival·{status} ({landing.x:.1f},{landing.y:.1f})"


def _shot_line(shot: Shot) -> str:
    parts = [
        f"  {shot.number:>2}. {_t(shot.time)} {SIDE_LABELS[shot.player]} {SHOT_LABELS[shot.type]} {_speed(shot.speed_kmh)}",
        f"desde {shot.zone}·{shot.lateral}" + (f" ({shot.x:.1f},{shot.y:.1f})" if math.isfinite(shot.x) else ""),
    ]
    if shot.incoming is not None:
        parts.append(f"le llega {shot.incoming.depth}·a su {shot.incoming.lateral}")
    parts.append(f"→ {_landing(shot.landing)}")
    if shot.tempo is not None:
        parts.append(f"tempo {shot.tempo:.1f}s")
    if shot.after_missed_reply:
        parts.append("[falta un golpe del rival antes]")
    if shot.confidence < 0.6:
        parts.append("[solo 2D]")
    return " | ".join(parts)


def _point_block(point: Point) -> list[str]:
    server = f"saca {SIDE_LABELS[point.server]}" if point.server else "sin saque detectado"
    missed = f" (+{point.missed_shots} no detectados)" if point.missed_shots else ""
    winner = SIDE_LABELS[point.ending.winner] if point.ending.winner else "?"
    lines = [
        f"P{point.number} · {_t(point.start)} → {_t(point.end)} · {len(point.shots)} golpes{missed} · {server}",
        f"  final [{point.ending.kind}, confianza {point.ending.confidence}, gana {winner}]: {point.ending.description}",
    ]
    lines.extend(_shot_line(shot) for shot in point.shots)
    return lines


def _distribution(counts: dict[str, int], order: tuple[str, ...]) -> str:
    total = sum(counts.get(key, 0) for key in order)
    return ", ".join(f"{key} {_share(counts.get(key, 0), total)}" for key in order) if total else "sin datos"


def _profile_block(profile: PlayerProfile) -> list[str]:
    label = SIDE_LABELS[profile.side]
    total = sum(stats.count for stats in profile.strokes.values())
    lines = [f"## {label} ({'lado lejano' if profile.side == 'far' else 'lado de la cámara'})"]
    lines.append(
        f"- Golpes detectados: {total} · puntos ganados/perdidos inferidos: {profile.points_won}/{profile.points_lost}"
        f" · detectado en el {profile.coverage:.0%} de los fotogramas"
    )
    for stroke in STROKE_ORDER:
        stats = profile.strokes.get(stroke)
        if not stats or not stats.count:
            continue
        average = _speed(stats.average_speed) if stats.average_speed is not None else "vel. ?"
        lines.append(
            f"- {SHOT_LABELS[stroke]}: {stats.count} · media {average} · máx {_speed(stats.max_speed)}"
            f" · finalizan el punto como error {stats.errors} / ganador {stats.winners}"
        )
    lines.append(f"- Profundidad de sus bolas buenas: {_distribution(profile.landing_depth, ('corta', 'media', 'profunda'))}")
    lines.append(
        f"- Dirección (lado del rival): {_distribution(profile.landing_lateral, ('derecha', 'centro', 'izquierda'))}"
    )
    status = dict(profile.landing_status)
    if status:
        lines.append("- Botes de sus golpes: " + ", ".join(f"{key} {value}" for key, value in sorted(status.items())))
    if profile.zone_share:
        zones = ", ".join(f"{zone} {share:.0%}" for zone, share in sorted(profile.zone_share.items(), key=lambda i: -i[1]))
        lines.append(f"- Posición durante los puntos: {zones}")
    if profile.average_depth is not None:
        where = "dentro de" if profile.average_depth >= 0 else "detrás de"
        lines.append(f"- Profundidad media: {abs(profile.average_depth):.1f} m {where} su línea de fondo")
    lines.append(f"- Zona al golpear: {_distribution(profile.zone_at_shot, ('muy atrás', 'fondo', 'media pista', 'red'))}")
    lines.append(f"- Distancia recorrida durante los puntos: {profile.distance_m:.0f} m")
    if profile.recovery_offset_m is not None:
        lines.append(f"- Recuperación: 1 s después de golpear está a {profile.recovery_offset_m:.1f} m del centro (media)")
    if profile.under_left_pressure:
        replies = ", ".join(
            f"{SHOT_LABELS.get(key, key)} {value}" for key, value in sorted(profile.under_left_pressure.items())
        )
        outcomes = ", ".join(f"{key} {value}" for key, value in sorted(profile.left_pressure_outcomes.items()))
        lines.append(f"- Bolas que le llegan a su izquierda (revés si es diestro): responde con {replies}; resultado: {outcomes}")
    return lines


def _timeline_block(model: MatchModel) -> list[str]:
    lines = []
    for bucket in model.timeline:
        if not any(bucket.shots.values()) and not any(bucket.errors.values()):
            continue
        cells = []
        for side in SIDES:
            errors = bucket.errors.get(side) or {}
            error_text = ", ".join(f"{SHOT_LABELS[k]} {v}" for k, v in sorted(errors.items())) or "0"
            cells.append(
                f"{SIDE_LABELS[side]}: {bucket.shots[side]} golpes, errores [{error_text}], ganadores {bucket.winners[side]}"
            )
        lines.append(f"- Min {bucket.minute} ({bucket.minute}:00–{bucket.minute}:59) · " + " · ".join(cells))
    return lines or ["- Sin actividad registrada."]


def _records_block(model: MatchModel) -> list[str]:
    lines = []
    longest = longest_point(model)
    if longest is not None:
        lines.append(
            f"- Punto más largo: P{longest.number}, {longest.rally_length} golpes estimados"
            f" ({len(longest.shots)} detectados), {longest.duration:.1f} s, desde {_t(longest.start)}"
        )
    by_duration = max(model.points, key=lambda p: p.duration, default=None)
    if by_duration is not None and by_duration is not longest:
        lines.append(f"- Punto de mayor duración: P{by_duration.number}, {by_duration.duration:.1f} s")
    for label, types in (("Golpe más rápido", None), ("Saque más rápido", ("serve",))):
        shot = fastest_shot(model, types)
        if shot is not None:
            lines.append(
                f"- {label}: {_speed(shot.speed_kmh)}, {SHOT_LABELS[shot.type]} de {SIDE_LABELS[shot.player]}"
                f" en {_t(shot.time)} (P{shot.point})"
            )
    return lines or ["- Sin récords: no hay golpes detectados."]


def render_digest(model: MatchModel) -> str:
    total_missed = sum(point.missed_shots for point in model.points)
    endings = {}
    for point in model.points:
        endings[point.ending.kind] = endings.get(point.ending.kind, 0) + 1
    lines = [
        "# TELEMETRÍA DEL PARTIDO",
        f"- Duración del vídeo: {_t(model.duration)} · {model.frame_count} fotogramas"
        + (f" a {model.fps:.1f} fps" if model.fps else ""),
        f"- Pista calibrada: {'sí' if model.calibrated else 'NO (posiciones en metros poco fiables)'}"
        f" · pelota detectada en el {model.ball_coverage:.0%} de los fotogramas",
        f"- {len(model.points)} puntos · {len(model.shots)} golpes detectados"
        f" (+{total_missed} probables no detectados) · finales: "
        + (", ".join(f"{kind} {count}" for kind, count in sorted(endings.items())) or "ninguno"),
        "",
        "## Convenciones",
        "- Jugadores: «Fondo» juega en el lado lejano a la cámara; «Cámara» en el lado cercano.",
        "- Coordenadas en metros: x a lo largo de la pista (0 = fondo lejano, 11.89 = red, 23.77 = fondo cercano);"
        " y a lo ancho (0–10.97, individuales entre 1.37 y 9.60).",
        "- derecha/centro/izquierda siempre desde el punto de vista del jugador que recibe o golpea, mirando a la red.",
        "- Profundidad del bote: corta = dentro del cuadro de saque; profunda = últimos 3 m antes de la línea de fondo.",
        "- Zonas del jugador: red (≤4.5 m de la red), media pista, fondo (±1.5 m de la línea), muy atrás (>1.5 m detrás).",
        "- La clasificación derecha/revés asume jugadores diestros.",
        "- Velocidad: ajuste 3D cuando es posible; si no, proyección sobre la pista (puede sobrestimar bolas altas).",
        "- [solo 2D]: golpe estimado solo desde la imagen, sin reconstrucción 3D del vuelo (posición y velocidad menos fiables).",
        "- [falta un golpe del rival antes]: dos golpes seguidos del mismo jugador; el tracker perdió la devolución intermedia.",
        "- 'final' de cada punto es una INFERENCIA a partir del último golpe y el siguiente bote.",
        "",
        "# RÉCORDS",
        *_records_block(model),
        "",
        "# PERFILES",
    ]
    for side in SIDES:
        lines.extend(_profile_block(model.profiles[side]))
        lines.append("")
    lines.extend(["# LÍNEA TEMPORAL POR MINUTO", *_timeline_block(model), "", "# PUNTOS (golpe a golpe)"])
    for point in model.points:
        lines.extend(_point_block(point))
    if not model.points:
        lines.append("- No se detectaron puntos.")
    return "\n".join(lines)


def fingerprint(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]
