"""The definition lifecycle on `client.workflows.*` and `client.functions.*`.

Against an **injected fake transport**; no case here opens a socket
(`docs/implementation.md` §9). The `node` lane's `definitions_crud_test.ts` is
the mirror of this file, case for case, because the two lanes have to put the
same bytes on the wire.

These two domains share a file because they share the shape that makes them easy
to get wrong: **one upsert route serving two methods**. `create` and `update` are
the same POST, and everything that separates them happens in the wrapper —
minting an id, or pinning the one the caller addressed. A test per method would
let the two drift; the cases below assert them against each other.

Three things pinned here that no other suite can see:

1. **The minted id is real and is sent.** The server rejects a body with no
   ``id``, so a `create` that forwarded the caller's mapping verbatim would fail
   on the most natural call there is. The assertion is on the *wire*, not on the
   returned object.
2. **`update` overrides the body's ``id``.** ``update("wf_a", def_of_b)`` must
   write to A. The failure mode is silent: it writes to B and answers with B's
   id, which reads like success.
3. **The precondition header is absent unless asked for.** The server parses
   whatever arrives and answers `400 invalid_precondition` for a value it cannot
   read, so an empty or ``"None"`` string is worse than no header.
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

#: A workflow definition as a caller hands it to `create` — no `id` of its own.
WORKFLOW_DEF = {"manifestVersion": "2", "name": "nightly-sync", "steps": []}

#: What `POST /workflows` answers with.
WORKFLOW_SAVED = {
    "workflow": {"id": "wf_1", "name": "nightly-sync"},
    "scheduled": False,
    "updatedAt": "2026-08-22T09:00:00.000Z",
}

#: What `GET /workflows/:id` answers with. No envelope key — the body IS the payload.
WORKFLOW_DETAIL = {
    "workflow": {"id": "wf_1", "name": "nightly-sync", "status": "draft", "tags": []},
    "sourceRef": None,
    "updatedAt": "2026-08-22T09:00:00.000Z",
}

FUNCTION_ROW = {
    "id": "fn_1",
    "key": "send-email",
    "displayName": "Send email",
    "description": "",
    "updatedAt": "2026-08-22T09:00:00.000Z",
    "valid": True,
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
    """Build the exception `urlopen` raises for a non-2xx status."""
    return HTTPError(
        "https://api.example.com/workflows",
        status,
        reason,
        email.message.Message(),
        io.BytesIO(json.dumps(body).encode("utf-8")),
    )


def client(respond: Callable[[Request], Any]) -> Tuple[Client, List[Request]]:
    """A client wired to a fake transport, **with** a default project.

    Load-bearing: the workflow write path is supposed to forward that default,
    and the Function one is supposed to ignore it entirely — an asymmetry the
    server dictates, and one that is only observable against a client that has a
    default to forward in the first place.
    """
    transport = Recorder(respond)
    return (
        Client(
            base_url="https://api.example.com",
            token="tok_1",
            project="prj_default",
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
    """The JSON body actually put on the wire, parsed back."""
    assert request.data is not None, "expected a request body"
    return json.loads(request.data.decode("utf-8"))


class SurfaceTest(unittest.TestCase):
    """Both namespaces exist and are complete."""

    def test_workflows_exposes_all_seven_operations(self) -> None:
        instance, _ = client(responding({}))
        for name in ("list", "run", "get", "create", "update", "archive", "delete"):
            with self.subTest(operation=name):
                self.assertTrue(callable(getattr(instance.workflows, name)))

    def test_functions_exposes_all_six_operations(self) -> None:
        instance, _ = client(responding({}))
        for name in ("run", "list", "get", "create", "update", "delete"):
            with self.subTest(operation=name):
                self.assertTrue(callable(getattr(instance.functions, name)))


class WorkflowReadTest(unittest.TestCase):
    """`GET /workflows/:id` — the body with no envelope."""

    def test_get_returns_the_whole_body(self) -> None:
        instance, calls = client(responding(WORKFLOW_DETAIL))

        detail = instance.workflows.get("wf_1")

        self.assertEqual(detail.workflow, WORKFLOW_DETAIL["workflow"])
        self.assertIsNone(detail.sourceRef)
        self.assertEqual(detail.updatedAt, "2026-08-22T09:00:00.000Z")
        self.assertEqual(calls[0].full_url, "https://api.example.com/workflows/wf_1")
        self.assertEqual(calls[0].get_method(), "GET")

    def test_updated_at_stays_outside_the_definition(self) -> None:
        # The definition is the portable document. A wrapper that spliced the
        # server's timestamp into it would put it in the object the caller sends
        # straight back to `update`.
        instance, _ = client(responding(WORKFLOW_DETAIL))

        detail = instance.workflows.get("wf_1")

        self.assertNotIn("updatedAt", detail.workflow)

    def test_the_id_is_percent_encoded_into_the_path(self) -> None:
        instance, calls = client(responding(WORKFLOW_DETAIL))

        instance.workflows.get("wf_a/b")

        self.assertEqual(calls[0].full_url, "https://api.example.com/workflows/wf_a%2Fb")


class WorkflowWriteTest(unittest.TestCase):
    """`POST /workflows` — one route, two methods, and one header rule."""

    def test_create_mints_an_id_when_the_definition_carries_none(self) -> None:
        instance, calls = client(responding(WORKFLOW_SAVED, 201))

        instance.workflows.create(WORKFLOW_DEF)

        # The server rejects a body with no `id` outright, so this is the
        # assertion that the operation works at all.
        body = sent_body(calls[0])
        self.assertTrue(body["id"].startswith("wf_"))
        self.assertEqual(body["name"], "nightly-sync")
        self.assertEqual(calls[0].get_method(), "POST")

    def test_create_forwards_a_caller_supplied_id_untouched(self) -> None:
        # Minting is a fallback, not a policy: a seeded or imported definition
        # keeps the id it was written with, or re-importing one would fork it.
        instance, calls = client(responding(WORKFLOW_SAVED, 201))

        instance.workflows.create({**WORKFLOW_DEF, "id": "wf_seeded"})

        self.assertEqual(sent_body(calls[0])["id"], "wf_seeded")

    def test_create_does_not_mutate_the_mapping_it_was_given(self) -> None:
        # The caller's dict is theirs. Minting into it in place would leave a
        # second `create` of the same template silently overwriting the first.
        definition = dict(WORKFLOW_DEF)
        instance, _ = client(responding(WORKFLOW_SAVED, 201))

        instance.workflows.create(definition)

        self.assertNotIn("id", definition)

    def test_create_returns_the_save_result_flattened_to_id_and_name(self) -> None:
        instance, _ = client(responding(WORKFLOW_SAVED, 201))

        saved = instance.workflows.create(WORKFLOW_DEF)

        self.assertEqual(saved.id, "wf_1")
        self.assertEqual(saved.name, "nightly-sync")
        self.assertFalse(saved.scheduled)
        self.assertEqual(saved.updatedAt, "2026-08-22T09:00:00.000Z")

    def test_update_pins_the_addressed_id_over_the_bodys_own(self) -> None:
        # The silent failure this prevents: writing to B while reading as a
        # write to A, and answering with B's id so it looks like it worked.
        instance, calls = client(responding(WORKFLOW_SAVED, 201))

        instance.workflows.update("wf_a", {**WORKFLOW_DEF, "id": "wf_b"})

        self.assertEqual(sent_body(calls[0])["id"], "wf_a")

    def test_the_precondition_header_is_sent_only_when_given(self) -> None:
        instance, calls = client(responding(WORKFLOW_SAVED, 201))

        instance.workflows.update("wf_1", WORKFLOW_DEF)
        # `urllib` capitalises header keys, so ask it rather than the raw dict.
        self.assertIsNone(calls[0].get_header("X-w6w-if-unmodified-since"))

        instance.workflows.update(
            "wf_1", WORKFLOW_DEF, if_unmodified_since="2026-08-22T09:00:00.000Z"
        )
        self.assertEqual(
            calls[1].get_header("X-w6w-if-unmodified-since"),
            "2026-08-22T09:00:00.000Z",
        )

    def test_the_credential_survives_a_request_that_carries_headers(self) -> None:
        # The header seam is public (`Client.request`), and the precondition is
        # its first caller. A merge that let an extra header win would send a
        # different credential than the client was constructed with.
        instance, calls = client(responding(WORKFLOW_SAVED, 201))

        instance.workflows.update(
            "wf_1", WORKFLOW_DEF, if_unmodified_since="2026-08-22T09:00:00.000Z"
        )

        self.assertEqual(calls[0].get_header("Authorization"), "Bearer tok_1")

    def test_a_per_call_project_overrides_the_client_default(self) -> None:
        instance, calls = client(responding(WORKFLOW_SAVED, 201))

        instance.workflows.create(WORKFLOW_DEF, project="prj_other")

        self.assertEqual(calls[0].full_url, "https://api.example.com/workflows?project=prj_other")

    def test_archive_unwraps_the_workflow_envelope(self) -> None:
        archived = {"id": "wf_1", "name": "nightly-sync", "status": "archived"}
        instance, calls = client(responding({"workflow": archived}))

        self.assertEqual(instance.workflows.archive("wf_1"), archived)
        self.assertEqual(calls[0].full_url, "https://api.example.com/workflows/wf_1/archive")
        self.assertEqual(calls[0].get_method(), "POST")

    def test_delete_returns_none_rather_than_the_ok_body(self) -> None:
        instance, calls = client(responding({"ok": True}))

        self.assertIsNone(instance.workflows.delete("wf_1"))
        self.assertEqual(calls[0].get_method(), "DELETE")

    def test_delete_does_not_archive_on_the_callers_behalf(self) -> None:
        # A 409 is a real signal: the caller asked to delete something still
        # live. Completing the two-step destructive path for them is how a
        # workflow someone only meant to look at gets deleted.
        instance, calls = client(
            raising(
                http_error(409, {"error": {"code": "workflow_not_archived", "message": "No."}})
            )
        )

        with self.assertRaises(ApiError) as caught:
            instance.workflows.delete("wf_1")

        self.assertEqual(caught.exception.code, "workflow_not_archived")
        self.assertEqual(len(calls), 1)


class FunctionReadTest(unittest.TestCase):
    """`GET /functions` and `GET /functions/:idOrKey`."""

    def test_list_unwraps_the_functions_envelope(self) -> None:
        instance, _ = client(responding({"functions": [FUNCTION_ROW]}))

        fns = instance.functions.list()

        self.assertEqual(len(fns), 1)
        self.assertEqual(fns[0].key, "send-email")
        self.assertTrue(fns[0].valid)

    def test_a_row_with_no_valid_key_reads_as_not_runnable(self) -> None:
        # The field gates whether a caller offers this Function as runnable, so
        # the safe default for an answer the server did not give is "no".
        row = {k: v for k, v in FUNCTION_ROW.items() if k != "valid"}
        instance, _ = client(responding({"functions": [row]}))

        self.assertFalse(instance.functions.list()[0].valid)

    def test_no_request_on_this_domain_carries_a_project(self) -> None:
        # The route reads no `?project=` at all, so forwarding the client's
        # default would be sending an argument the server ignores.
        instance, calls = client(responding({"functions": [], "function": {}, "valid": True}))

        instance.functions.list()
        instance.functions.get("fn_1")

        for call in calls:
            with self.subTest(url=call.full_url):
                self.assertNotIn("project=", call.full_url)

    def test_get_keeps_valid_a_sibling_of_the_definition(self) -> None:
        # `valid` is computed per request and is not part of the stored
        # document. Splicing it in would put it inside the object a caller sends
        # back to `update`.
        instance, _ = client(responding({"function": {"id": "fn_1"}, "valid": False}))

        detail = instance.functions.get("fn_1")

        self.assertFalse(detail.valid)
        self.assertNotIn("valid", detail.function)


class FunctionWriteTest(unittest.TestCase):
    """`POST /functions` and `DELETE /functions/:idOrKey`."""

    def test_create_mints_an_id_but_never_a_key(self) -> None:
        # The key is the name the Function is CALLED by. Minting one would name
        # the caller's Function for them.
        instance, calls = client(responding({"function": {"id": "fn_1", "key": "send-email"}}, 201))

        instance.functions.create({"key": "send-email", "inputs": []})

        body = sent_body(calls[0])
        self.assertTrue(body["id"].startswith("fn_"))
        self.assertEqual(body["key"], "send-email")

    def test_create_unwraps_the_function_envelope(self) -> None:
        instance, _ = client(responding({"function": {"id": "fn_1", "key": "send-email"}}, 201))

        saved = instance.functions.create({"key": "send-email", "inputs": []})

        self.assertEqual((saved.id, saved.key), ("fn_1", "send-email"))

    def test_update_pins_the_addressed_id_over_the_bodys_own(self) -> None:
        instance, calls = client(responding({"function": {"id": "fn_a", "key": "k"}}, 201))

        instance.functions.update("fn_a", {"id": "fn_b", "key": "k", "inputs": []})

        self.assertEqual(sent_body(calls[0])["id"], "fn_a")

    def test_delete_returns_none_and_does_not_swallow_a_404(self) -> None:
        ok, calls = client(responding({"ok": True}))
        self.assertIsNone(ok.functions.delete("fn_1"))
        self.assertEqual(calls[0].get_method(), "DELETE")

        missing, _ = client(
            raising(http_error(404, {"error": {"code": "unknown_function", "message": "No."}}))
        )
        with self.assertRaises(ApiError) as caught:
            missing.functions.delete("fn_x")
        self.assertEqual(caught.exception.code, "unknown_function")

    def test_a_key_conflict_surfaces_its_own_code(self) -> None:
        # Two distinct 409s live on this route — an ownership clash on the id,
        # and the key already being taken. Flattening them would leave a caller
        # unable to tell "rename it" from "you do not own this".
        instance, _ = client(
            raising(http_error(409, {"error": {"code": "function_key_conflict", "message": "!"}}))
        )

        with self.assertRaises(ApiError) as caught:
            instance.functions.create({"key": "send-email", "inputs": []})

        self.assertEqual(caught.exception.code, "function_key_conflict")


if __name__ == "__main__":  # pragma: no cover - convenience for a single-file run.
    unittest.main()
