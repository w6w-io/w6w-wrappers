"""`W6wClient` — the object every operation hangs off.

It holds three things and no behaviour of its own: the resolved configuration,
the transport, and (from T2.3.3 onward) the operation namespaces. All of it is
**instance** state.

That is a mechanism pin, not a style choice (`docs/implementation.md` §2). The
browser client this package transcribes keeps its token in a mutable module
variable, which is fine for one page and an outright bug for a server-side SDK:
two clients in one process would share one credential, so a host juggling
tenants would silently issue requests as whichever tenant constructed a client
last. **Nothing in `src/w6w/` holds mutable module state.**
"""

from __future__ import annotations

from typing import Any, Mapping, Optional

from ._config import ResolvedConfig, resolve_config
from ._http import HttpResponse, Transport, _request, default_transport
from ._vars import VarsApi
from .connections import ConnectionsApi
from .documents import DocumentsApi
from .me import fetch_me
from .types import Me
from .workflows import WorkflowsApi


class W6wClient:
    """A client for the w6w HTTP API.

    Construction resolves configuration once — explicit arguments first, then
    the environment (`W6W_BASE_URL`, `W6W_TOKEN`) — and never consults the
    environment again. A missing base URL raises here; a missing token raises on
    the first request, so a CLI can print `--help` offline.

    Example::

        # From the environment.
        client = W6wClient()

        # Explicit, overriding the environment. Two clients, two credentials,
        # one process — no interference.
        other = W6wClient(base_url="https://api.example.com", token="t_2")

    :ivar config: The resolved base URL, credential and default project.
        Exposed so a host can log *which* server it is talking to without
        re-deriving the join rule. Frozen.
    :ivar transport: The transport this client sends through.
    :ivar documents: The document store — `list`, `get`, `get_by_key`,
        `create`, `update`, `delete`. Project-scoped: every call accepts an
        optional `project` that overrides this client's default.
    :ivar vars: Typed variables — `list`, `get`, `get_by_name`, `create`,
        `update`, `delete`. **No `project` argument anywhere**: variables are
        scoped by tenant/subject only, and the namespace is constructed with
        this client's `request` method and nothing else, so it holds no
        configuration to scope a call with (`docs/implementation.md` §7).
    :ivar connections: Connection discovery — `list` only. Constructed the same
        way as `vars`, for the same reason: connections are user-private and the
        route reads no project.
    :ivar workflows: Workflow discovery — `list`. Project-scoped, so it sees
        this client's configuration.
    """

    def __init__(
        self,
        base_url: Optional[str] = None,
        token: Optional[str] = None,
        project: Optional[str] = None,
        transport: Optional[Transport] = None,
    ) -> None:
        """Build a client.

        :param base_url: The **origin** of the w6w server, e.g.
            `https://api.example.com`. The base path (`/api`) is appended for
            you and is never doubled. Overrides `W6W_BASE_URL`.
        :param token: Bearer token, sent on every request. Overrides
            `W6W_TOKEN`.
        :param project: Default project id for the project-scoped operations
            (`documents.*`). Omitted, the server resolves the account's default
            project. There is no environment variable for it, and no `vars.*`
            operation takes one — vars are not project-scoped
            (`docs/implementation.md` §7).
        :param transport: Transport override, for tests and for hosts with their
            own opener. Defaults to `urllib.request.urlopen`.
        :raises ConfigError: When no base URL is configured, naming
            `W6W_BASE_URL`.
        """
        self.config: ResolvedConfig = resolve_config(
            base_url=base_url,
            token=token,
            project=project,
        )
        self.transport: Transport = default_transport if transport is None else transport

        # Namespaces are per-instance and hold this client (or its bound
        # transport), so they inherit its credential and base URL — never a
        # module-level one. `documents` and `workflows` additionally see the
        # configuration, because they are the project-scoped half of the surface
        # and have a default project to apply; `vars` and `connections` are
        # handed the transport alone, so neither holds a default to send.
        self.documents: DocumentsApi = DocumentsApi(self)
        self.vars: VarsApi = VarsApi(self.request)
        self.connections: ConnectionsApi = ConnectionsApi(self.request)
        self.workflows: WorkflowsApi = WorkflowsApi(self)

    def me(self) -> Me:
        """Fetch the caller's identity, plus the versions that answered.

        A **method on the client**, not a namespace: `endpoints.json` names this
        operation `client.me()`. The implementation lives in `me.py` and this is
        the delegation — same layering as the namespaces, without inventing a
        `client.me.me()`.

        The returned `versions` map always exists and always carries `wrapper`,
        filled from this package's own version as a **default** that any key the
        server supplied overrides.

        Example::

            identity = client.me()
            print(identity.account, identity.versions["wrapper"])

        :returns: The caller's identity and the component versions.
        :raises ConfigError: When no token is configured.
        :raises ApiError: On any non-2xx; `404` against a server that has not
            mounted `/api/me` yet (`status: "planned"`, T4.2.1).
        """
        return fetch_me(self.request)

    def request(
        self,
        method: str,
        path: str,
        query: Optional[Mapping[str, Any]] = None,
        body: Optional[Any] = None,
    ) -> HttpResponse:
        """Perform one request against this client's server, with its credential.

        This is the seam the operation modules are built on. It is public so a
        host can also reach an endpoint this version does not model yet, rather
        than hand-rolling a second client — and it returns the status alongside
        the body, because a `202` is success on this API.

        Build `path` with :func:`w6w.path` whenever any part of it comes from
        the caller; a raw value concatenated into a URL addresses a different
        route than the caller asked for, silently.

        :param method: `GET`, `POST`, `PATCH` or `DELETE`.
        :param path: Base-relative path with a leading slash.
        :param query: Query parameters; `None` values are dropped.
        :param body: Request body, serialised as JSON when not `None`.
        :returns: The status and parsed body.
        :raises ConfigError: When no token is configured, naming `W6W_TOKEN`.
        :raises ApiError: On a transport failure, a non-JSON error body, or an
            error envelope.
        """
        return _request(
            self.config,
            self.transport,
            method,
            path,
            query=query,
            body=body,
        )
