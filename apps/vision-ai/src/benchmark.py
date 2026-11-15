"""Speed and regression harness for the vision pipeline.

  python src/benchmark.py run VIDEO OUT.json      # analyse VIDEO, print per-stage timings, save telemetry
  python src/benchmark.py compare GOLD.json NEW.json   # quality of NEW measured against GOLD

`compare` exits with status 1 when NEW is outside the tolerances, so it can gate each optimisation.
"""

import argparse
import json
import statistics
import sys
import time
from pathlib import Path

import stage_timers as profiling

BOUNCE_FRAME_TOLERANCE = 1
HIT_FRAME_TOLERANCE = 2
MIN_BALL_FRAME_RATIO = 0.95
MAX_BALL_MEDIAN_ERROR_PX = 3.0
MAX_PLAYER_MEDIAN_ERROR_METERS = 0.3
COURT_HALF_LENGTH_METERS = 11.885


def _center(bbox):
    return ((bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2)


def _ball(frame):
    balls = [d for d in frame["detections"] if d["class"] == "ball"]
    return max(balls, key=lambda d: d["confidence"]) if balls else None


def _players_by_side(frame):
    sides = {}
    for detection in frame["detections"]:
        if detection["class"] == "player" and detection["x_meters"] is not None:
            side = "far" if detection["x_meters"] < COURT_HALF_LENGTH_METERS else "near"
            sides[side] = detection
    return sides


def _match_events(gold, new, tolerance, key=lambda event: ()):
    """Greedy one-to-one matching by frame distance; returns the number of matched gold events."""
    remaining = list(new)
    matched = 0
    for event in gold:
        candidates = [
            other for other in remaining
            if abs(other["frame_index"] - event["frame_index"]) <= tolerance and key(other) == key(event)
        ]
        if candidates:
            remaining.remove(min(candidates, key=lambda other: abs(other["frame_index"] - event["frame_index"])))
            matched += 1
    return matched


def compare(gold: dict, new: dict) -> dict:
    """Quality of `new` against `gold`; every metric is a plain number so it can be asserted on."""
    gold_bounces, new_bounces = gold["events"]["bounces"], new["events"]["bounces"]
    gold_hits, new_hits = gold["events"]["hits"], new["events"]["hits"]
    pairs = list(zip(gold["frames"], new["frames"]))

    ball_errors, player_errors = [], []
    gold_with_ball = new_with_ball = both = 0
    for gold_frame, new_frame in pairs:
        gold_ball, new_ball = _ball(gold_frame), _ball(new_frame)
        gold_with_ball += gold_ball is not None
        new_with_ball += new_ball is not None
        if gold_ball and new_ball:
            both += 1
            (gx, gy), (nx, ny) = _center(gold_ball["bbox"]), _center(new_ball["bbox"])
            ball_errors.append(((gx - nx) ** 2 + (gy - ny) ** 2) ** 0.5)
        new_players = _players_by_side(new_frame)
        for side, player in _players_by_side(gold_frame).items():
            other = new_players.get(side)
            if other:
                player_errors.append(
                    ((player["x_meters"] - other["x_meters"]) ** 2 + (player["y_meters"] - other["y_meters"]) ** 2) ** 0.5
                )

    return {
        "frames_equal": len(gold["frames"]) == len(new["frames"]),
        "identical": gold == new,
        "bounces_gold": len(gold_bounces),
        "bounces_new": len(new_bounces),
        "bounces_matched": _match_events(gold_bounces, new_bounces, BOUNCE_FRAME_TOLERANCE),
        "hits_gold": len(gold_hits),
        "hits_new": len(new_hits),
        "hits_matched": _match_events(
            gold_hits, new_hits, HIT_FRAME_TOLERANCE, key=lambda hit: (hit["player"], hit["type"])
        ),
        "ball_frame_ratio": new_with_ball / gold_with_ball if gold_with_ball else 1.0,
        "ball_median_error_px": statistics.median(ball_errors) if ball_errors else 0.0,
        "player_median_error_m": statistics.median(player_errors) if player_errors else 0.0,
        "ball_frames_compared": both,
    }


def verdict(metrics: dict) -> list[str]:
    """Reasons `metrics` fall outside the tolerances; empty when the optimisation is acceptable."""
    if metrics["identical"]:
        return []
    problems = []
    if not metrics["frames_equal"]:
        problems.append("distinto número de frames")
    if metrics["bounces_matched"] < metrics["bounces_gold"] or metrics["bounces_new"] > metrics["bounces_gold"]:
        problems.append(f"botes {metrics['bounces_matched']}/{metrics['bounces_gold']} (nuevos {metrics['bounces_new']})")
    if metrics["hits_matched"] < metrics["hits_gold"] or metrics["hits_new"] > metrics["hits_gold"]:
        problems.append(f"golpes {metrics['hits_matched']}/{metrics['hits_gold']} (nuevos {metrics['hits_new']})")
    if metrics["ball_frame_ratio"] < MIN_BALL_FRAME_RATIO:
        problems.append(f"frames con pelota {metrics['ball_frame_ratio']:.0%} del oro")
    if metrics["ball_median_error_px"] > MAX_BALL_MEDIAN_ERROR_PX:
        problems.append(f"error de pelota {metrics['ball_median_error_px']:.1f}px")
    if metrics["player_median_error_m"] > MAX_PLAYER_MEDIAN_ERROR_METERS:
        problems.append(f"error de jugadores {metrics['player_median_error_m']:.2f}m")
    return problems


def run(video: Path, output: Path) -> dict:
    profiling.enable()
    profiling.reset()
    from tracker import TennisTracker  # imported late: ultralytics is slow to load

    tracker = TennisTracker(model_size="yolov8n.pt")
    start = time.perf_counter()
    telemetry = tracker.process_video(str(video))
    total = time.perf_counter() - start
    output.write_text(json.dumps(telemetry), encoding="utf-8")

    frames = len(telemetry["frames"])
    report = profiling.report()
    print(f"\n{'etapa':<14}{'s':>9}{'ms/llamada':>13}{'% total':>9}")
    for name, row in report.items():
        print(f"{name:<14}{row['seconds']:>9.1f}{row['ms_per_call']:>13.1f}{row['seconds'] / total:>9.0%}")
    print(f"{'TOTAL':<14}{total:>9.1f}   {total / frames * 1000:.0f} ms/frame = {frames / total:.1f} FPS ({frames} frames)")
    return {"total_seconds": round(total, 2), "frames": frames, "stages": report}


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    commands = parser.add_subparsers(dest="command", required=True)
    run_parser = commands.add_parser("run")
    run_parser.add_argument("video", type=Path)
    run_parser.add_argument("output", type=Path)
    compare_parser = commands.add_parser("compare")
    compare_parser.add_argument("gold", type=Path)
    compare_parser.add_argument("new", type=Path)
    arguments = parser.parse_args(argv)

    if arguments.command == "run":
        summary = run(arguments.video, arguments.output)
        arguments.output.with_suffix(".timing.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
        return 0

    metrics = compare(
        json.loads(arguments.gold.read_text(encoding="utf-8")),
        json.loads(arguments.new.read_text(encoding="utf-8")),
    )
    print(json.dumps(metrics, indent=2))
    problems = verdict(metrics)
    print("IDÉNTICO" if metrics["identical"] else "OK" if not problems else "FUERA DE TOLERANCIA: " + "; ".join(problems))
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
