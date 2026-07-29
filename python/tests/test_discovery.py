"""`client.connections.list()` and `client.workflows.list()`, against a fake transport.

No case here needs a live server or opens a socket
(`docs/implementation.md` §9). Each one asserts the request the wrapper *made*
(method, full resolved URL including `?project=`, bearer) **and** the value it
returned, which is always the unwrapped payload and never the server's envelope.

These two operations exist to answer one question — *what can I run?* (D4) — so
the cases below are weighted towards the two ways a discovery call goes wrong in
practice: a wire field the exposed type does not model (which must be dropped,
not fatal, because the real response carries one **today**), and a scope
parameter appearing on a route that does not read one.
"""

from __future__ import annotations

import email.message
import io
import json
import unittest
from typing import Any, Callable, List, Optional, Tuple
from urllib.error import HTTPError
from urllib.request import Request

from w6w import ApiError, ConnectionSummary, W6wClient, WorkflowSummary

#: One connection, as the server sends it — **including the `tenant` the exposed
#: type deliberately omits**. This is not a synthetic extra key: the server's own
#: summary really carries it, so a reader that rejected unknown keys would raise
#: on every real response.
CONNECTION_BODY = {
    "id": "conn_1",
    "appId": "sendgrid",
    "authKey": "api_key",
    "tenant": "default",
    "owner": "user_01H",
    "displayName": "Marketing SendGrid",
    "state": "connected",
    "profile": {"accountName": "marketing"},
    "lastTestOk": True,
    "lastTestedAt": "2026-07-20T09:14:00.000Z",
    "createdAt": "2026-07-01T12:00:00.000Z",
    "updatedAt": "2026-07-20T09:14:00.000Z",
}

CONNECTION = ConnectionSummary(
    id="conn_1",
    appId="sendgrid",
    authKey="api_key",
    owner="user_01H",
    displayName="Marketing SendGrid",
    state="connected",
    profile={"accountName": "marketing"},
    lastTestOk=True,
    lastTestedAt="2026-07-20T09:14:00.000Z",
    createdAt="2026-07-01T12:00:00.000Z",
    updatedAt="2026-07-20T09:14:00.000Z",
)

#: One workflow, as the server sends it.
WORKFLOW_BODY = {
    "id": "wf_1",
    "name": "welcome-email",
    "displayName": "Welcome Email",
    "description": "Sends a welcome email on signup.",
    "status": "active",
    "tags": ["onboarding"],
    "runCount": 412,
    "updatedAt": "2026-07-22T18:03:00.000Z",
}

WORKFLOW = WorkflowSummary(
    id="wf_1",
    name="welcome-email",
    displayName="Welcome Email",
    description="Sends a welcome email on signup.",
    status="active",
    tags=["onboarding"],
    runCount=412,
    updatedAt="2026-07-22T18:03:00.000Z",
)


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
        "https://api.example.com/workflows",
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


class SurfaceTest(unittest.TestCase):
    """Both namespaces exist, and neither has grown an operation it must not have."""

    def test_both_list_operations_are_callable_on_a_constructed_client(self) -> None:
        instance = W6wClient(base_url="https://api.example.com", token="t")

        self.assertTrue(callable(instance.connections.list))
        self.assertTrue(callable(instance.workflows.list))

    def test_neither_namespace_exposes_a_write_operation(self) -> None:
        # `endpoints.json` puts every connection write and every workflow write
        # out of scope for this version: they are interactive studio flows, and
        # half of one in an SDK is worse than none. `workflows.run` is not a
        # write in that sense — it triggers a definition rather than editing one
        # — so it is contracted, present, and covered by `test_workflows_run.py`.
        instance = W6wClient(base_url="https://api.example.com", token="t")

        for name in ("create", "update", "delete", "test"):
            with self.subTest(operation=name):
                self.assertFalse(hasattr(instance.connections, name))
                self.assertFalse(hasattr(instance.workflows, name))


class ConnectionsListTest(unittest.TestCase):
    """`GET /connections` — the envelope, the redaction, and the extra key."""

    def test_list_unwraps_the_envelope_and_returns_the_connections(self) -> None:
        instance, calls = client(responding({"connections": [CONNECTION_BODY]}))

        connections = instance.connections.list()

        # The list itself, not {"connections": […]} — the caller never sees the
        # envelope. And the wire's camelCase survives transcription.
        self.assertEqual(connections, [CONNECTION])
        self.assertEqual(connections[0].lastTestedAt, "2026-07-20T09:14:00.000Z")
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0].get_method(), "GET")
        self.assertEqual(calls[0].full_url, "https://api.example.com/connections")
        self.assertEqual(calls[0].get_header("Authorization"), "Bearer tok_1")

    def test_list_with_no_connections_is_an_empty_list_not_an_error(self) -> None:
        instance, _calls = client(responding({"connections": []}))

        self.assertEqual(instance.connections.list(), [])

    def test_the_wire_tenant_field_is_dropped_rather_than_fatal(self) -> None:
        # THE tolerance pin. `CONNECTION_BODY` carries `tenant` because the real
        # response does; a strict model would raise on every live call. It is
        # tolerated on the way in and absent on the way out.
        instance, _calls = client(responding({"connections": [CONNECTION_BODY]}))

        connection = instance.connections.list()[0]

        self.assertIn("tenant", CONNECTION_BODY, "the case is vacuous without the extra key")
        self.assertFalse(hasattr(connection, "tenant"))

    def test_the_redacted_fields_are_not_modelled(self) -> None:
        # Declaring a field the server strips would invite a caller to look for
        # something no response will ever carry.
        instance, _calls = client(responding({"connections": [CONNECTION_BODY]}))

        connection = instance.connections.list()[0]

        self.assertFalse(hasattr(connection, "credential"))
        self.assertFalse(hasattr(connection, "lastRefreshedAt"))

    def test_a_never_tested_connection_keeps_null_apart_from_false(self) -> None:
        # `lastTestOk: null` means NEVER TESTED, which is not the same statement
        # as "tested, and it failed". Flattening it to False would report a
        # broken connection that nobody has ever tested.
        body = dict(CONNECTION_BODY, lastTestOk=None, lastTestedAt=None)

        instance, _calls = client(responding({"connections": [body]}))

        connection = instance.connections.list()[0]

        self.assertIsNone(connection.lastTestOk)
        self.assertIsNone(connection.lastTestedAt)

    def test_a_sparse_item_defaults_to_the_state_that_claims_nothing(self) -> None:
        # There is no server-side default to mirror for `state` (unlike a
        # workflow's `draft`), so the safe member is the one chosen: defaulting
        # to `connected` would have this client claim a connection works on the
        # strength of a field that never arrived.
        instance, _calls = client(responding({"connections": [{"id": "conn_2"}]}))

        connection = instance.connections.list()[0]

        self.assertEqual(connection.state, "pending")
        self.assertEqual(connection.profile, {})

    def test_profile_is_copied_rather_than_aliasing_the_parsed_body(self) -> None:
        # `profile` is opaque pass-through, so a caller may well mutate what it
        # gets; that must not reach back into the response body a caller can
        # still be holding via `client.request`.
        body = dict(CONNECTION_BODY)

        ConnectionSummary.from_wire(body).profile["accountName"] = "tampered"

        self.assertEqual(body["profile"], {"accountName": "marketing"})

    def test_list_sends_no_project_parameter_even_with_a_client_default(self) -> None:
        # Connections are user-private and the route reads no `?project=`. The
        # namespace is handed the client's `request` method alone and so holds
        # no default to send — but that is a narrow host type, not a capability
        # barrier (a bound method carries its instance, so the config is one hop
        # away). This case is what actually holds the line: it asserts on the
        # WIRE, and fails on the parameter however it was obtained.
        instance, calls = client(responding({"connections": []}), project="prj_default")

        instance.connections.list()

        self.assertEqual(calls[0].full_url, "https://api.example.com/connections")
        self.assertNotIn("project", calls[0].full_url)

    def test_an_error_envelope_raises_ApiError_with_the_server_code(self) -> None:
        instance, _calls = client(
            raising(
                http_error(
                    403,
                    {"error": {"code": "forbidden", "message": "Not your tenant."}},
                    reason="Forbidden",
                ),
            ),
        )

        with self.assertRaises(ApiError) as caught:
            instance.connections.list()

        self.assertEqual(caught.exception.status, 403)
        self.assertEqual(caught.exception.code, "forbidden")

    def test_a_success_body_without_the_envelope_key_is_a_bad_response(self) -> None:
        for body in ({"items": []}, {"connections": {}}, []):
            with self.subTest(body=body):
                instance, _calls = client(responding(body))

                with self.assertRaises(ApiError) as caught:
                    instance.connections.list()

                self.assertEqual(caught.exception.code, "bad_response")


class WorkflowsListTest(unittest.TestCase):
    """`GET /workflows[?project=]` — the envelope, and the scope."""

    def test_list_unwraps_the_envelope_and_returns_the_workflows(self) -> None:
        instance, calls = client(responding({"workflows": [WORKFLOW_BODY]}))

        workflows = instance.workflows.list()

        self.assertEqual(workflows, [WORKFLOW])
        self.assertEqual(workflows[0].tags, ["onboarding"])
        self.assertEqual(workflows[0].runCount, 412)
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0].get_method(), "GET")
        self.assertEqual(calls[0].full_url, "https://api.example.com/workflows")
        self.assertEqual(calls[0].get_header("Authorization"), "Bearer tok_1")

    def test_list_of_an_empty_account_is_an_empty_list_not_an_error(self) -> None:
        instance, _calls = client(responding({"workflows": []}))

        self.assertEqual(instance.workflows.list(), [])

    def test_the_result_is_a_plain_list_with_no_container_around_it(self) -> None:
        # Cross-lane: the route is unpaginated today, and the `node` lane's
        # "array that can carry a cursor later" trick does not survive
        # `JSON.stringify` and does not translate to a Python list. Three
        # wrappers grow the same container together or not at all.
        instance, _calls = client(responding({"workflows": [WORKFLOW_BODY]}))

        workflows = instance.workflows.list()

        self.assertIs(type(workflows), list)
        self.assertFalse(hasattr(workflows, "cursor"))

    def test_a_per_call_project_becomes_the_query_parameter(self) -> None:
        instance, calls = client(responding({"workflows": []}))

        instance.workflows.list(project="prj_1")

        self.assertEqual(calls[0].full_url, "https://api.example.com/workflows?project=prj_1")

    def test_the_clients_default_project_is_used_when_none_is_passed(self) -> None:
        instance, calls = client(responding({"workflows": []}), project="prj_default")

        instance.workflows.list()

        self.assertEqual(
            calls[0].full_url,
            "https://api.example.com/workflows?project=prj_default",
        )

    def test_a_per_call_project_overrides_the_clients_default(self) -> None:
        instance, calls = client(responding({"workflows": []}), project="prj_default")

        instance.workflows.list(project="prj_other")

        self.assertEqual(
            calls[0].full_url,
            "https://api.example.com/workflows?project=prj_other",
        )

    def test_an_explicit_empty_project_is_forwarded_rather_than_dropped(self) -> None:
        # Cross-lane parity, decided with the `node` lane: only an ABSENT value
        # (`None` / `undefined`) is dropped, so an empty string a caller passed
        # explicitly goes on the wire as `?project=`. It does not fall back to
        # the client's default either — the caller said something. The server
        # reads `query("project") || undefined`, so it is a no-op there; what
        # matters is that the three lanes put the same bytes on the wire.
        instance, calls = client(responding({"workflows": []}), project="prj_default")

        instance.workflows.list(project="")

        self.assertEqual(calls[0].full_url, "https://api.example.com/workflows?project=")

    def test_an_error_envelope_raises_ApiError_with_the_server_code(self) -> None:
        instance, _calls = client(
            raising(
                http_error(
                    400,
                    {"error": {"code": "unknown_project", "message": "No such project."}},
                    reason="Bad Request",
                ),
            ),
        )

        with self.assertRaises(ApiError) as caught:
            instance.workflows.list(project="prj_missing")

        self.assertEqual(caught.exception.status, 400)
        self.assertEqual(caught.exception.code, "unknown_project")

    def test_a_success_body_without_the_envelope_key_is_a_bad_response(self) -> None:
        for body in ({"items": []}, {"workflows": {}}, []):
            with self.subTest(body=body):
                instance, _calls = client(responding(body))

                with self.assertRaises(ApiError) as caught:
                    instance.workflows.list()

                self.assertEqual(caught.exception.code, "bad_response")

    def test_unknown_item_fields_are_ignored_and_absent_ones_default(self) -> None:
        # Additive server change on one side, older server on the other. Neither
        # may raise, and the two defaults are the server's own answers rather
        # than invented ones.
        instance, _calls = client(
            responding({"workflows": [{"id": "wf_2", "owner": "user_01H", "runCount": True}]}),
        )

        workflow = instance.workflows.list()[0]

        self.assertEqual(workflow.id, "wf_2")
        self.assertEqual(workflow.status, "draft")
        self.assertEqual(workflow.tags, [])
        self.assertEqual(workflow.description, "")
        # `True` is an `int` in Python; a wire boolean must not become a count.
        self.assertEqual(workflow.runCount, 0)

    def test_a_tags_field_of_the_wrong_shape_does_not_become_a_list_of_characters(self) -> None:
        # `tags: "onboarding"` is iterable, so a reader that only checked for
        # absence would hand the caller nine single-character tags.
        instance, _calls = client(
            responding({"workflows": [dict(WORKFLOW_BODY, tags="onboarding")]}),
        )

        self.assertEqual(instance.workflows.list()[0].tags, [])


if __name__ == "__main__":  # pragma: no cover - convenience for a single-file run.
    unittest.main()
