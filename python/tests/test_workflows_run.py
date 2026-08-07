"""`client.workflows.run(id, …)`, against an injected fake transport.

Every case runs against a mocked transport (`docs/implementation.md` §9), and
the file is weighted towards the three things this route gets called wrong:

1. **`202` is success**, both for a queued run and for a `?wait=` that timed out.
2. **A run that failed is data** — a `200` carrying `status: "failed"` — and is
   returned, never raised. Mapping it to an exit code is the CLI's job.
3. **There is no client-side polling.** Every case asserts the number of
   requests made, so a poll loop added later fails here rather than in
   production.
"""

from __future__ import annotations

import email.message
import io
import json
import unittest
from typing import Any, Callable, List, Optional, Tuple
from urllib.error import HTTPError
from urllib.request import Request

from w6w import ApiError, StepError, W6wClient, is_terminal_run_status

#: The URL a run of `wf_01HQ` must POST to, with no query string.
RUN_URL = "https://api.example.com/workflows/wf_01HQ/run"


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
        RUN_URL,
        status,
        reason,
        email.message.Message(),
        io.BytesIO(json.dumps(body).encode("utf-8")),
    )


def client(
    respond: Callable[[Request], Any],
    project: Optional[str] = None,
) -> Tuple[W6wClient, List[Request]]:
    """A client wired to a fake transport. `project` seeds the client default."""
    transport = Recorder(respond)
    return (
        W6wClient(
            base_url="https://api.example.com",
            token="tok_1",
            project=project,
            transport=transport,
        ),
        transport.calls,
    )


def responding(body: Any, status: int = 200) -> Callable[[Request], Any]:
    """Answer every request with one JSON body."""
    text = json.dumps(body)
    return lambda _request: FakeResponse(status, text)


def raising(error: BaseException) -> Callable[[Request], Any]:
    """Raise, the way `urlopen` does for a non-2xx status."""

    def _raise(_request: Request) -> Any:
        raise error

    return _raise


def sent_body(request: Request) -> Any:
    """The JSON body a recorded request carried."""
    return json.loads(request.data.decode("utf-8"))


class QueuedTest(unittest.TestCase):
    """No `wait`: the run is enqueued and the answer is a 202."""

    def test_a_queued_run_is_a_202_and_is_returned_rather_than_raised(self) -> None:
        instance, calls = client(responding({"runId": "run_01HQ", "status": "queued"}, 202))

        run = instance.workflows.run("wf_01HQ")

        self.assertEqual(run.runId, "run_01HQ")
        self.assertEqual(run.status, "queued")
        self.assertFalse(run.terminal)
        self.assertEqual(run.httpStatus, 202)
        # A 202 carries no steps; normalised to {} so a caller iterating them
        # never has to branch on which status carried the body.
        self.assertEqual(run.steps, {})

        self.assertEqual(len(calls), 1, "exactly one request — no client-side polling")
        self.assertEqual(calls[0].get_method(), "POST")
        # No `?wait=` at all, not `?wait=false`.
        self.assertEqual(calls[0].full_url, RUN_URL)
        self.assertEqual(calls[0].get_header("Authorization"), "Bearer tok_1")
        self.assertEqual(sent_body(calls[0]), {})

    def test_wait_false_is_the_same_request_as_no_wait_at_all(self) -> None:
        # The server compares the raw query value to the string "true", so
        # `?wait=false` would mean the same thing while looking like it meant
        # something else — in a log, in a proxy, and to the next reader.
        instance, calls = client(responding({"runId": "run_1", "status": "queued"}, 202))

        instance.workflows.run("wf_01HQ", wait=False)

        self.assertEqual(calls[0].full_url, RUN_URL)

    def test_run_sends_no_project_parameter_even_with_a_client_default(self) -> None:
        # A `wf_…` id is unambiguous on its own and the route reads no
        # `?project=`; `endpoints.json` gives this operation exactly five
        # parameters. This asserts on the WIRE, so a scope added later fails
        # here however it was obtained.
        instance, calls = client(
            responding({"runId": "run_1", "status": "queued"}, 202),
            project="prj_default",
        )

        instance.workflows.run("wf_01HQ")

        self.assertEqual(calls[0].full_url, RUN_URL)
        self.assertNotIn("project", calls[0].full_url)


class WaitTest(unittest.TestCase):
    """`wait=True`: the wait happens server-side, and both outcomes are success."""

    def test_a_terminal_run_comes_back_as_a_200_with_its_result(self) -> None:
        instance, calls = client(
            responding(
                {
                    "runId": "run_01HQ",
                    "status": "succeeded",
                    "output": {"sent": 3},
                    "error": None,
                    "steps": {"step_a": {"status": "succeeded"}},
                },
            ),
        )

        run = instance.workflows.run("wf_01HQ", wait=True)

        self.assertEqual(run.status, "succeeded")
        self.assertTrue(run.terminal)
        self.assertEqual(run.httpStatus, 200)
        self.assertEqual(run.output, {"sent": 3})
        self.assertEqual(run.steps, {"step_a": {"status": "succeeded"}})

        self.assertEqual(len(calls), 1, "the wait happens server-side — one request")
        self.assertEqual(calls[0].full_url, RUN_URL + "?wait=true")

    def test_a_failed_run_is_RETURNED_never_raised(self) -> None:
        # The single most-often-got-wrong semantic in this surface. A run-level
        # failure is reported in the envelope, not as an HTTP error, so this
        # must be an ordinary return value — an implementation that raises fails
        # this case because the assertions below are on what came back.
        instance, _calls = client(
            responding(
                {
                    "runId": "run_01HQ",
                    "status": "failed",
                    "output": None,
                    "error": {"code": "step_failed", "message": "sendgrid rejected it"},
                    "steps": {"step_a": {"status": "failed"}},
                    "stepErrors": [{"stepId": "step_a", "error": {"code": "app_error"}}],
                },
            ),
        )

        run = instance.workflows.run("wf_01HQ", wait=True)

        self.assertEqual(run.status, "failed")
        # Terminal, because the run finished — it finished badly, which is data.
        self.assertTrue(run.terminal)
        self.assertEqual(run.httpStatus, 200)
        self.assertEqual(run.error, {"code": "step_failed", "message": "sendgrid rejected it"})
        self.assertEqual(run.stepErrors, [StepError(stepId="step_a", error={"code": "app_error"})])

    def test_a_wait_timeout_comes_back_as_a_202_with_the_current_status(self) -> None:
        # The server waited up to its own timeout and gave up; the run is still
        # going. Also a success, and the reason `httpStatus` is exposed at all:
        # the body alone cannot tell this apart from a run never waited on.
        instance, calls = client(responding({"runId": "run_01HQ", "status": "running"}, 202))

        run = instance.workflows.run("wf_01HQ", wait=True)

        self.assertEqual(run.status, "running")
        self.assertFalse(run.terminal)
        self.assertEqual(run.httpStatus, 202)
        self.assertEqual(len(calls), 1, "no client-side retry after a server-side timeout")

    def test_terminal_reads_the_runs_status_and_not_the_http_code(self) -> None:
        # The predicate and the flag answer the same question, and the question
        # is about the run: a 202 can carry `queued` or `running`.
        self.assertEqual(
            [s for s in ("queued", "running", "succeeded", "failed", "canceled")
             if is_terminal_run_status(s)],
            ["succeeded", "failed", "canceled"],
        )


class BodyTest(unittest.TestCase):
    """`variables` and `trigger` are body fields, and `trigger` is an open string."""

    def test_variables_and_trigger_reach_the_request_body(self) -> None:
        instance, calls = client(responding({"runId": "run_01HQ", "status": "queued"}, 202))

        instance.workflows.run(
            "wf_01HQ",
            variables={"email": "a@example.com", "count": 2},
            trigger="webhook",
        )

        self.assertEqual(
            sent_body(calls[0]),
            {"variables": {"email": "a@example.com", "count": 2}, "trigger": "webhook"},
        )
        self.assertEqual(calls[0].get_header("Content-type"), "application/json")
        # They are body fields, not query parameters.
        self.assertEqual(calls[0].full_url, RUN_URL)

    def test_input_reaches_the_request_body_distinct_from_variables(self) -> None:
        # `input` is delivered to the entry trigger node's own recorded output
        # (`steps.<triggerId>.output.<key>`), not the run's variable scope
        # (`vars.*`, which is what `variables` seeds) — separate body fields,
        # both sent when both are given.
        instance, calls = client(responding({"runId": "run_01HQ", "status": "queued"}, 202))

        instance.workflows.run(
            "wf_01HQ",
            variables={"count": 2},
            input={"email": "a@example.com", "plan": "pro"},
        )

        self.assertEqual(
            sent_body(calls[0]),
            {"variables": {"count": 2}, "input": {"email": "a@example.com", "plan": "pro"}},
        )

        # Omitted means omitted, not `null` or `{}` — no `input` key at all when
        # the caller does not pass one.
        instance2, calls2 = client(responding({"runId": "run_2", "status": "queued"}, 202))

        instance2.workflows.run("wf_01HQ", variables={"count": 1})

        self.assertEqual(sent_body(calls2[0]), {"variables": {"count": 1}})

    def test_an_unknown_trigger_value_is_sent_never_validated(self) -> None:
        # `endpoints.json` declares `trigger` as an open string with
        # `closedEnum: false` — the five known values are documentation. A
        # wrapper that validated against them would reject a request the server
        # accepts the day a sixth lands, and would need a release to catch up.
        instance, calls = client(responding({"runId": "run_1", "status": "queued"}, 202))

        instance.workflows.run("wf_01HQ", trigger="a_future_server_value")

        self.assertEqual(sent_body(calls[0]), {"trigger": "a_future_server_value"})

    def test_the_workflow_id_is_percent_encoded_into_the_path(self) -> None:
        # Encoding at interpolation, via `path` — the same pin the document key
        # routes are held to. A caller-supplied id never becomes extra segments.
        instance, calls = client(responding({"runId": "run_1", "status": "queued"}, 202))

        instance.workflows.run("wf a/b?x")

        self.assertEqual(
            calls[0].full_url,
            "https://api.example.com/workflows/wf%20a%2Fb%3Fx/run",
        )


class FailureTest(unittest.TestCase):
    """The server answering no, and the server answering nonsense."""

    def test_a_404_unknown_workflow_reaches_the_caller_as_an_ApiError(self) -> None:
        raw = {"error": {"code": "unknown_workflow", "message": "Not registered."}}
        instance, _calls = client(raising(http_error(404, raw, reason="Not Found")))

        with self.assertRaises(ApiError) as caught:
            instance.workflows.run("wf_missing")

        self.assertEqual(caught.exception.status, 404)
        self.assertEqual(caught.exception.code, "unknown_workflow")
        self.assertEqual(caught.exception.message, "Not registered.")
        self.assertEqual(caught.exception.raw, raw)

    def test_a_success_body_that_is_not_a_run_object_is_a_bad_response(self) -> None:
        # An object-only check would let most of these through and return a
        # result whose `runId: str` and `status: RunStatus` were not strings at
        # runtime — a lie the annotations cannot catch, surfacing in the
        # caller's code minutes later. The guard requires both fields, which
        # keeps it exactly as strict as its sibling in `run.py`.
        bodies: List[Any] = [
            {},
            [],
            [{"runId": "run_1", "status": "queued"}],
            {"ok": True},
            {"runId": 42, "status": 7},
            {"runId": "run_1"},
            {"status": "queued"},
            "ok",
            None,
        ]
        for body in bodies:
            with self.subTest(body=body):
                instance, _calls = client(responding(body))

                with self.assertRaises(ApiError) as caught:
                    instance.workflows.run("wf_01HQ")

                self.assertEqual(caught.exception.code, "bad_response")
                self.assertIn("not a run object", caught.exception.message)
                self.assertEqual(caught.exception.raw, body)

    def test_a_minimal_well_formed_202_body_is_still_accepted(self) -> None:
        # The control for the case above: the guard must reject malformed bodies
        # without becoming a schema validator. `runId` + `status` is everything a
        # queued run carries, and it goes straight through.
        instance, _calls = client(responding({"runId": "run_1", "status": "queued"}, 202))

        run = instance.workflows.run("wf_01HQ")

        self.assertEqual(run.runId, "run_1")
        self.assertEqual(run.status, "queued")
        self.assertEqual(run.steps, {})
        self.assertIsNone(run.output)
        self.assertIsNone(run.stepErrors)

    def test_unknown_body_fields_are_ignored_rather_than_fatal(self) -> None:
        # Additive server change: a field this release has not learned must not
        # raise. A caller who needs it reaches it through `client.request`.
        instance, _calls = client(
            responding({"runId": "run_1", "status": "queued", "queuePosition": 3}, 202),
        )

        run = instance.workflows.run("wf_01HQ")

        self.assertEqual(run.runId, "run_1")
        self.assertFalse(hasattr(run, "queuePosition"))


if __name__ == "__main__":  # pragma: no cover - convenience for a single-file run.
    unittest.main()
