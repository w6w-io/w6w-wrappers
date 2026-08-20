"""`Client` — the object every operation hangs off.

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

from typing import Any, Dict, Mapping, Optional

from ._config import ResolvedConfig, resolve_config
from ._http import HttpResponse, Transport, _request, default_transport
from ._vars import VarsApi
from .connections import ConnectionsApi
from .documents import DocumentsApi
from .me import fetch_me
from .run import run_urn
from .types import Me, RunEnvelope
from .endpoints import EndpointsApi
from .functions import FunctionsApi
from .workflows import WorkflowsApi


class Client:
    """A client for the w6w HTTP API.

    Construction resolves configuration once — explicit arguments first, then
    the environment (`W6W_BASE_URL`, `W6W_TOKEN`) — and never consults the
    environment again. A missing base URL raises here; a missing token raises on
    the first request, so a CLI can print `--help` offline.

    Example::

        # From the environment.
        client = Client()

        # Explicit, overriding the environment. Two clients, two credentials,
        # one process — no interference.
        other = Client(base_url="https://api.example.com", token="t_2")

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
    :ivar connections: Connection discovery — `list` only. Read-only on
        purpose: creating or testing a connection is an interactive,
        secret-handling flow that `endpoints.json` puts out of scope for this
        version. Constructed the same way as `vars`, for the same reason:
        connections are user-private and the route reads no project.
    :ivar workflows: Workflows — `list` and `run`. `list` is project-scoped and
        accepts an optional `project` that overrides this client's default, so
        the namespace sees this client's configuration; `run` is addressed by
        `wf_…` id and takes `wait`, `variables` and `trigger`.
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
            `https://api.example.com`. The API is served at the root of its own
            host, so **nothing is appended** (`BASE_PATH` is `""` as of contract
            0.2.0); any path in the value is preserved verbatim, because it is
            indistinguishable from a real gateway prefix. Overrides
            `W6W_BASE_URL`.
        :param token: Bearer token, sent on every request. Overrides
            `W6W_TOKEN`.
        :param project: Default project id for the project-scoped operations —
            `documents.*` and `workflows.list`, which reads it too. Omitted, the
            server resolves the account's default project. There is no
            environment variable for it, and no `vars.*` operation takes one —
            vars are not project-scoped (`docs/implementation.md` §7).
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
        #: Run a Function by name: ``functions.run("send-email", payload={...})``.
        #: The name may be the Function's key or its ``fn_…`` id.
        self.functions: FunctionsApi = FunctionsApi(self)
        #: Run an Endpoint by name: ``endpoints.run("send-email", payload={...})``.
        #: Returns the kind-discriminated envelope, since an Endpoint may
        #: dispatch to an action, a Function or a Workflow.
        self.endpoints: EndpointsApi = EndpointsApi(self)

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
        :raises ApiError: On any non-2xx, e.g. `401` when the token is not
            accepted.
        """
        return fetch_me(self.request)

    def run(
        self,
        urn: str,
        action: Optional[str] = None,
        payload: Optional[Dict[str, Any]] = None,
    ) -> RunEnvelope:
        """Run whatever a URN addresses, and get back the kind-tagged envelope.

        A **method on the client**, not a namespace: `endpoints.json` names this
        operation `client.run(urn, …)`. The implementation lives in `run.py` and
        this is the delegation.

        It is the dispatching counterpart to :meth:`WorkflowsApi.run`, which
        stays separate because `?wait=`, `variables` and `trigger` have no slot
        in this three-field shape (D4).

        Discriminate the result with :func:`w6w.is_action_run` /
        :func:`w6w.is_function_run` / :func:`w6w.is_workflow_run`; a `kind` this
        version has never heard of is handed back verbatim rather than raised.

        Example::

            env = client.run("conn_01H", action="send_email", payload={"to": "a@b.c"})
            if w6w.is_action_run(env):
                print(env["value"])

        :param urn: What to run: `conn_…`, `wf_…`, `fn_…` or `ep_…`.
        :param action: Which action to invoke; omitted from the body when
            `None`. Required in practice only for a `conn_…` URN.
        :param payload: Input to the run; defaults to `{}`.
        :returns: The `RunEnvelope`, exactly as it arrived.
        :raises ConfigError: When no token is configured.
        :raises ApiError: On any non-2xx, e.g. `404` for an unresolvable URN or
            `424` when the target app failed during execute.
        """
        return run_urn(self.request, urn, action=action, payload=payload)

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
