"""`client.documents.*` — the document store, addressed the way the server addresses it.

Six operations, **one HTTP call each**. Create by `key`, read by id or by key,
update and delete by id (`docs/implementation.md` §7, D6 amended by D12). There
is no key-addressed façade over the id routes and no client-side
list-then-filter anywhere in this file: a `get_by_key` implemented as "list
everything and scan" is O(n) over someone's whole store, it races, and
`packages/wrappers/README.md` ("What a wrapper is") states that a wrapper needing
to compose two calls is describing an operation that belongs in the API.

`get_by_key` therefore targets a real route — `GET /documents/by-key/{key}` —
which is `status: "planned"` in `endpoints.json` and lands with T4.4.1 (fenced by
BLK-1). Against a server that does not serve it yet it raises `404`; that is the
correct failure and it is not worked around here.

Documents are **project-scoped**: every route below accepts an optional
`?project=`, resolved per call, then from the client's default, and otherwise
left to the server (which picks the account's default project). Variables are
not — see `_vars.py`, whose namespace is constructed without this client's
configuration precisely so it cannot reach a default to send.
"""

from __future__ import annotations

from typing import Any, Dict, List, Mapping, Optional, Protocol, Union

from ._config import ResolvedConfig
from ._http import HttpResponse, path
from .types import (
    UNSET,
    Doc,
    DocFormat,
    PatchableStr,
    Unset,
    patch_body,
    unwrap_list,
    unwrap_object,
)


class DocumentsHost(Protocol):
    """The slice of `W6wClient` this namespace needs.

    Structural rather than a concrete client type, so the namespace stays
    independently constructible in a test and this module never imports the
    client back (which would be an import cycle as well as a layering
    inversion).

    Two members, and the second one is the asymmetry: `documents` reads the
    client's resolved configuration because it has a **default project** to
    apply. The variables namespace is handed the transport alone.
    """

    #: The resolved configuration; only `project` is read.
    config: ResolvedConfig

    def request(
        self,
        method: str,
        path: str,
        query: Optional[Mapping[str, Any]] = None,
        body: Optional[Any] = None,
    ) -> HttpResponse:
        """Perform one request.

        :param method: HTTP method.
        :param path: Base-relative path.
        :param query: Query parameters; `None` values are dropped.
        :param body: Request body, serialised as JSON.
        :returns: The status and parsed body.
        """
        ...  # pragma: no cover - a protocol body is never executed.


class DocumentsApi:
    """The `documents` namespace on a `W6wClient`.

    Reached as `client.documents`; never constructed directly by a caller.

    Example::

        doc = client.documents.create("welcome", "# Hi", format="markdown")
        client.documents.update(doc.id, content="# Hello")
        client.documents.delete(doc.id)
    """

    def __init__(self, host: DocumentsHost) -> None:
        """Bind the namespace to the client it issues requests through.

        :param host: The client. Its transport and its default project are
            read; nothing here is module state.
        """
        self._host = host

    def _project(self, project: Optional[str]) -> Optional[str]:
        """Resolve which project a call is scoped to.

        Per-call argument first, then the client's default, then nothing at all
        — an absent value means **no `?project=` on the wire**, which is how a
        caller asks for the account's default project.

        Read from the host on every call rather than captured at construction,
        so the namespace and the client can never disagree about which project
        is the default.

        :param project: The per-call argument, if any.
        :returns: The project id to send, or `None` to send none.
        """
        return project if project is not None else self._host.config.project

    def list(self, project: Optional[str] = None) -> List[Doc]:
        """List the caller's documents.

        :param project: Project to scope this call to; defaults to the client's.
        :returns: The documents, unwrapped from the `documents` envelope.
        :raises ConfigError: When no token is configured.
        :raises ApiError: On any non-2xx, e.g. `400 unknown_project`.
        """
        response = self._host.request(
            "GET",
            "/documents",
            query={"project": self._project(project)},
        )
        return [Doc.from_wire(item) for item in unwrap_list(response, "documents")]

    def get(self, id: str, project: Optional[str] = None) -> Doc:
        """Fetch one document by its server-issued id.

        :param id: The `doc_…` id.
        :param project: Project to scope this call to; defaults to the client's.
        :returns: The document.
        :raises ConfigError: When no token is configured.
        :raises ApiError: `404 unknown_document` when there is no such id.
        """
        response = self._host.request(
            "GET",
            path("/documents/{id}", id=id),
            query={"project": self._project(project)},
        )
        return Doc.from_wire(unwrap_object(response, "document"))

    def get_by_key(self, key: str, project: Optional[str] = None) -> Doc:
        """Fetch one document by the `key` its author chose.

        The key is percent-encoded at interpolation by :func:`w6w.path`, which
        is not ceremony: the server accepts any non-empty key up to 128
        characters, so `"a/b"` and `"a?b"` are keys a user can legitimately
        create, and concatenated naively they address a *different route* —
        `"a/b"` becomes two path segments. Encoded, they stay one.

        Encoding, **never validation**. A key the server accepts is sent as-is
        (encoded); this method does not reject, trim or canonicalise one.
        Refusing a key locally would make a document that is legitimately
        creatable through the same API permanently unreadable through this
        client.

        **This lane differs from the `node` lane for dot-only keys, and it is
        documented rather than hidden.** `.` is unreserved in RFC 3986, so no
        percent-encoder touches it: `quote("..", safe="")` is still `..`. What
        happens next is a property of the HTTP stack, and the two lanes' stacks
        differ — measured off a socket, not inferred:

        - **this lane** (`urllib`) sends the request line literally, as
          `GET /api/documents/by-key/.. HTTP/1.1`, and the server (or a proxy in
          front of it) decides what that means;
        - the **`node` lane** (`fetch`, WHATWG URL) normalises the path away
          before sending and issues `GET /api/documents/`, i.e. the *list*
          route.

        Neither is wrong and neither is worked around here; the server-side
        resolution is pinned by T4.4.1. If you have a document whose key is
        `"."` or `".."`, address it by its `doc_…` id.

        **`status: "planned"`** — the route lands with T4.4.1; until then a live
        server answers `404`.

        :param key: The document key, sent encoded and otherwise untouched.
        :param project: Project to scope this call to; defaults to the client's.
        :returns: The document.
        :raises ConfigError: When no token is configured.
        :raises ApiError: `404 unknown_document` when there is no such key.
        """
        response = self._host.request(
            "GET",
            path("/documents/by-key/{key}", key=key),
            query={"project": self._project(project)},
        )
        return Doc.from_wire(unwrap_object(response, "document"))

    def create(
        self,
        key: str,
        content: str,
        format: Optional[DocFormat] = None,
        description: Optional[str] = None,
        project: Optional[str] = None,
    ) -> Doc:
        """Create a document under a caller-chosen key.

        Addressed by `key`, because that is how the server addresses a create
        (D6).

        The two optional fields default to `None`, and here `None` means
        **omitted** — not "null". That differs from :meth:`update` on purpose:
        a create has no prior value to preserve, so "leave it alone" and "do not
        send it" are the same request, and the server rejects an explicit null
        for either field anyway (`400 invalid_description`). Where the
        distinction *does* exist — a patch — the signature uses
        :data:`w6w.UNSET`.

        :param key: Non-empty, ≤128 characters, unique per scope + project.
        :param content: Raw text; stored verbatim and never parsed.
        :param format: Format hint; the server defaults it to `"text"`.
        :param description: Free text.
        :param project: Project to scope this call to; defaults to the client's.
        :returns: The created document — the server answers `201`, which is
            success and is not special-cased anywhere.
        :raises ConfigError: When no token is configured.
        :raises ApiError: `409 document_exists` on a duplicate key — the code
            reaches the caller intact, never flattened into a generic error.
        """
        body: Dict[str, Any] = {"key": key, "content": content}
        if format is not None:
            body["format"] = format
        if description is not None:
            body["description"] = description
        response = self._host.request(
            "POST",
            "/documents",
            query={"project": self._project(project)},
            body=body,
        )
        return Doc.from_wire(unwrap_object(response, "document"))

    def update(
        self,
        id: str,
        content: PatchableStr = UNSET,
        format: Union[DocFormat, None, Unset] = UNSET,
        description: PatchableStr = UNSET,
        project: Optional[str] = None,
    ) -> Doc:
        """Patch a document's content, format or description.

        Addressed by id, never by key, and **the key itself cannot be changed**
        — there is no `key` parameter here because there is no `key` in the
        server's PATCH body.

        Each patchable field defaults to :data:`w6w.UNSET`, meaning *not sent*.
        Passing `None` is a different instruction: it sends JSON `null`. The
        server tests `body.field !== undefined`, so the two produce different
        outcomes, and a signature that defaulted them to `None` could only
        express one of the two::

            client.documents.update(id, content="x")          # {"content": "x"}
            client.documents.update(id, description=None)     # {"description": null}
            client.documents.update(id)                       # {}

        (For these three fields the server requires a string, so an explicit
        `null` comes back as `400 invalid_…`. It is still expressible, because a
        wrapper's job is to send what the caller said and let the server own the
        rule.)

        :param id: The `doc_…` id.
        :param content: Replacement content, or `None` for JSON `null`.
        :param format: Replacement format hint, or `None` for JSON `null`.
        :param description: Replacement description, or `None` for JSON `null`.
        :param project: Project to scope this call to; defaults to the client's.
        :returns: The updated document.
        :raises ConfigError: When no token is configured.
        :raises ApiError: `404 unknown_document` when there is no such id.
        """
        response = self._host.request(
            "PATCH",
            path("/documents/{id}", id=id),
            query={"project": self._project(project)},
            body=patch_body(
                {"content": content, "format": format, "description": description},
            ),
        )
        return Doc.from_wire(unwrap_object(response, "document"))

    def delete(self, id: str, project: Optional[str] = None) -> None:
        """Delete a document.

        Returns nothing. The server's `{"ok": true}` carries no information a
        caller can use, and unwrapping it to a value would invite
        `if client.documents.delete(...)` — a condition that is always true and
        means nothing. Deleting an unknown id is `404 unknown_document`, **not**
        a silent success: the delete is not idempotent and this method does not
        pretend otherwise.

        :param id: The `doc_…` id.
        :param project: Project to scope this call to; defaults to the client's.
        :raises ConfigError: When no token is configured.
        :raises ApiError: `404 unknown_document` when there is no such id.
        """
        self._host.request(
            "DELETE",
            path("/documents/{id}", id=id),
            query={"project": self._project(project)},
        )
