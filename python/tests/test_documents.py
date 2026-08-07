"""`client.documents.*`, against an **injected fake transport**.

No case here needs a live server or opens a socket
(`docs/implementation.md` §9): every one hands the client a callable that
records the `urllib.request.Request` it was given and returns — or raises —
whatever the case is about. The real `urlopen` is never called.

Each case asserts the request the wrapper *made* (method, full resolved URL
including `?project=`, bearer, serialised body) **and** the value it returned,
which is always the unwrapped payload and never the server's envelope.
"""

from __future__ import annotations

import email.message
import io
import json
import unittest
from typing import Any, Callable, List, Optional, Tuple
from urllib.error import HTTPError
from urllib.request import Request

from w6w import UNSET, ApiError, Client, Doc

#: One document, as the server sends it — camelCase timestamps included.
DOC_BODY = {
    "id": "doc_1",
    "key": "welcome-email-copy",
    "content": "# Welcome",
    "format": "markdown",
    "description": "Body copy.",
    "createdAt": "2026-07-01T12:00:00.000Z",
    "updatedAt": "2026-07-22T18:03:00.000Z",
}

DOC = Doc(
    id="doc_1",
    key="welcome-email-copy",
    content="# Welcome",
    format="markdown",
    description="Body copy.",
    createdAt="2026-07-01T12:00:00.000Z",
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
    """Build the exception `urlopen` raises for a non-2xx status.

    An `HTTPError` **is** a response: it carries the status, the reason and a
    readable body. The error cases use a real one so they exercise the same
    `urllib` trap a live server would.
    """
    return HTTPError(
        "https://api.example.com/documents",
        status,
        reason,
        email.message.Message(),
        io.BytesIO(json.dumps(body).encode("utf-8")),
    )


def client(
    respond: Callable[[Request], Any],
    project: Optional[str] = None,
) -> Tuple[Client, List[Request]]:
    """A client wired to a fake transport. `project` seeds the client default."""
    transport = Recorder(respond)
    return (
        Client(
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
    """The JSON body actually put on the wire, parsed back."""
    assert request.data is not None, "expected a request body"
    return json.loads(request.data.decode("utf-8"))


class SurfaceTest(unittest.TestCase):
    """The namespace exists and is complete."""

    def test_all_six_operations_are_callable_on_a_constructed_client(self) -> None:
        # Deliberately a runtime assertion, not a type-level one: a namespace
        # that silently lost a method would still typecheck in every OTHER case
        # in this file (they all call through the same object), so the suite has
        # to look. The names are `naming.python`'s, character for character.
        instance = Client(base_url="https://api.example.com", token="t")

        for name in ("list", "get", "get_by_key", "create", "update", "delete"):
            with self.subTest(operation=name):
                self.assertTrue(
                    callable(getattr(instance.documents, name, None)),
                    "documents.{0} is missing".format(name),
                )


class ReadTest(unittest.TestCase):
    """The three reads: list, by id, by key."""

    def test_list_unwraps_the_envelope_and_returns_the_documents(self) -> None:
        instance, calls = client(responding({"documents": [DOC_BODY]}))

        docs = instance.documents.list()

        # The list itself, not {"documents": […]} — the caller never sees the
        # envelope. And the wire's camelCase survives transcription.
        self.assertEqual(docs, [DOC])
        self.assertEqual(docs[0].createdAt, "2026-07-01T12:00:00.000Z")
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0].get_method(), "GET")
        self.assertEqual(calls[0].full_url, "https://api.example.com/documents")
        self.assertEqual(calls[0].get_header("Authorization"), "Bearer tok_1")

    def test_list_of_an_empty_store_is_an_empty_list_not_an_error(self) -> None:
        instance, _calls = client(responding({"documents": []}))

        self.assertEqual(instance.documents.list(), [])

    def test_get_addresses_the_id_route_and_unwraps_the_single_key(self) -> None:
        instance, calls = client(responding({"document": DOC_BODY}))

        doc = instance.documents.get("doc_1")

        self.assertEqual(doc, DOC)
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0].get_method(), "GET")
        self.assertEqual(calls[0].full_url, "https://api.example.com/documents/doc_1")

    def test_get_by_key_percent_encodes_the_key_into_one_path_segment(self) -> None:
        instance, calls = client(responding({"document": DOC_BODY}))

        instance.documents.get_by_key("notes/2026")
        instance.documents.get_by_key("two words")
        instance.documents.get_by_key("what?now")

        # A `/` MUST NOT become a second path segment: unencoded, "notes/2026"
        # addresses a different route entirely.
        self.assertEqual(
            calls[0].full_url,
            "https://api.example.com/documents/by-key/notes%2F2026",
        )
        self.assertEqual(
            calls[1].full_url,
            "https://api.example.com/documents/by-key/two%20words",
        )
        # And a `?` must not start a query string.
        self.assertEqual(
            calls[2].full_url,
            "https://api.example.com/documents/by-key/what%3Fnow",
        )

    def test_get_by_key_encodes_and_sends_a_dot_dot_key_rather_than_rejecting_it(
        self,
    ) -> None:
        # D1, this lane's half. `.` is unreserved in RFC 3986, so no encoder
        # touches it — and `urllib` does not normalise the path away either, so
        # what goes out is the literal `/api/documents/by-key/..`. (The `node`
        # lane's WHATWG URL parser normalises the same call to
        # `/api/documents/`, the LIST route. Measured off a socket in
        # evals/T2.1.3.eval.md; the lanes' HTTP stacks differ and neither is
        # wrong.)
        #
        # What this case pins is the part that IS this lane's choice: no
        # client-side rejection. `".."` is a key the server accepts at create
        # time, and a wrapper that refused it here would make a document that
        # legitimately exists permanently unreadable through this client.
        instance, calls = client(responding({"document": DOC_BODY}))

        instance.documents.get_by_key("..")

        self.assertEqual(len(calls), 1)
        self.assertEqual(
            calls[0].full_url,
            "https://api.example.com/documents/by-key/..",
        )

    def test_one_read_is_one_http_call_never_a_list_then_filter(self) -> None:
        # `get_by_key` targeting a real route (rather than listing everything
        # and scanning) is the whole of D12; a composed implementation would
        # show up here as two calls.
        instance, calls = client(responding({"document": DOC_BODY}))

        instance.documents.get_by_key("welcome-email-copy")

        self.assertEqual(len(calls), 1)
        self.assertNotIn("/api/documents?", calls[0].full_url)


class WriteTest(unittest.TestCase):
    """Create, update and delete — and what each one puts on the wire."""

    def test_create_sends_only_the_fields_given_and_accepts_201(self) -> None:
        instance, calls = client(responding({"document": DOC_BODY}, status=201))

        doc = instance.documents.create("welcome-email-copy", "# Welcome")

        self.assertEqual(doc, DOC)
        self.assertEqual(calls[0].get_method(), "POST")
        self.assertEqual(calls[0].full_url, "https://api.example.com/documents")
        # No `format`, no `description`: the server owns the default for one and
        # has nothing to store for the other.
        self.assertEqual(sent_body(calls[0]), {"key": "welcome-email-copy", "content": "# Welcome"})

    def test_create_sends_format_and_description_when_they_are_given(self) -> None:
        instance, calls = client(responding({"document": DOC_BODY}, status=201))

        instance.documents.create("k", "c", format="markdown", description="d")

        self.assertEqual(
            sent_body(calls[0]),
            {"key": "k", "content": "c", "format": "markdown", "description": "d"},
        )

    def test_create_surfaces_the_409_conflict_code_intact(self) -> None:
        instance, _calls = client(
            raising(
                http_error(
                    409,
                    {
                        "error": {
                            "code": "document_exists",
                            "message": 'A document with key "k" already exists.',
                        },
                    },
                ),
            ),
        )

        with self.assertRaises(ApiError) as caught:
            instance.documents.create("k", "c")

        # The server's own code, not a generic "error" — a caller retrying with
        # a different key has to be able to tell this from a 400.
        self.assertEqual(caught.exception.status, 409)
        self.assertEqual(caught.exception.code, "document_exists")

    def test_update_sends_only_the_fields_supplied(self) -> None:
        instance, calls = client(responding({"document": DOC_BODY}))

        doc = instance.documents.update("doc_1", content="# Hello")

        self.assertEqual(doc, DOC)
        self.assertEqual(calls[0].get_method(), "PATCH")
        self.assertEqual(calls[0].full_url, "https://api.example.com/documents/doc_1")
        # D2: the omitted fields are ABSENT, not null. `{"format": null}` would
        # be an instruction to change the format.
        self.assertEqual(sent_body(calls[0]), {"content": "# Hello"})

    def test_update_sends_an_explicit_null_for_a_field_set_to_none(self) -> None:
        # The other half of D2: `None` is a value, not an absence, and it has to
        # be expressible. `UNSET` is what "leave it alone" is spelled with.
        instance, calls = client(responding({"document": DOC_BODY}))

        instance.documents.update("doc_1", description=None)

        self.assertEqual(sent_body(calls[0]), {"description": None})
        # Asserted on the raw bytes too, because `{"description": null}` and an
        # absent key are the same Python object graph away from JSON.
        self.assertIn(b'"description": null', calls[0].data or b"")

    def test_update_with_no_fields_sends_an_empty_body(self) -> None:
        instance, calls = client(responding({"document": DOC_BODY}))

        instance.documents.update("doc_1")

        self.assertEqual(sent_body(calls[0]), {})

    def test_update_treats_an_explicit_unset_exactly_like_an_omitted_argument(self) -> None:
        # The sentinel is public so a caller can forward "not supplied" through
        # their own code; passing it explicitly must be identical to omitting.
        instance, calls = client(responding({"document": DOC_BODY}))

        instance.documents.update("doc_1", content="x", description=UNSET)

        self.assertEqual(sent_body(calls[0]), {"content": "x"})

    def test_delete_returns_none_rather_than_the_ok_envelope(self) -> None:
        instance, calls = client(responding({"ok": True}))

        result = instance.documents.delete("doc_1")

        self.assertIsNone(result)
        self.assertEqual(calls[0].get_method(), "DELETE")
        self.assertEqual(calls[0].full_url, "https://api.example.com/documents/doc_1")

    def test_delete_of_an_unknown_id_raises_rather_than_succeeding_silently(self) -> None:
        instance, _calls = client(
            raising(
                http_error(404, {"error": {"code": "unknown_document", "message": "Not found."}}),
            ),
        )

        with self.assertRaises(ApiError) as caught:
            instance.documents.delete("doc_missing")

        self.assertEqual(caught.exception.status, 404)
        self.assertEqual(caught.exception.code, "unknown_document")


class ProjectScopeTest(unittest.TestCase):
    """`?project=` — present on every document route, and only when configured."""

    def test_no_project_query_is_sent_when_none_is_configured(self) -> None:
        instance, calls = client(responding({"documents": []}))

        instance.documents.list()

        self.assertEqual(calls[0].full_url, "https://api.example.com/documents")
        self.assertNotIn("project", calls[0].full_url)

    def test_the_client_default_reaches_all_six_operations(self) -> None:
        instance, calls = client(responding({"document": DOC_BODY, "documents": []}), "prj_default")

        instance.documents.list()
        instance.documents.get("doc_1")
        instance.documents.get_by_key("k")
        instance.documents.create("k", "c")
        instance.documents.update("doc_1", content="c2")
        instance.documents.delete("doc_1")

        self.assertEqual(len(calls), 6)
        for call in calls:
            with self.subTest(url=call.full_url):
                self.assertIn("project=prj_default", call.full_url)

    def test_a_per_call_project_overrides_the_client_default(self) -> None:
        instance, calls = client(responding({"documents": []}), "prj_default")

        instance.documents.list()
        instance.documents.list(project="prj_other")

        self.assertTrue(calls[0].full_url.endswith("?project=prj_default"))
        self.assertTrue(calls[1].full_url.endswith("?project=prj_other"))

    def test_a_project_id_is_query_encoded(self) -> None:
        instance, calls = client(responding({"documents": []}))

        instance.documents.list(project="a b&c")

        self.assertEqual(
            calls[0].full_url,
            "https://api.example.com/documents?project=a+b%26c",
        )


class BadResponseTest(unittest.TestCase):
    """D3 — a `2xx` that does not carry what it promised."""

    def test_a_2xx_without_the_envelope_key_raises_bad_response(self) -> None:
        # Not `None` returned and a failure deferred: a server regression has to
        # surface at the response that caused it, not as an AttributeError in
        # the caller's code minutes later.
        instance, _calls = client(responding({"unexpected": True}))

        with self.assertRaises(ApiError) as caught:
            instance.documents.get("doc_1")

        self.assertEqual(caught.exception.code, "bad_response")
        self.assertEqual(caught.exception.status, 200)
        # The body is kept, so the caller can see what did arrive.
        self.assertEqual(caught.exception.raw, {"unexpected": True})
        # The message says the key was MISSING. Asserted because the two
        # bad-response shapes are otherwise indistinguishable to a reader of the
        # traceback — and because a `unwrap` that returned `None` instead of
        # raising would still produce a `bad_response` one layer further down,
        # with the wrong diagnosis ("… is NoneType, not an object").
        self.assertIn('no "document"', caught.exception.message)

    def test_a_2xx_whose_payload_is_the_wrong_shape_raises_bad_response(self) -> None:
        instance, _calls = client(responding({"document": None}))

        with self.assertRaises(ApiError) as caught:
            instance.documents.get("doc_1")

        self.assertEqual(caught.exception.code, "bad_response")
        self.assertIn("not an object", caught.exception.message)

    def test_bad_response_stays_distinct_from_a_server_error_code(self) -> None:
        # `bad_response` means "the server said yes and then did not send what
        # it promised". A non-2xx carrying a real envelope must NOT collapse
        # into it, or the two become untriageable.
        instance, _calls = client(
            raising(
                http_error(404, {"error": {"code": "unknown_document", "message": "Not found."}}),
            ),
        )

        with self.assertRaises(ApiError) as caught:
            instance.documents.get("doc_missing")

        self.assertEqual(caught.exception.code, "unknown_document")
        self.assertNotEqual(caught.exception.code, "bad_response")


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
