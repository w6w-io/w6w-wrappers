"""`client.run(urn, action=..., payload=...)` — run anything a URN addresses.

One POST, one kind-tagged body, no envelope key. The URN resolves over the four
runnable arms — `conn_…`, `wf_…`, `fn_…`, `ep_…` (D16) — and the answer says
which one it hit:

===============  ====================  ======
`kind`           Field                 HTTP
===============  ====================  ======
`"action"`       `value`               200
`"function"`     `output`              200
`"workflow"`     `runId` + `status`    202
===============  ====================  ======

`value` and `output` were **deliberately different names** and `value` is never
removed: the discrimination is the whole point of the operation (D3). `202` on
the workflow arm is **success** — the run is queued and `runId` is how the
caller follows it.

── The invocation frame ──
Since 2026-08-20 every arm also carries the platform's own record of the
attempt — `invocationId` (an `inv_…` id), `status`, `startedAt`, `finishedAt`,
`durationMs` — and the action arm carries `output` beside `value`, with the
identical payload. All of it is additive, and this lane carries it for free:
the envelope is the parsed body itself, so new keys arrive verbatim. `status`
is the **platform's** verdict on the call (`succeeded`/`failed`/`queued`), not
a status the target reported inside its own payload; `invocationId` names this
call, `runId` names the queued workflow run a call may have started.

── The unknown fourth kind ──
A `kind` this release has never heard of is **returned verbatim**, never raised
(`docs/implementation.md` §5). `run` dispatches on whatever a URN resolves to,
and the server can grow a new kind before the wrappers do — a purely additive
change. Raising would turn that into a hard breakage for every installed client
on the one operation whose entire job is dispatch, and would leave the caller
with an exception instead of a payload this module had already parsed and held.

That is also why this operation returns the parsed body itself rather than a
dataclass: everywhere else in this package a dataclass drops the keys it does
not model, and here those keys are precisely what the open arm exists to keep.
Callers discriminate with :func:`w6w.is_action_run`, :func:`w6w.is_function_run`
and :func:`w6w.is_workflow_run`.

── Why this is not folded into `workflows.run` ──
D4: `?wait=`, `variables` and `trigger` have no slot in the three-field
`{urn, action, payload}` shape, and a workflow has no `action`. The two
operations ship side by side — this one dispatches, `workflows.run` is the typed
path.

Like `me`, this is a function over a narrow request seam rather than a namespace
class, because `endpoints.json` names the symbol `client.run(urn, …)` — a method
on the client itself, not a `client.run.run()`.
"""

from __future__ import annotations

from typing import Any, Dict, Mapping, Optional, Protocol

from ._http import HttpResponse
from .errors import ApiError
from .types import RunEnvelope


class RunRequest(Protocol):
    """The single capability this operation is given: send one request.

    A callable rather than an object with a `request` method, for the same
    reason `vars` takes one: there is nothing else this operation may reach.
    `Client.request` satisfies it as a bound method, and so does a three-line
    fake in a test.
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


def run_urn(
    request: RunRequest,
    urn: str,
    action: Optional[str] = None,
    payload: Optional[Dict[str, Any]] = None,
) -> RunEnvelope:
    """Run whatever a URN addresses.

    Reached as `client.run(...)`; this function is the implementation the client
    delegates to.

    All three fields travel in the **request body**, so none of them is
    percent-encoded: `/run` is a fixed path with no interpolation, and a URN in
    JSON needs no escaping. (:func:`w6w.path` is for path segments —
    `workflows.run` uses it for its `wf_…` id.)

    :param request: The client's bound `request` method.
    :param urn: What to run: `conn_…`, `wf_…`, `fn_…` or `ep_…`.
    :param action: Which action to invoke. Optional, because a workflow,
        function or endpoint URN has no action; required in practice for a
        `conn_…` URN, and the server is what says so — this client does not
        second-guess the URN's arm. Omitted from the body entirely when `None`.
    :param payload: Input to the run. Defaults to `{}` rather than being
        omitted: the server's parameter schemas are written against an object,
        and `{}` says "no input" where an absent key says "I forgot".
    :returns: The kind-tagged envelope, with `kind` and the arm's field
        verbatim — including the sibling fields of a `kind` this release does
        not know.
    :raises ConfigError: When no token is configured.
    :raises ApiError: On any non-2xx — `404` for an unresolvable URN, `424` when
        the app or its upstream vendor failed during execute (a 4xx on purpose,
        so Cloudflare cannot swallow the message; never normalised into a
        transport error).
    :raises ApiError: `bad_response` when a success body carries no `kind` at
        all — that is a malformed dispatch response, not a new arm, and it is
        the one shape a caller cannot do anything with.
    """
    body: Dict[str, Any] = {"urn": urn}
    if action is not None:
        body["action"] = action
    body["payload"] = payload if payload is not None else {}

    response = request("POST", "/run", body=body)

    parsed = response.body
    if not isinstance(parsed, dict) or not isinstance(parsed.get("kind"), str):
        raise ApiError(
            response.status,
            "bad_response",
            'Server returned a {status} with no "kind" in the response body.'.format(
                status=response.status,
            ),
            parsed,
        )
    # Returned as it arrived — no rebuild, no field renaming, no per-arm
    # transcription. An unknown `kind` therefore reaches the caller with every
    # sibling field intact.
    return parsed
