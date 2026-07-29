"""`client.run(urn, action=…, payload=…)`, against an injected fake transport.

No case here needs a live server or opens a socket
(`docs/implementation.md` §9), even though `POST /run` has been live since
2026-07-28.

Two things are load-bearing and are asserted rather than assumed:

1. **The arms keep their own field names.** `value` (action) and `output`
   (function) are deliberately different; a wrapper that normalised them into
   one field would fail the first two cases.
2. **An unknown `kind` is returned, not raised.** The case below feeds
   `{"kind": "batch", "jobId": "job_1"}` and asserts the *returned object*,
   including the unknown sibling field — "does not crash" is not an assertion a
   raising implementation fails, so it is not what is asserted. It is also why
   this operation hands back the parsed dict rather than a dataclass: a
   dataclass drops `jobId` by construction.
"""

from __future__ import annotations

import email.message
import io
import json
import unittest
from typing import Any, Callable, List, Tuple
from urllib.error import HTTPError
from urllib.request import Request

from w6w import (
    ApiError,
    W6wClient,
    is_action_run,
    is_function_run,
    is_workflow_run,
)

#: The full URL every case below must request. `/run` is a fixed path with no
#: interpolation: all three fields travel in the body.
RUN_URL = "https://api.example.com/run"


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


def client(respond: Callable[[Request], Any]) -> Tuple[W6wClient, List[Request]]:
    """A client wired to a fake transport."""
    transport = Recorder(respond)
    return (
        W6wClient(base_url="https://api.example.com", token="tok_1", transport=transport),
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


class SurfaceTest(unittest.TestCase):
    """`run` is a method on the client, not a namespace."""

    def test_run_is_a_callable_method_on_the_client_itself(self) -> None:
        # `naming.python` is `client.run(urn, action=None, payload=None)`,
        # character for character up to the parenthesis. A namespace class would
        # make it `client.run.run()`, which would pass every OTHER case here.
        instance = W6wClient(base_url="https://api.example.com", token="t")

        self.assertTrue(callable(instance.run))
        self.assertFalse(hasattr(instance.run, "run"), "client.run must not be a namespace")


class ArmsTest(unittest.TestCase):
    """The three known arms, each keeping its own field name."""

    def test_the_action_arm_returns_value_and_sends_the_three_fields(self) -> None:
        instance, calls = client(responding({"kind": "action", "value": {"id": "msg_1"}}))

        env = instance.run("conn_01H", action="send_email", payload={"to": "a@b.c"})

        self.assertTrue(is_action_run(env))
        self.assertEqual(env["value"], {"id": "msg_1"})
        # `value`, never renamed to `output`: the discrimination is the point.
        self.assertNotIn("output", env)
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0].get_method(), "POST")
        self.assertEqual(calls[0].full_url, RUN_URL)
        self.assertEqual(calls[0].get_header("Authorization"), "Bearer tok_1")
        self.assertEqual(calls[0].get_header("Content-type"), "application/json")
        self.assertEqual(
            sent_body(calls[0]),
            {"urn": "conn_01H", "action": "send_email", "payload": {"to": "a@b.c"}},
        )

    def test_the_function_arm_returns_output(self) -> None:
        instance, _calls = client(responding({"kind": "function", "output": [1, 2]}))

        env = instance.run("fn_01H")

        self.assertTrue(is_function_run(env))
        self.assertEqual(env["output"], [1, 2])
        self.assertNotIn("value", env)

    def test_the_workflow_arm_is_a_202_and_is_not_an_error(self) -> None:
        # 202 is a NORMAL outcome on this arm: the run is queued and `runId` is
        # how the caller follows it. An implementation that raised on the status
        # fails here by raising.
        instance, _calls = client(
            responding({"kind": "workflow", "runId": "run_01H", "status": "queued"}, 202),
        )

        env = instance.run("wf_01H")

        self.assertTrue(is_workflow_run(env))
        self.assertEqual(env["runId"], "run_01H")
        self.assertEqual(env["status"], "queued")

    def test_an_unknown_kind_is_returned_verbatim_with_its_sibling_fields(self) -> None:
        # THE forward-compatibility pin. The server may grow a fourth arm before
        # the wrappers do, on the one operation whose entire job is dispatch.
        # Returning the parsed body — rather than raising, and rather than
        # transcribing it into a dataclass that would drop `jobId` — is what
        # keeps that additive change from breaking every installed client.
        instance, _calls = client(responding({"kind": "batch", "jobId": "job_1"}))

        env = instance.run("bt_01H")

        self.assertEqual(env, {"kind": "batch", "jobId": "job_1"})
        self.assertEqual(env["jobId"], "job_1")
        self.assertFalse(is_action_run(env))
        self.assertFalse(is_function_run(env))
        self.assertFalse(is_workflow_run(env))


class BodyTest(unittest.TestCase):
    """What goes on the wire when the caller omits the optional fields."""

    def test_an_omitted_action_is_absent_from_the_body_rather_than_null(self) -> None:
        # A workflow, function or endpoint URN has no action. Sending
        # `"action": null` would be a value the route has to reject; omitting the
        # key is the same request the `node` lane makes, where an `undefined`
        # member vanishes at serialisation.
        instance, calls = client(responding({"kind": "function", "output": None}))

        instance.run("fn_01H")

        self.assertEqual(sent_body(calls[0]), {"urn": "fn_01H", "payload": {}})

    def test_an_omitted_payload_defaults_to_an_empty_object(self) -> None:
        # Defaulted rather than omitted: the server's parameter schemas are
        # written against an object, and `{}` says "no input" where an absent key
        # says "I forgot".
        instance, calls = client(responding({"kind": "action", "value": 1}))

        instance.run("conn_01H", action="ping")

        self.assertEqual(sent_body(calls[0])["payload"], {})

    def test_the_urn_travels_in_the_body_and_is_never_encoded_into_a_path(self) -> None:
        # `/run` is a fixed path. A URN in JSON needs no escaping, and a wrapper
        # that put it in the path would address a route that does not exist.
        instance, calls = client(responding({"kind": "action", "value": 1}))

        instance.run("conn_01H/../..")

        self.assertEqual(calls[0].full_url, RUN_URL)
        self.assertEqual(sent_body(calls[0])["urn"], "conn_01H/../..")


class FailureTest(unittest.TestCase):
    """The server answering no, and the server answering nonsense."""

    def test_an_unresolvable_urn_reaches_the_caller_as_an_ApiError(self) -> None:
        instance, _calls = client(
            raising(
                http_error(
                    404,
                    {"error": {"code": "unknown_urn", "message": "No such URN."}},
                    reason="Not Found",
                ),
            ),
        )

        with self.assertRaises(ApiError) as caught:
            instance.run("wf_missing")

        self.assertEqual(caught.exception.status, 404)
        self.assertEqual(caught.exception.code, "unknown_urn")

    def test_a_424_passes_through_as_a_4xx_with_its_code_and_body_intact(self) -> None:
        # An execute-phase failure is the target app's own hook throwing, almost
        # always the upstream vendor returning an error. It is a 4xx ON PURPOSE
        # — Cloudflare replaces an origin 5xx with a CORS-less HTML page that
        # strips the real message — so it must never be normalised into a
        # transport error or a server error.
        raw = {
            "error": {"code": "app_error", "message": "sendgrid rejected the payload"},
            "logs": ["POST /v3/mail/send -> 400"],
        }
        instance, _calls = client(raising(http_error(424, raw, reason="Failed Dependency")))

        with self.assertRaises(ApiError) as caught:
            instance.run("conn_01H", action="send_email")

        self.assertEqual(caught.exception.status, 424)
        self.assertEqual(caught.exception.code, "app_error")
        self.assertEqual(caught.exception.message, "sendgrid rejected the payload")
        # The parsed body is kept, so the `logs` an invoke failure rides
        # alongside never have to be re-fetched.
        self.assertEqual(caught.exception.raw, raw)

    def test_a_success_body_with_no_kind_is_a_bad_response(self) -> None:
        # A malformed dispatch response is not a new arm: it is the one shape a
        # caller cannot do anything with. The guard requires a STRING `kind`,
        # exactly as its sibling in `workflows.run` requires a string `runId` —
        # two operations in one package must not disagree about what a malformed
        # success body is.
        for body in ({}, {"value": 1}, {"kind": 42}, [], [{"kind": "action"}], "ok", None):
            with self.subTest(body=body):
                instance, _calls = client(responding(body))

                with self.assertRaises(ApiError) as caught:
                    instance.run("conn_01H")

                self.assertEqual(caught.exception.code, "bad_response")
                self.assertEqual(caught.exception.status, 200)
                self.assertIn('no "kind"', caught.exception.message)
                self.assertEqual(caught.exception.raw, body)


if __name__ == "__main__":  # pragma: no cover - convenience for a single-file run.
    unittest.main()
