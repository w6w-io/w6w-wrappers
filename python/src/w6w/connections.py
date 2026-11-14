"""`client.connections.*` — discovery, one lookup, and delete.

**Three operations**: `list` (how a user *discovers* a `conn_…` URN to hand to
`run`), `get` (one connection by id) and `delete`. Creating, updating, testing
and OAuth-connecting a connection stay `outOfScope` in `endpoints.json`: those
flows are the studio's, they involve an interactive auth handshake, and an SDK
that grew half of one would be a worse version of the thing that already exists.

── What the server does not send ──
The list route returns a **redacted projection**. `credential` (the encrypted
secret) is stripped server-side and never appears on the wire, so
:class:`w6w.ConnectionSummary` does not declare it. That is not caution about
leaking a secret this client never receives; it is about not promising a field
that will never arrive. The keep-alive state (`autoRefresh`, `lastRefreshedAt`,
`refreshFailingSince`) is not secret: since contract 0.19.0 the server sends it
and the summary models it (`None` against an older server).

── Unknown keys ──
The summary models `tenant`, `subject` and the inlined `app`. A key it does not
model is dropped, not rejected: a reader that treated an unmodelled key as an
error would raise on **every real response**, and it would do so on the day the
server adds its next field rather than the day anyone tested it. Unknown keys
are tolerated everywhere in this package (`docs/implementation.md` §5).

── No scope parameter ──
Connections are scoped by tenant/owner — they are user-private, and the route
reads no `?project=`. This namespace is therefore handed the client's bound
`request` method and *nothing else*, the same shape `vars` uses: it **holds** no
configuration, and :class:`ConnectionsRequest` is a bare callable, so a type
checker rejects the day someone widens it to take a client in order to read a
default from one.

That is a narrow host type, **not a capability barrier** — a bound method carries
its instance, so the client (and its `config`) is one hop away from
`self._request`. What holds the line is the type above plus the wire assertion in
`tests/test_discovery.py`: `list` is called with a default project configured and
no query string may appear. A later edit that walked the hop would fail there,
whatever route it took to the value.
"""

from __future__ import annotations

from typing import Any, List, Mapping, Optional, Protocol

from ._http import HttpResponse, path
from .types import ConnectionSummary, unwrap_list, unwrap_object


class ConnectionsRequest(Protocol):
    """The single capability this namespace is given: send one request.

    A callable, not an object with a `request` method — see the module
    docstring. `Client.request` satisfies it as a bound method, and so does a
    three-line fake in a test.
    """

    def __call__(
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


class ConnectionsApi:
    """The `connections` namespace on a `Client`.

    Reached as `client.connections`; never constructed directly by a caller.

    Example::

        live = [c for c in client.connections.list() if c.state == "connected"]
        client.run(live[0].id, action="send_email", payload={"to": "a@b.c"})
    """

    def __init__(self, request: ConnectionsRequest) -> None:
        """Bind the namespace to a transport — and to nothing else.

        :param request: The client's bound `request` method.
        """
        self._request = request

    def list(self) -> List[ConnectionSummary]:
        """List the caller's connections.

        Unpaginated, and this method does not pretend otherwise: there is no
        `cursor` argument and no client-side paging loop. It returns the plain
        list the server sent, unwrapped from the `connections` envelope.

        :returns: The connections, secrets redacted server-side.
        :raises ConfigError: When no token is configured.
        :raises ApiError: On any non-2xx, e.g. `401` when the token is not
            accepted.
        :raises ApiError: `bad_response` when a `2xx` body carries no
            `connections` list.
        """
        response = self._request("GET", "/connections")
        return [ConnectionSummary.from_wire(item) for item in unwrap_list(response, "connections")]

    def get(self, id: str) -> ConnectionSummary:
        """Fetch one connection by id.

        Same redacted projection as :meth:`list`. Account-owned: another
        account's id is the uniform `404 unknown_connection`, indistinguishable
        from an id that does not exist. The built-in zero-credential row that
        :meth:`list` can include (`built_in` is `True`, a `zerocred:` id) is
        synthetic and is not fetchable: `404`.
        The summary's ``accessScope`` is ``"account"`` or ``"user"`` (``None`` on an
        older server); ``subject`` stays creator attribution.

        :param id: The `conn_…` id. Percent-encoded into the path.
        :returns: The connection, unwrapped from the `connection` envelope.
        :raises ConfigError: When no token is configured.
        :raises ApiError: `404 unknown_connection`.
        """
        response = self._request("GET", path("/connections/{id}", id=id))
        return ConnectionSummary.from_wire(unwrap_object(response, "connection"))

    def delete(self, id: str, force: bool = False) -> None:
        """Delete a connection. Returns nothing.

        Keeps the server's authorization: the connection must be owned by the
        caller's account; another account's id is the uniform
        `404 unknown_connection` and destroys nothing, and so is a `zerocred:`
        built-in row. Not idempotent: a second delete is `404`. The server tears
        down every trigger subscription bound to the connection first.

        If callables depend on the connection the server refuses with
        `409 connection_in_use`; the dependents are on
        `err.raw["error"]["dependents"]`. `force=True` sends `?force=true`,
        which deletes anyway and disables (never edits) dependent callables.

        :param id: The `conn_…` id.
        :param force: Delete despite dependents; sent only when true.
        :raises ConfigError: When no token is configured.
        :raises ApiError: `404 unknown_connection`; `409 connection_in_use`.
        """
        self._request(
            "DELETE",
            path("/connections/{id}", id=id),
            query={"force": "true"} if force else None,
        )
