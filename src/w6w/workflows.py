"""`client.workflows.*` — discovery now, the typed run next.

`list` lives here; **`run` lands with T2.3.5** and joins it in this module. `list`
earns its place in a minimal surface for the same reason `connections.list` does
(D4): it is how a caller discovers a `wf_…` id to pass to `run`.

Workflows are **project-scoped**, like documents and unlike vars: the route reads
an optional `?project=`, resolved per call, then from the client's default, and
otherwise left to the server. This namespace therefore sees the client's resolved
configuration — which `connections` and `vars` deliberately do not.

── Pagination ──
The route is **not paginated today** and this module does not pretend otherwise:
no `cursor` argument, no `cursor` field, no client-side paging loop.
:meth:`WorkflowsApi.list` returns the unwrapped list, exactly as
`docs/implementation.md` §6 pins it.

It does not return a container type either, and that is a **cross-lane decision
rather than this lane's preference**. The `node` lane can widen its return to an
array carrying a `cursor` property later, because a JavaScript array is an
object; that trick does not survive `JSON.stringify` and does not translate to a
Python `list` at all, so a container invented here would be a shape the other two
lanes do not have. Three wrappers implement one surface: the day the server grows
a cursor, all three grow the same container together, as a versioned change.
"""

from __future__ import annotations

from typing import Any, List, Mapping, Optional, Protocol

from ._config import ResolvedConfig
from ._http import HttpResponse
from .types import WorkflowSummary, unwrap_list


class WorkflowsHost(Protocol):
    """The slice of `W6wClient` this namespace needs.

    Structural rather than a concrete client type, so the namespace stays
    independently constructible in a test and this module never imports the
    client back (an import cycle as well as a layering inversion).

    Two members, and the second is the asymmetry: `workflows` reads the client's
    resolved configuration because it has a **default project** to apply, the
    same way `documents` does. `connections` and `vars` are handed a transport
    alone.
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


class WorkflowsApi:
    """The `workflows` namespace on a `W6wClient`.

    Reached as `client.workflows`; never constructed directly by a caller.

    Example::

        active = [w for w in client.workflows.list() if w.status == "active"]
    """

    def __init__(self, host: WorkflowsHost) -> None:
        """Bind the namespace to the client it issues requests through.

        :param host: The client. Its transport and its default project are
            read; nothing here is module state.
        """
        self._host = host

    def _project(self, project: Optional[str]) -> Optional[str]:
        """Resolve which project a call is scoped to.

        Per-call argument first, then the client's default, then nothing at all
        — an absent value means **no `?project=` on the wire**, which is how a
        caller asks for every project the credential can see. (The same rule
        `documents.py` applies, deliberately spelled out per namespace rather
        than shared: the two surfaces are asymmetric on scoping and a shared
        helper would be a seam for that asymmetry to leak through.)

        Note that `None` is the *only* absent value. An explicit empty string is
        a value a caller supplied, so it is forwarded as `?project=` — matching
        the `node` lane, whose query builder likewise skips only `undefined`.
        The server reads `c.req.query("project") || undefined`, so an empty one
        means "no filter" there; what matters is that the three lanes put the
        same bytes on the wire.

        Read from the host on every call rather than captured at construction,
        so the namespace and the client can never disagree about which project
        is the default.

        :param project: The per-call argument, if any.
        :returns: The project id to send, or `None` to send none.
        """
        return project if project is not None else self._host.config.project

    def list(self, project: Optional[str] = None) -> List[WorkflowSummary]:
        """List the caller's workflow definitions.

        :param project: Project to scope this call to; defaults to the client's.
        :returns: The workflows, unwrapped from the `workflows` envelope — a
            plain list, with no cursor and no container around it.
        :raises ConfigError: When no token is configured.
        :raises ApiError: On any non-2xx.
        :raises ApiError: `bad_response` when a `2xx` body carries no
            `workflows` list.
        """
        response = self._host.request(
            "GET",
            "/workflows",
            query={"project": self._project(project)},
        )
        return [WorkflowSummary.from_wire(item) for item in unwrap_list(response, "workflows")]
