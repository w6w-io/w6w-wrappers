"""`client.me()`, against an **injected fake transport**.

No case here needs a live server or opens a socket
(`docs/implementation.md` §9): every one hands the client a callable that
records the `urllib.request.Request` it was given and returns — or raises —
whatever the case is about. The real `urlopen` is never called.

The route is **`GET /auth/me`** — the server's real, already-live identity
handler, called directly since 2026-07-28 rather than through the `/me` alias
D15 originally specced and that was never built (`docs/endpoints.md` §1). The
path is asserted below, because "which route does identity live at" is exactly
the kind of fact that drifts silently between a contract and three lanes.

Three of the cases below exist because they are the ones a plausible refactor
gets backwards:

- **Merge order.** `{"wrapper": VERSION, **server}` and
  `{**server, "wrapper": VERSION}` differ on exactly one field, and it is the
  field a bug report is read off. `ServerWinsTest` pins the contracted order by
  sending a `wrapper` the server chose and asserting the client did not win.
- **The display rule is not a data rule.** A placeholder version the server sent
  reaches the caller unaltered; rendering it as `dev` belongs to whatever prints
  it. A wrapper that scrubbed the map here would make the returned object stop
  being a transcription of the wire.
- **A non-object `200` body raises.** Measured cross-lane
  (`evals/T2.1.4.eval.md`): spreading a `200 []` produced an identity whose only
  populated field was the one the client had just added.
"""

from __future__ import annotations

import email.message
import io
import json
import unittest
from typing import Any, Callable, List, Tuple
from urllib.error import HTTPError
from urllib.request import Request

from w6w import ApiError, Me, W6wClient, __version__

#: The full URL `me` must request. One constant, so a lane that moved the route
#: fails on the assertion rather than on a fixture that moved with it.
ME_URL = "https://api.example.com/auth/me"

#: The identity half of the body, exactly as the server's handler sends it —
#: flat, with no wrapping object around the four fields.
ME_BODY = {
    "tenant": "default",
    "subject": "user_01H",
    "account": "default",
    "role": "admin",
}


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
    """Build the exception `urlopen` raises for a non-2xx status.

    An `HTTPError` **is** a response: it carries the status, the reason and a
    readable body, so an error case here exercises the same `urllib` trap a live
    server would.
    """
    return HTTPError(
        ME_URL,
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


class SurfaceTest(unittest.TestCase):
    """`me` is a method on the client, not a namespace."""

    def test_me_is_a_callable_method_on_the_client_itself(self) -> None:
        # `naming.python` is `client.me()`, character for character. A namespace
        # class would make it `client.me.me()`, which would still typecheck and
        # would still pass every OTHER case in this file — so the shape is
        # asserted directly.
        instance = W6wClient(base_url="https://api.example.com", token="t")

        self.assertTrue(callable(instance.me))
        self.assertFalse(hasattr(instance.me, "me"), "client.me must not be a namespace")


class IdentityTest(unittest.TestCase):
    """The flat body, and the request that fetches it."""

    def test_a_flat_body_with_no_versions_parses_into_the_four_fields(self) -> None:
        instance, calls = client(responding(ME_BODY))

        identity = instance.me()

        # Flat: the four fields sit at the top level of the response and at the
        # top level of the result. There is no `{"user": {…}}` anywhere.
        self.assertEqual(identity.tenant, "default")
        self.assertEqual(identity.subject, "user_01H")
        self.assertEqual(identity.account, "default")
        self.assertEqual(identity.role, "admin")
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0].get_method(), "GET")
        # `/auth/me`, not `/me`: the alias was never built and the wrapper calls
        # the server's real identity route directly.
        self.assertEqual(calls[0].full_url, ME_URL)
        self.assertEqual(calls[0].get_header("Authorization"), "Bearer tok_1")

    def test_a_body_with_no_versions_still_yields_a_versions_map(self) -> None:
        # An older server sends no block at all. The caller still gets one, so a
        # version banner never has to branch on whether it arrived.
        instance, _calls = client(responding(ME_BODY))

        self.assertEqual(instance.me().versions, {"wrapper": __version__})

    def test_an_unknown_top_level_field_is_ignored_rather_than_fatal(self) -> None:
        # The server adds fields additively; an installed client must keep
        # working. `**body` into the dataclass would raise `TypeError` here.
        body = dict(ME_BODY, impersonating="user_02", features=["beta"])

        instance, _calls = client(responding(body))

        self.assertEqual(instance.me().subject, "user_01H")

    def test_a_401_raises_ApiError_carrying_the_server_code(self) -> None:
        instance, _calls = client(
            raising(
                http_error(
                    401,
                    {"error": {"code": "unauthorized", "message": "Token not accepted."}},
                    reason="Unauthorized",
                ),
            ),
        )

        with self.assertRaises(ApiError) as caught:
            instance.me()

        self.assertEqual(caught.exception.status, 401)
        self.assertEqual(caught.exception.code, "unauthorized")
        self.assertEqual(caught.exception.message, "Token not accepted.")


class VersionsTest(unittest.TestCase):
    """What the wrapper adds to `versions`, and what it must not touch."""

    def test_versions_wrapper_is_filled_from_the_packages_own_version(self) -> None:
        # The server cannot know it; this is the one value the operation adds.
        instance, _calls = client(responding(dict(ME_BODY, versions={"composition": "server@1a2"})))

        versions = instance.me().versions

        self.assertEqual(versions["wrapper"], __version__)
        self.assertEqual(versions["composition"], "server@1a2")

    def test_a_server_supplied_wrapper_version_is_not_clobbered(self) -> None:
        # THE precedence pin. Server-wins: this package's version is a DEFAULT
        # that any key the server sent overrides, `wrapper` included. The
        # reverse merge order would return `__version__` here.
        self.assertNotEqual(__version__, "9.9.9", "the case is vacuous if these agree")
        instance, _calls = client(responding(dict(ME_BODY, versions={"wrapper": "9.9.9"})))

        self.assertEqual(instance.me().versions["wrapper"], "9.9.9")

    def test_an_unrecognised_versions_key_is_carried_through_not_rejected(self) -> None:
        # `versions` is an OPEN map. A key added server-side tomorrow must reach
        # a client shipped today, not fail its parse.
        instance, _calls = client(
            responding(
                dict(
                    ME_BODY,
                    versions={
                        "composition": "server@1a2 core@a11",
                        "engine": "4.2.0",
                        "somethingNobodyHasShippedYet": "x",
                    },
                ),
            ),
        )

        versions = instance.me().versions

        self.assertEqual(versions["engine"], "4.2.0")
        self.assertEqual(versions["somethingNobodyHasShippedYet"], "x")
        self.assertEqual(versions["wrapper"], __version__)

    def test_a_placeholder_version_from_the_server_reaches_the_caller_unaltered(self) -> None:
        # D5 is a RENDERING rule, and this is the line between the two: the data
        # a caller receives is a faithful transcription of the wire, so a
        # `0.0.0` the server sent is still `0.0.0` here. Presenting it as "dev"
        # is the job of whatever puts a version in front of a person (the CLI's
        # `w6w info` banner). A wrapper that scrubbed the map would have a bug
        # report quote a version the server never sent.
        instance, _calls = client(
            responding(dict(ME_BODY, versions={"composition": "0.0.0", "wrapper": ""})),
        )

        versions = instance.me().versions

        self.assertEqual(versions["composition"], "0.0.0")
        self.assertEqual(versions["wrapper"], "")
        self.assertNotIn("dev", versions.values())

    def test_a_versions_block_that_is_not_an_object_is_dropped_not_merged(self) -> None:
        # Matching the `node` lane, where spreading a string produced
        # character-indexed junk that satisfied the declared type. Reporting
        # only what this client actually knows beats inventing keys.
        for malformed in ("1.2.3", ["1.2.3"], 7, None):
            with self.subTest(versions=malformed):
                instance, _calls = client(responding(dict(ME_BODY, versions=malformed)))

                self.assertEqual(instance.me().versions, {"wrapper": __version__})

class BadResponseTest(unittest.TestCase):
    """A `2xx` that is not an identity object is a `bad_response`, never data."""

    def test_a_non_object_success_body_raises_bad_response(self) -> None:
        # `200 []` is the measured cross-lane case: it must NOT return a
        # degenerate `Me` whose only populated field is `versions`. A string, a
        # list of objects and a bare number fail the same way.
        for body in ([], [dict(ME_BODY)], "ok", 7, None):
            with self.subTest(body=body):
                instance, _calls = client(responding(body))

                with self.assertRaises(ApiError) as caught:
                    instance.me()

                self.assertEqual(caught.exception.code, "bad_response")
                self.assertEqual(caught.exception.status, 200)

    def test_the_bad_response_carries_the_offending_body_for_triage(self) -> None:
        instance, _calls = client(responding([]))

        with self.assertRaises(ApiError) as caught:
            instance.me()

        self.assertEqual(caught.exception.raw, [])


class FromWireTest(unittest.TestCase):
    """`Me.from_wire` on its own: a pure transcription, no fill."""

    def test_from_wire_does_not_invent_a_wrapper_entry(self) -> None:
        # The fill belongs to the operation, not to the type — so a caller who
        # parses a body themselves gets exactly what the server sent.
        self.assertEqual(Me.from_wire(ME_BODY).versions, {})

    def test_from_wire_copies_versions_rather_than_aliasing_the_parsed_body(self) -> None:
        # Asserted HERE rather than through `me()`, deliberately: the merge in
        # `fetch_me` builds a new dict either way, so a case routed through the
        # client could not fail no matter what `from_wire` did. This is the one
        # seam where the aliasing is observable, so this is where it is pinned.
        body = dict(ME_BODY, versions={"composition": "c1"})

        Me.from_wire(body).versions["composition"] = "tampered"

        self.assertEqual(body["versions"], {"composition": "c1"})

    def test_missing_identity_fields_read_as_empty_rather_than_raising(self) -> None:
        # A server that stops sending a documented field is a server bug; a
        # wrapper that raised on it would turn that into an outage for every
        # installed client, on every call.
        identity = Me.from_wire({"tenant": "default"})

        self.assertEqual(identity.tenant, "default")
        self.assertEqual(identity.subject, "")
        self.assertEqual(identity.role, "")


if __name__ == "__main__":  # pragma: no cover - convenience for a single-file run.
    unittest.main()
