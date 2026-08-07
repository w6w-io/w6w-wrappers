"""`client.workflows.*` — discovery and the typed run.

Two operations: `list` and `run`. `list` earns its place in a minimal surface for
the same reason `connections.list` does (D4): it is how a caller discovers a
`wf_…` id to pass to `run`.

── `run`, and the three things this API gets called wrong ──
1. **`202` is success.** No `wait` → the run is queued and the server answers
   `202 {runId, status:"queued"}`. With `?wait=true` and a timeout → `202` again,
   with the current status. Neither raises.
2. **A failed run is data.** `?wait=true` on a run that failed is a plain `200`
   carrying `status: "failed"` and an `error`. This module returns it like any
   other result. Mapping it to an exit code is the CLI's job (`cli.exitCodes` in
   `endpoints.json`), not the SDK's.
3. **No client-side polling.** The server already polls internally for
   `?wait=true`, up to its own `RUN_WAIT_TIMEOUT_SEC`. The studio's 600 × 500 ms
   browser loop predates that and is deliberately **not** transcribed
   (`docs/implementation.md` §4): three wrappers each re-implementing a poll
   would be three timeout policies and three retry-storm bugs to keep in sync.
   There is no timer, no sleep and no retry anywhere in this package — a `202`
   hands the caller `runId` and lets them decide.

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

from typing import Any, Dict, List, Mapping, Optional, Protocol

from ._config import ResolvedConfig
from ._http import HttpResponse, path
from .errors import ApiError
from .types import WorkflowRunResult, WorkflowSummary, require_object, unwrap_list


class WorkflowsHost(Protocol):
    """The slice of `Client` this namespace needs.

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
    """The `workflows` namespace on a `Client`.

    Reached as `client.workflows`; never constructed directly by a caller.

    Example::

        active = [w for w in client.workflows.list() if w.status == "active"]

        run = client.workflows.run(active[0].id, wait=True)
        if run.status == "failed":
            print(run.error)  # data, not an exception
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

    def run(
        self,
        id: str,
        wait: bool = False,
        variables: Optional[Mapping[str, Any]] = None,
        trigger: Optional[str] = None,
        input: Optional[Mapping[str, Any]] = None,
    ) -> WorkflowRunResult:
        """Start a run of one workflow, optionally waiting for it to finish.

        Returns on **both** success statuses this route uses:

        ==========================  ======  ==================================  ==========
        Call                        HTTP    Body                                `terminal`
        ==========================  ======  ==================================  ==========
        no `wait`                   `202`   `{runId, status:"queued"}`          `False`
        `wait=True`, finished       `200`   `{runId, status, output, error, …}` `True`
        `wait=True`, timed out      `202`   `{runId, status}`                   `False`
        ==========================  ======  ==================================  ==========

        **A run that failed is the second row, not an error**: `200` with
        `status: "failed"` and the failure in `error`. This method returns it. It
        raises only when the *request* failed — `404 unknown_workflow`, a
        rejected token, a transport failure.

        There is **no `project` argument**, on purpose: a `wf_…` id is
        unambiguous on its own, and `endpoints.json` gives this operation exactly
        five parameters. Sending a `?project=` the route does not read would be
        inventing one.

        :param id: The `wf_…` id, percent-encoded into the path by
            :func:`w6w.path`.
        :param wait: Wait for the run to reach a terminal state before
            answering. Sent as `?wait=true` **only when true**: the server
            compares the raw query value to the string `"true"`, so `?wait=false`
            would mean the same thing as omitting it while looking like it meant
            something else. The wait happens **server-side**, bounded by the
            server's own timeout.
        :param variables: Variables handed to the run, merged into its scope by
            the engine. Opaque pass-through. Read downstream as `vars.*` —
            **not** the slot that reaches a trigger's declared fields.
        :param trigger: What triggered the run; defaults to `"manual"`
            server-side. A plain string rather than a closed enum: the value is a
            server-owned set (`manual`, `schedule`, `webhook`, `event`, `replay`
            today) that the server may extend, and a wrapper that froze it would
            reject a value a newer server accepts.
        :param input: Delivered to the entry trigger node's own recorded output,
            read downstream as `steps.<triggerId>.output.<key>` — the shape a
            trigger's declared fields actually arrive in. Not the same slot as
            `variables`.
        :returns: The run handle, its status, and the result when the run has
            one.
        :raises ConfigError: When no token is configured.
        :raises ApiError: `404 unknown_workflow` when there is no such workflow.
        :raises ApiError: `bad_response` when a success body is not a run object.
        """
        response = self._host.request(
            "POST",
            path("/workflows/{id}/run", id=id),
            # `?wait=true` or no `wait` at all — never `?wait=false`, which the
            # server reads as "no wait" anyway and which would misrepresent the
            # request in a log or a proxy.
            query={"wait": True} if wait else None,
            # Always a body, even when empty: the route parses one when the text
            # is non-empty and defaults to `{}` otherwise, so `{}` and no body
            # are the same request — and sending the object keeps the three
            # optional fields in one place instead of behind a conditional.
            body=_run_body(variables, trigger, input),
        )

        # The `runId` and `status` checks are the guard, not decoration. An
        # object-only check let `{}`, `{"ok": true}` and `{"runId": 42}` through
        # and returned a result whose `runId: str` and `status: RunStatus` were
        # **not strings at runtime** — a lie the annotations cannot catch, which
        # becomes an error somewhere in the caller minutes later. That is the
        # failure this package's own `unwrap` exists to prevent, and it makes
        # this guard exactly as strict as its sibling in `run.py`, which requires
        # a string `kind`: two operations in one package must not disagree about
        # what a malformed success body is.
        body = require_object(response, "a run object")
        if not isinstance(body.get("runId"), str) or not isinstance(body.get("status"), str):
            raise ApiError(
                response.status,
                "bad_response",
                "Server returned a {status} whose body is not a run object.".format(
                    status=response.status,
                ),
                body,
            )
        return WorkflowRunResult.from_wire(body, response.status)


def _run_body(
    variables: Optional[Mapping[str, Any]],
    trigger: Optional[str],
    input: Optional[Mapping[str, Any]] = None,
) -> Dict[str, Any]:
    """Assemble the request body of a run, dropping what was not supplied.

    `None` means *omitted* for all three fields, not JSON `null`: none has a
    prior value to preserve (this is a trigger, not a patch), the server
    defaults `trigger` itself, and a `null` would be a value the route would
    have to reject. The omit-vs-null distinction that :data:`w6w.UNSET` exists
    for belongs to the PATCH operations.

    :param variables: Run variables, if any.
    :param trigger: Trigger name, if any.
    :param input: Run input delivered to the entry trigger node, if any.
    :returns: The body — `{}` when the caller supplied none of the three.
    """
    body: Dict[str, Any] = {}
    if variables is not None:
        body["variables"] = dict(variables)
    if trigger is not None:
        body["trigger"] = trigger
    if input is not None:
        body["input"] = dict(input)
    return body
