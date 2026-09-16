"""`client.workflows.cancel(id)`, against an injected fake transport.

Mirrors `test_workflows_run.py`'s shape and reuses its house style, because
this route is most often got wrong in exactly three plausible ways:

1. **The path root** — every other method on this class is `/workflows/…`-
   rooted; this one alone hits `/runs/…`, because it is addressed by the RUN
   id, not the workflow id.
2. **The envelope key** — `"run"`, not `"workflow"` (the key every sibling
   write method on this class unwraps).
3. **`202` does not mean stopped** — the returned `status` is the run's status
   as it is right now, never `"canceled"`.

No case here opens a socket (`docs/implementation.md` §9): T1.1.3 is building
the server route this wraps in parallel, and this suite asserts against the
pinned wire contract alone.
"""

from __future__ import annotations

import email.message
import io
import json
import unittest
from typing import Any, Callable, List, Tuple
from urllib.error import HTTPError
from urllib.request import Request

from w6w import ApiError, Client

#: The URL a cancel of `run_01HQ` must POST to, with no query string.
CANCEL_URL = "https://api.example.com/runs/run_01HQ/cancel"


class FakeResponse:
    """The minimum a transport must return: a status, a reason and a body."""

    def __init__(self, status: int, body: str = "", reason: str = "") -> None:
        self.status = status
        self.reason = reason
        self._body = body.encode("utf-8")

    def read(self) -> bytes:
        """Read the body once, as `urllib` would."""
        return self._body


class Recorder:
    """A transport-shaped fake that records every request it is handed."""

    def __init__(self, respond: Callable[[Request], Any]) -> None:
        self.calls: List[Request] = []
        self._respond = respond

    def __call__(self, request: Request) -> Any:
        """Record the request, then produce (or raise) the case's outcome."""
        self.calls.append(request)
        return self._respond(request)


def http_error(status: int, body: Any, reason: str = "") -> HTTPError:
    """Build the exception `urlopen` raises for a non-2xx status."""
    return HTTPError(
        CANCEL_URL,
        status,
        reason,
        email.message.Message(),
        io.BytesIO(json.dumps(body).encode("utf-8")),
    )


def client(respond: Callable[[Request], Any]) -> Tuple[Client, List[Request]]:
    """A client wired to a fake transport."""
    transport = Recorder(respond)
    return (
        Client(base_url="https://api.example.com", token="tok_1", transport=transport),
        transport.calls,
    )


def responding(body: Any, status: int = 202) -> Callable[[Request], Any]:
    """Answer every request with one JSON body."""
    text = json.dumps(body)
    return lambda _request: FakeResponse(status, text)


def raising(error: BaseException) -> Callable[[Request], Any]:
    """Raise, the way `urlopen` does for a non-2xx status."""

    def _raise(_request: Request) -> Any:
        raise error

    return _raise


class PathTest(unittest.TestCase):
    """The plausible near-miss: every sibling method is `/workflows/…`-rooted."""

    def test_posts_to_runs_id_cancel_not_workflows(self) -> None:
        instance, calls = client(
            responding(
                {"run": {"id": "run_01HQ", "status": "running", "cancelRequestedAt": "x"}},
            ),
        )

        instance.workflows.cancel("run_01HQ")

        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0].get_method(), "POST")
        self.assertEqual(calls[0].full_url, CANCEL_URL)
        self.assertIsNone(calls[0].data, "no request body")

    def test_the_run_id_is_percent_encoded_into_the_path(self) -> None:
        instance, calls = client(
            responding({"run": {"id": "run_1", "status": "queued", "cancelRequestedAt": "x"}}),
        )

        instance.workflows.cancel("run a/b?x")

        self.assertEqual(
            calls[0].full_url,
            "https://api.example.com/runs/run%20a%2Fb%3Fx/cancel",
        )


class EnvelopeTest(unittest.TestCase):
    """The `run` envelope, unwrapped — never the `workflow` one."""

    def test_unwraps_the_run_envelope(self) -> None:
        run = {"id": "run_01HQ", "status": "queued", "cancelRequestedAt": "2026-09-16T00:00:00Z"}
        instance, _calls = client(responding({"run": run}))

        self.assertEqual(instance.workflows.cancel("run_01HQ"), run)


class StatusTest(unittest.TestCase):
    """A `202` reports the run's CURRENT status — never `"canceled"`."""

    def test_running_status_is_carried_through_verbatim(self) -> None:
        instance, _calls = client(
            responding({"run": {"id": "run_1", "status": "running", "cancelRequestedAt": "x"}}),
        )

        result = instance.workflows.cancel("run_1")

        self.assertEqual(result["status"], "running")

    def test_queued_status_is_carried_through_verbatim(self) -> None:
        instance, _calls = client(
            responding({"run": {"id": "run_1", "status": "queued", "cancelRequestedAt": "x"}}),
        )

        result = instance.workflows.cancel("run_1")

        self.assertEqual(result["status"], "queued")

    def test_repeating_the_call_on_a_non_terminal_run_is_still_202(self) -> None:
        instance, calls = client(
            responding({"run": {"id": "run_1", "status": "running", "cancelRequestedAt": "x"}}),
        )

        first = instance.workflows.cancel("run_1")
        second = instance.workflows.cancel("run_1")

        self.assertEqual(first, second)
        self.assertEqual(len(calls), 2)


class FailureTest(unittest.TestCase):
    """The server answering no."""

    def test_a_404_unknown_run_reaches_the_caller_as_an_ApiError(self) -> None:
        raw = {"error": {"code": "unknown_run", "message": "No such run."}}
        instance, _calls = client(raising(http_error(404, raw, reason="Not Found")))

        with self.assertRaises(ApiError) as caught:
            instance.workflows.cancel("run_missing")

        self.assertEqual(caught.exception.status, 404)
        self.assertEqual(caught.exception.code, "unknown_run")
        self.assertEqual(caught.exception.message, "No such run.")
        self.assertEqual(caught.exception.raw, raw)

    def test_a_409_run_not_cancelable_reaches_the_caller_as_an_ApiError(self) -> None:
        raw = {"error": {"code": "run_not_cancelable", "message": "Run has already finished."}}
        instance, _calls = client(raising(http_error(409, raw, reason="Conflict")))

        with self.assertRaises(ApiError) as caught:
            instance.workflows.cancel("run_1")

        self.assertEqual(caught.exception.status, 409)
        self.assertEqual(caught.exception.code, "run_not_cancelable")


if __name__ == "__main__":  # pragma: no cover - convenience for a single-file run.
    unittest.main()
