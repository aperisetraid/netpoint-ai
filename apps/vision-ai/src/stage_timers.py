"""Optional per-stage timers for the vision pipeline; free when disabled.

Enable with NETPOINT_PROFILE=1 (or `profiling.enable()` from a script) and read the table with
`profiling.report()`. The context manager is a shared no-op object while disabled.
"""

import os
import time
from contextlib import contextmanager, nullcontext

_enabled = os.environ.get("NETPOINT_PROFILE") == "1"
_idle = nullcontext()
_seconds: dict[str, float] = {}
_calls: dict[str, int] = {}


def enable() -> None:
    global _enabled
    _enabled = True


def reset() -> None:
    _seconds.clear()
    _calls.clear()


@contextmanager
def _timed(name: str):
    start = time.perf_counter()
    try:
        yield
    finally:
        _seconds[name] = _seconds.get(name, 0.0) + time.perf_counter() - start
        _calls[name] = _calls.get(name, 0) + 1


def stage(name: str):
    return _timed(name) if _enabled else _idle


def report() -> dict[str, dict[str, float]]:
    """{stage: {seconds, calls, ms_per_call}} in the order the stages first ran."""
    return {
        name: {
            "seconds": round(seconds, 3),
            "calls": _calls[name],
            "ms_per_call": round(seconds / _calls[name] * 1000, 2),
        }
        for name, seconds in _seconds.items()
    }
