"""`client.functions.run()` and `client.endpoints.run()`, against a fake transport.

These two exist so a caller can run the thing they NAMED rather than the id the
host issued. The cases below are the properties that makes true:

- **the name is the first positional argument**, not a keyword buried in an
  options object — an implementation that kept `run(name=...)` fails these;
- **id or key, one slot** — both forms reach the same path, so a wrapper that
  prefixed, tagged or branched on the shape fails the id cases;
- **`payload` is the one word** — the wire spells it `inputs` for a Function and
  `input` for an Endpoint, and reconciling that is the wrapper's job, so each
  case asserts the SENT body rather than only the call count;
- **a Function returns its output, an Endpoint returns the envelope** — the
  asymmetry is deliberate (an Endpoint's `kind` is real information).

The lanes are kept in step by construction: every case here has a counterpart in
`node/tests/named_run_test.ts`.
"""

from __future__ import annotations

import email.message
import io
import json
import unittest
from typing import Any, Callable, List, Optional, Tuple
from urllib.error import HTTPError
from urllib.request import Request

from w6w import ApiError, Client


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


def client(respond: Callable[[Request], Any]) -> Tuple[Client, List[Request]]:
    """A client wired to a fake transport."""
    transport = Recorder(respond)
    return (
        Client(base_url="https://api.example.com", token="tok_1", transport=transport),
        transport.calls,
    )


def responding(body: Any, status: int = 200) -> Callable[[Request], Any]:
    """Answer every request with one JSON body."""
    text = json.dumps(body)
    return lambda _request: FakeResponse(status, text)


def raising(status: int, body: Any) -> Callable[[Request], Any]:
    """Answer every request with the exception `urlopen` raises for a non-2xx."""

    def _respond(_request: Request) -> Any:
        raise HTTPError(
            "https://api.example.com",
            status,
            "",
            email.message.Message(),
            io.BytesIO(json.dumps(body).encode("utf-8")),
        )

    return _respond


def sent_body(request: Request) -> Any:
    """The JSON body of a recorded request."""
    data = request.data
    return json.loads(data.decode("utf-8")) if data else None


class FunctionsRunTest(unittest.TestCase):
    """`client.functions.run(name, payload=...)`."""

    def test_key_is_the_first_argument_and_lands_in_the_path(self) -> None:
        """The name is positional, and `payload` becomes `inputs` on the wire."""
        c, calls = client(responding({"output": {"id": "msg_1"}}))

        output = c.functions.run("send-email", payload={"to": "ada@example.com"})

        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0].full_url, "https://api.example.com/functions/send-email/invoke")
        self.assertEqual(calls[0].get_method(), "POST")
        self.assertEqual(sent_body(calls[0]), {"inputs": {"to": "ada@example.com"}})
        # The OUTPUT, not an envelope: the kind is settled by the method name.
        self.assertEqual(output, {"id": "msg_1"})

    def test_an_id_works_in_the_same_slot(self) -> None:
        """No prefix, no flag — an id and a key share one argument."""
        c, calls = client(responding({"output": 1}))

        c.functions.run("fn_a9b39917-cd4e-4eea-ab89-c3d079684193")

        self.assertEqual(
            calls[0].full_url,
            "https://api.example.com/functions/fn_a9b39917-cd4e-4eea-ab89-c3d079684193/invoke",
        )

    def test_omitted_payload_sends_an_empty_object(self) -> None:
        """`{}` says "no input"; an absent key says "I forgot"."""
        c, calls = client(responding({"output": 1}))

        c.functions.run("send-email")

        self.assertEqual(sent_body(calls[0]), {"inputs": {}})

    def test_the_name_is_percent_encoded_into_the_path(self) -> None:
        """A caller-supplied value never lands in a path unencoded."""
        c, calls = client(responding({"output": 1}))

        c.functions.run("a b/c")

        self.assertEqual(calls[0].full_url, "https://api.example.com/functions/a%20b%2Fc/invoke")

    def test_a_null_output_is_a_result_not_a_bad_response(self) -> None:
        """An action that returns nothing yields `{"output": null}` — a success."""
        c, _ = client(responding({"output": None}))

        self.assertIsNone(c.functions.run("send-email"))

    def test_a_body_with_no_output_key_is_a_bad_response(self) -> None:
        """Absent is malformed; null is not. The guard is presence, not truth."""
        c, _ = client(responding({"notOutput": 1}))

        with self.assertRaises(ApiError) as caught:
            c.functions.run("send-email")
        self.assertEqual(caught.exception.code, "bad_response")

    def test_a_404_raises_with_the_servers_code(self) -> None:
        """The server's own error code reaches the caller."""
        c, _ = client(raising(404, {"error": {"code": "unknown_function", "message": "no"}}))

        with self.assertRaises(ApiError) as caught:
            c.functions.run("nope")
        self.assertEqual(caught.exception.code, "unknown_function")


class EndpointsRunTest(unittest.TestCase):
    """`client.endpoints.run(name, payload=...)`."""

    def test_key_first_payload_becomes_input_envelope_returned_whole(self) -> None:
        """Singular `input` here, plural `inputs` for a Function."""
        c, calls = client(responding({"kind": "action", "value": {"ok": True}}))

        envelope = c.endpoints.run("send-email", payload={"to": "ada"})

        self.assertEqual(calls[0].full_url, "https://api.example.com/endpoints/send-email/invoke")
        self.assertEqual(sent_body(calls[0]), {"input": {"to": "ada"}})
        self.assertEqual(envelope, {"kind": "action", "value": {"ok": True}})

    def test_the_async_arm_is_returned_not_raised(self) -> None:
        """`202` is a normal outcome: the run is queued and `runId` follows it."""
        c, _ = client(responding({"kind": "workflow", "runId": "run_1", "status": "queued"}, 202))

        envelope = c.endpoints.run("nightly")

        self.assertEqual(envelope["kind"], "workflow")
        self.assertEqual(envelope["runId"], "run_1")

    def test_an_unknown_kind_is_handed_back_verbatim(self) -> None:
        """A future arm must not become a hard breakage for an installed version."""
        c, _ = client(responding({"kind": "something-new", "extra": 42}))

        envelope = c.endpoints.run("x")

        self.assertEqual(envelope["kind"], "something-new")
        self.assertEqual(envelope["extra"], 42)

    def test_a_body_with_no_kind_is_a_bad_response(self) -> None:
        """An object-only check would hand back an envelope with no discriminant."""
        c, _ = client(responding({}))

        with self.assertRaises(ApiError) as caught:
            c.endpoints.run("x")
        self.assertEqual(caught.exception.code, "bad_response")


if __name__ == "__main__":
    unittest.main()
