import asyncio
import json
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from coach import agent, api
from coach.analysis import build_match_model, classify_landing, lateral_zone
from coach.digest import fingerprint, render_digest
from coach.prompts import build_context_block, build_system
from coach.session import SESSION_FILE, load_session
from coach.tools import TOOL_DEFINITIONS, describe_tool_call, run_tool


def detection(x, y, kind="player", confidence=0.9):
    return {"class": kind, "confidence": confidence, "bbox": [0, 0, 1, 1], "x_meters": x, "y_meters": y}


def hit(time, player, shot_type, point, speed=100.0, x=None, y=5.5):
    x = x if x is not None else (-0.5 if player == "far" else 24.3)
    return {
        "timestamp_seconds": time, "frame_index": int(time * 25), "player": player, "type": shot_type,
        "speed_kmh": speed, "point_index": point, "ball": {"x": x, "y": y, "z": None},
        "player_position": {"x": x, "y": y}, "confidence": 0.75,
    }


def bounce(time, x, y, method="fit3d"):
    return {
        "timestamp_seconds": time, "frame_index": int(time * 25), "x_meters": x, "y_meters": y,
        "side": "far" if x < 11.885 else "near", "confidence": 0.75, "method": method,
    }


def sample_telemetry():
    """Two points: a 3-shot rally won by Fondo, and a rally whose return is missed by the tracker."""
    frames = []
    for index in range(25 * 20):
        time = index / 25
        frames.append({
            "frame_index": index,
            "timestamp_seconds": time,
            "detections": [detection(-0.5, 5.0 + (index % 50) / 100), detection(24.5, 6.0), detection(15.0, 5.0, "ball", 0.8)],
        })
    hits = [
        hit(1.0, "far", "serve", 0, 150.0, x=-0.2, y=3.0),
        hit(2.2, "near", "backhand", 0, 90.0, y=3.5),
        hit(3.4, "far", "forehand", 0, 120.0),
        hit(10.0, "near", "serve", 1, 170.0, x=24.0, y=7.0),
        hit(12.4, "near", "backhand", 1, 80.0, y=4.0),
    ]
    bounces = [
        bounce(1.6, 17.0, 3.0),   # serve lands in the near service box
        bounce(2.9, 3.0, 5.0),    # near backhand lands deep on the far side
        bounce(4.0, 21.5, 2.0),   # far forehand lands in, never returned -> winner
        bounce(12.1, 22.0, 3.0),  # a far return the tracker missed bounces on the near side
    ]
    return {
        "version": 2,
        "video": {"fps": 25.0, "width": 1280, "height": 720, "frame_count": len(frames)},
        "court": {"length_meters": 23.77, "width_meters": 10.97, "calibrated": True},
        "frames": frames,
        "events": {"bounces": bounces, "hits": hits},
    }


class TacticalModelTests(unittest.TestCase):
    def setUp(self):
        self.model = build_match_model(sample_telemetry())

    def test_lateral_zones_follow_each_players_point_of_view(self):
        # Low y is the camera's left: the near player's left, but the far player's right.
        self.assertEqual(lateral_zone("near", 1.5), "izquierda")
        self.assertEqual(lateral_zone("far", 1.5), "derecha")
        self.assertEqual(lateral_zone("near", 5.5), "centro")

    def test_landing_classification(self):
        self.assertEqual(classify_landing(bounce(0, 17.0, 3.0), "far").depth, "corta")
        deep = classify_landing(bounce(0, 1.5, 5.0), "near")
        self.assertEqual((deep.depth, deep.status), ("profunda", "dentro"))
        long = classify_landing(bounce(0, -1.0, 5.0), "near")
        self.assertEqual((long.status, long.out_kind), ("fuera", "larga"))
        wide = classify_landing(bounce(0, 5.0, 0.5), "near")
        self.assertEqual((wide.status, wide.out_kind), ("fuera", "ancha"))
        self.assertEqual(classify_landing(bounce(0, 23.6, 5.0), "far").status, "dudosa")

    def test_points_landings_and_endings(self):
        first, second = self.model.points
        self.assertEqual(first.server, "far")
        self.assertEqual([shot.landing.depth for shot in first.shots], ["corta", "profunda", "profunda"])
        self.assertEqual(first.ending.kind, "ganador")
        self.assertEqual(first.ending.winner, "far")
        self.assertTrue(first.ending.description.startswith("Derecha de Fondo"))
        self.assertEqual(self.model.profiles["far"].points_won, 1)
        self.assertEqual(self.model.profiles["near"].strokes["backhand"].count, 2)

    def test_missed_reply_is_not_mistaken_for_a_tactical_event(self):
        second = self.model.points[1]
        serve, backhand = second.shots
        self.assertIsNone(serve.landing, "a bounce back on the server's half is not the serve's landing")
        self.assertTrue(backhand.after_missed_reply)
        self.assertEqual(second.missed_shots, 1)
        self.assertEqual(second.rally_length, 3)
        self.assertEqual(backhand.incoming.side, "near")
        self.assertNotEqual(second.ending.kind, "error_red")

    def test_point_at_and_position_lookup(self):
        self.assertEqual(self.model.point_at(11.0).number, 2)
        self.assertEqual(self.model.point_at(0.5).number, 1, "a point is current from 1 s before its first shot")
        self.assertIsNotNone(self.model.position_at("near", 5.0))

    def test_rejects_legacy_telemetry(self):
        with self.assertRaises(ValueError):
            build_match_model([{"frame_index": 0}])


class DigestAndToolTests(unittest.TestCase):
    def setUp(self):
        self.model = build_match_model(sample_telemetry())

    def test_digest_is_deterministic_and_cites_seconds(self):
        digest = render_digest(self.model)
        self.assertEqual(digest, render_digest(build_match_model(sample_telemetry())))
        self.assertEqual(fingerprint(digest), fingerprint(render_digest(self.model)))
        self.assertIn("P1 · 1.00s (0:01)", digest)
        self.assertIn("[falta un golpe del rival antes]", digest)
        system = build_system(digest)
        self.assertEqual(system[-1]["cache_control"], {"type": "ephemeral"})

    def test_context_block_names_the_user_and_the_current_point(self):
        block = build_context_block(self.model, {"far": "Ana", "near": "Bea"}, "near", 11.0)
        self.assertIn("El usuario es: Bea («Cámara»)", block)
        self.assertIn("dentro del punto P2", block)

    def test_tools_validate_and_answer(self):
        output, failed = run_tool(self.model, "get_point", {"point_number": 1})
        self.assertFalse(failed)
        point = json.loads(output)
        self.assertEqual(point["final"]["gana"], "Fondo")
        self.assertIn("rival", point["golpes"][0])

        output, failed = run_tool(self.model, "find_shots", {"player": "near", "shot_type": "backhand"})
        self.assertEqual(json.loads(output)["total"], 2)
        output, _ = run_tool(self.model, "find_shots", {"ends_point": "ganador"})
        self.assertEqual(json.loads(output)["golpes"][0]["tipo"], "derecha")

        output, failed = run_tool(self.model, "get_positions", {"start_s": 1, "end_s": 4, "player": "far"})
        self.assertFalse(failed)
        self.assertGreater(len(json.loads(output)["jugadores"][0]["muestras"]), 3)
        output, failed = run_tool(self.model, "get_ball_track", {"start_s": 1, "end_s": 2})
        self.assertFalse(failed)

    def test_tool_errors_are_returned_to_the_model(self):
        for name, payload in (
            ("get_point", {"point_number": 99}),
            ("get_point", {"point_number": "uno", "extra": 1}),
            ("get_positions", {"start_s": 5, "end_s": 2}),
            ("get_ball_track", {"start_s": 0, "end_s": 60}),
            ("unknown", {}),
        ):
            output, failed = run_tool(self.model, name, payload)
            self.assertTrue(failed, name)
            self.assertIn("error", json.loads(output))

    def test_tool_definitions_stream_inputs_and_have_labels(self):
        self.assertTrue(all(tool["eager_input_streaming"] for tool in TOOL_DEFINITIONS))
        self.assertEqual(describe_tool_call("get_point", {"point_number": 3}), "Reconstruyendo el punto 3")


class FakeBlock(SimpleNamespace):
    def to_dict(self, mode="json", exclude_none=True):
        return dict(vars(self))


class FakeStream:
    def __init__(self, events, message):
        self.events, self.message = events, message

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    def __aiter__(self):
        async def iterate():
            for event in self.events:
                yield event
        return iterate()

    async def get_final_message(self):
        return self.message


class FakeClient:
    """Plays scripted rounds and records every request it receives."""

    def __init__(self, rounds):
        self.rounds = list(rounds)
        self.requests = []
        self.beta = SimpleNamespace(messages=SimpleNamespace(stream=self.stream))

    def stream(self, **kwargs):
        self.requests.append(json.loads(json.dumps(kwargs)))
        events, content, stop = self.rounds.pop(0)
        usage = SimpleNamespace(input_tokens=10, cache_read_input_tokens=0, output_tokens=5)
        return FakeStream(events, SimpleNamespace(content=content, stop_reason=stop, usage=usage, model="claude-opus-5-5"))


def text_round(text):
    return ([SimpleNamespace(type="text", text=text)], [FakeBlock(type="text", text=text)], "end_turn")


class AgentLoopTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.folder = Path(self.directory.name)
        self.model = build_match_model(sample_telemetry())
        self.digest = render_digest(self.model)
        self.request = agent.TurnRequest("¿Cómo terminó el punto 1?", {"far": "Ana", "near": "Bea"}, "far", 2.0)

    def run_turn(self, client, session):
        async def collect():
            with patch.object(agent, "get_client", return_value=client):
                return [event async for event in agent.run_turn(
                    self.model, build_system(self.digest), session, self.folder, self.request,
                )]
        return asyncio.run(collect())

    def test_tool_round_trip_is_streamed_and_committed(self):
        tool_call = FakeBlock(type="tool_use", id="toolu_1", name="get_point", input={"point_number": 1})
        thinking = FakeBlock(type="thinking", thinking="Reviso el punto 1", signature="sig")
        client = FakeClient([
            ([SimpleNamespace(type="thinking", thinking="Reviso el punto 1"), SimpleNamespace(type="content_block_stop")],
             [thinking, tool_call], "tool_use"),
            text_round("Lo ganó Ana con una derecha [0:03](#t=3.40)."),
        ])
        session = load_session(self.folder, fingerprint(self.digest))
        events = self.run_turn(client, session)

        types = [event["type"] for event in events]
        self.assertEqual(types[-1], "done")
        self.assertIn({"type": "status", "label": "Reconstruyendo el punto 1"}, events)
        self.assertIn({"type": "status", "label": "Reviso el punto 1"}, events)
        self.assertEqual(events[-1]["message"]["tools"], ["Reconstruyendo el punto 1"])

        second = client.requests[1]
        self.assertEqual(second["thinking"]["type"], "adaptive")
        self.assertEqual(second["fallbacks"], "default")
        self.assertIn("server-side-fallback-2026-07-01", second["betas"])
        user, assistant, results = second["messages"]
        self.assertIn("<contexto>", user["content"][0]["text"])
        self.assertEqual(assistant["content"][0]["signature"], "sig", "thinking blocks are replayed verbatim")
        self.assertEqual(results["content"][0]["tool_use_id"], "toolu_1")
        self.assertEqual(json.loads(results["content"][0]["content"])["punto"], 1)
        # The prefix never changes between requests of a conversation.
        self.assertEqual(client.requests[0]["system"], second["system"])
        self.assertEqual(client.requests[0]["tools"], second["tools"])

        stored = load_session(self.folder, fingerprint(self.digest))
        self.assertEqual(len(stored.messages), 4)
        self.assertEqual([entry.role for entry in stored.transcript], ["user", "assistant"])
        self.assertIn("#t=3.40", stored.transcript[1].text)

        # The next turn replays the stored history untouched before the new question.
        follow_up = FakeClient([text_round("Sí.")])
        self.run_turn(follow_up, stored)
        self.assertEqual(follow_up.requests[0]["messages"][:4], stored.messages[:4])

    def test_failed_turns_commit_nothing(self):
        session = load_session(self.folder, fingerprint(self.digest))
        refusal = ([], [], "refusal")
        events = self.run_turn(FakeClient([refusal]), session)
        self.assertEqual(events[-1]["type"], "error")
        self.assertFalse((self.folder / SESSION_FILE).exists())
        self.assertEqual(session.messages, [])

    def test_missing_credentials_and_crashes_still_end_the_stream_with_an_error(self):
        session = load_session(self.folder, fingerprint(self.digest))

        async def collect():
            return [event async for event in agent.run_turn(
                self.model, build_system(self.digest), session, self.folder, self.request,
            )]

        with patch.object(agent, "_client", None), patch.object(agent, "credentials_configured", return_value=False):
            events = asyncio.run(collect())
        self.assertEqual(events, [{"type": "error", "message": agent.MISSING_CREDENTIALS}])

        broken = FakeClient([])  # popping from an empty script raises IndexError
        with patch.object(agent, "get_client", return_value=broken), self.assertLogs("coach.agent", "ERROR"):
            events = asyncio.run(collect())
        self.assertEqual(events[-1]["type"], "error")
        self.assertEqual(session.messages, [])

    def test_fallback_boundary_drops_the_declined_models_internal_blocks(self):
        content = [
            {"type": "thinking", "thinking": "", "signature": "a"},
            {"type": "text", "text": "Parcial"},
            {"type": "fallback", "from": {"model": "x"}, "to": {"model": "y"}},
            {"type": "thinking", "thinking": "", "signature": "b"},
            {"type": "text", "text": " y final"},
        ]
        self.assertEqual(
            [block["type"] for block in agent.sanitize_fallback(content)],
            ["text", "fallback", "thinking", "text"],
        )

    def test_a_stale_session_starts_over(self):
        session = load_session(self.folder, fingerprint(self.digest))
        self.run_turn(FakeClient([text_round("Hola")]), session)
        self.assertEqual(len(load_session(self.folder, fingerprint(self.digest)).transcript), 2)
        self.assertEqual(load_session(self.folder, "otro-digest").transcript, [])


class CoachApiTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.folder = Path(self.directory.name) / "match"
        self.folder.mkdir()
        (self.folder / api.TELEMETRY_FILE).write_text(json.dumps(sample_telemetry()), encoding="utf-8")
        app = FastAPI()
        app.include_router(api.create_coach_router(lambda match_id: self.folder if match_id == "m1" else None))
        self.client = TestClient(app)

    def test_session_streaming_and_reset(self):
        response = self.client.get("/coach/m1")
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["messages"], [])
        self.assertFalse(payload["accessRequired"])
        self.assertEqual(payload["highlights"][0]["label"], "Punto más largo")
        self.assertTrue(payload["suggestions"])

        with patch.object(agent, "get_client", return_value=FakeClient([text_round("Respuesta")])):
            streamed = self.client.post("/coach/m1/messages", json={"message": "Hola", "perspective": "near", "currentTime": 3})
        self.assertEqual(streamed.headers["content-type"].split(";")[0], "text/event-stream")
        events = [json.loads(line[6:]) for line in streamed.text.splitlines() if line.startswith("data: ")]
        self.assertEqual([event["type"] for event in events], ["text", "done"])
        self.assertEqual(len(self.client.get("/coach/m1").json()["messages"]), 2)

        self.assertEqual(self.client.delete("/coach/m1").status_code, 204)
        self.assertEqual(self.client.get("/coach/m1").json()["messages"], [])

    def test_access_code_and_daily_limit_protect_a_public_coach(self):
        settings = {api.ACCESS_CODE_ENV: "saque-223", api.DAILY_LIMIT_ENV: "1"}
        with patch.dict(os.environ, settings), patch.object(api, "daily_limit", api.DailyLimit()):
            self.assertTrue(self.client.get("/coach/m1").json()["accessRequired"])
            for headers in ({}, {"X-Access-Code": "otro"}):
                denied = self.client.post("/coach/m1/messages", json={"message": "Hola"}, headers=headers)
                self.assertEqual(denied.status_code, 401)
                self.assertEqual(denied.json()["detail"], api.WRONG_CODE_MESSAGE)
            self.assertEqual(self.client.delete("/coach/m1").status_code, 401)

            granted = {"X-Access-Code": "saque-223"}
            with patch.object(agent, "get_client", return_value=FakeClient([text_round("Respuesta")])):
                streamed = self.client.post("/coach/m1/messages", json={"message": "Hola"}, headers=granted)
            self.assertEqual(streamed.status_code, 200)
            capped = self.client.post("/coach/m1/messages", json={"message": "Otra"}, headers=granted)
            self.assertEqual(capped.status_code, 429)
            self.assertEqual(self.client.delete("/coach/m1", headers=granted).status_code, 204)

    def test_unknown_match_and_invalid_payloads(self):
        self.assertEqual(self.client.get("/coach/otro").status_code, 404)
        self.assertEqual(self.client.post("/coach/m1/messages", json={"message": ""}).status_code, 422)
        self.assertEqual(
            self.client.post("/coach/m1/messages", json={"message": "x", "perspective": "umpire"}).status_code, 422
        )


if __name__ == "__main__":
    unittest.main()
