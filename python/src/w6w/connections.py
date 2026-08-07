"""`client.connections.list()` — discovery, and only discovery.

**One operation**, and that is the whole of this module. `connections.list`
earns its place in a minimal surface (D4) because without it a user has no way
to *discover* a `conn_…` URN to hand to `run`. Everything else a connection can
do — create it, rename it, replace its secret, test it, delete it — is
`outOfScope` in `endpoints.json`: those flows are the studio's, they involve an
interactive auth handshake, and an SDK that grew half of one would be a worse
version of the thing that already exists.

── What the server does not send ──
The list route returns a **redacted projection**. `credential` (the encrypted
secret) and `lastRefreshedAt` are stripped server-side and never appear on the
wire, so :class:`w6w.ConnectionSummary` does not declare them. That is not
caution about leaking a secret this client never receives; it is about not
promising a field that will never arrive.

── What the server *does* send that this type omits ──
The server's own summary carries a `tenant` the exposed type deliberately drops.
It is dropped, not rejected: a reader that treated an unmodelled key as an error
would raise on
**every real response**, and it would do so on the day the server adds its next
field rather than the day anyone tested it. Unknown keys are tolerated
everywhere in this package (`docs/implementation.md` §5).

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

from ._http import HttpResponse
from .types import ConnectionSummary, unwrap_list


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
