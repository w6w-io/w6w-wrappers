"""Wire types, transcribed — plus the envelope reader and the omit sentinel.

The shapes below are **transcribed** from `docs/implementation.md` §5 (which
reads them off the studio's API types), not imported or vendored from it: this
package publishes to PyPI and cannot depend on a private workspace source.
Field names are the wire's, **verbatim** — `createdAt`, not `created_at`. §5
pins that explicitly: Python uses `snake_case` only where the wire field is
already `snake_case`, and it is not. A client that quietly renames a wire field
makes every error message, every server log line and every documentation example
wrong for the person reading them side by side.

Three things live here beyond the dataclasses, and each is here because it must
have exactly one implementation shared by every operation module:

- :func:`unwrap` (with :func:`unwrap_object` / :func:`unwrap_list`) — the one
  place an operation reads the server's envelope, and the one place a
  `bad_response` is raised for a `2xx` that does not carry what it promised.
  :func:`require_object` is its counterpart for the two routes that have **no**
  envelope (`me`, `workflows.run`): same failure class, same code, one
  implementation.
- :data:`UNSET` — the sentinel that lets a patch express "leave this field
  alone" **separately** from "set this field to null". `None` cannot express
  both, and conflating them silently nulls data.
- `from_wire` on each dataclass — the tolerant reader. §5: build the dataclass
  from the known keys and **ignore the rest**; never `**body` into a constructor
  with fixed parameters, because a field the server adds tomorrow would raise
  `TypeError` in every installed client.

Unknown fields are therefore **tolerated, never rejected** — but note the
consequence, since it is a real difference from the `node` lane: there, `Doc` is
an interface over the parsed JSON object, so an unmodelled field is still
present at runtime; here the dataclass keeps the seven pinned fields and drops
the rest. That is the pinned Python behaviour (§5), and a caller who needs a
field this release has not learned yet reaches it through `client.request`,
which returns the parsed body untouched.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Literal, Mapping, Optional, Union
from uuid import uuid4

from ._http import HttpResponse
from .errors import ApiError


class Unset:
    """The type of :data:`UNSET`. A singleton; never instantiate it yourself.

    It exists because Python has one "absent" value and this API needs two.
    `PATCH /vars/{id}` distinguishes a body of `{}` (leave `value` as it is)
    from a body of `{"value": null}` (set `value` to null) — the server tests
    `body.value !== undefined`, so JSON `null` is a *present* value with
    meaning. A signature spelled `value=None` collapses those two intents into
    one, and the collapse is silent and destructive in exactly one direction:
    "don't touch this field" becomes "null this field".

    So the default is :data:`UNSET` (send nothing) and `None` is an ordinary
    value that goes on the wire as JSON `null`.

    **Test it with `is`, never with truthiness.** It is falsy — like `attrs`'
    `NOTHING`, and for the same reason: a sentinel that reads as true in an
    `if` is a worse trap than one that reads as false. But `if value:` is wrong
    for it either way, because `0`, `""` and `False` are all legitimate values a
    caller may be patching in. Only `value is UNSET` asks the right question.
    """

    _instance: Optional["Unset"] = None

    def __new__(cls) -> "Unset":
        """Return the one instance, so `is` comparisons hold everywhere.

        :returns: The singleton.
        """
        if cls._instance is None:
            cls._instance = super().__new__(cls)
        return cls._instance

    def __repr__(self) -> str:
        """Render as `UNSET`, so a repr of a patch dict reads plainly.

        :returns: `"UNSET"`.
        """
        return "UNSET"

    def __bool__(self) -> bool:
        """Always falsy.

        :returns: `False`.
        """
        return False


#: The "this field was not supplied" sentinel — see :class:`Unset`.
#:
#: Exported from the package barrel because a caller assembling a patch
#: programmatically needs to name it::
#:
#:     client.vars.update(var_id, value=new_value if changed else UNSET)
UNSET: Unset = Unset()

#: A patchable `str` field: the value, an explicit `None` (JSON `null`), or
#: :data:`UNSET` (send nothing).
#:
#: There is deliberately no `PatchableAny` companion for the untyped fields:
#: `Union[Any, Unset]` collapses to `Any`, so it would document nothing while
#: looking as if it documented something. Those parameters are annotated `Any`
#: and default to :data:`UNSET`.
PatchableStr = Union[str, None, Unset]


def patch_body(fields: Mapping[str, Any]) -> Dict[str, Any]:
    """Drop the :data:`UNSET` entries of a patch, keeping every other value.

    This is the whole omit-vs-null mechanism, in one line and in one place::

        patch_body({"content": "x", "description": UNSET})  # -> {"content": "x"}
        patch_body({"description": None})                   # -> {"description": None}
        patch_body({"content": UNSET})                      # -> {}

    `None` is deliberately **kept**: `json.dumps` renders it as `null`, which is
    a value the server reads as present. Contrast `json.dumps` in JavaScript,
    where `undefined` members vanish on their own — Python has no such value, so
    the dropping has to be explicit, and it has to happen before serialisation
    rather than inside it.

    Insertion order is preserved, so the body a test asserts on is the body the
    signature reads left to right.

    :param fields: Field name to value, some of which may be :data:`UNSET`.
    :returns: A new dict without the :data:`UNSET` entries.
    """
    return {name: value for name, value in fields.items() if value is not UNSET}


def unwrap(response: HttpResponse, key: str) -> Any:
    """Read one payload out of the server's envelope, or fail loudly.

    The server wraps every asset body under a key — `{documents: […]}`,
    `{document: …}`, `{vars: […]}`, `{var: …}` — and the wrapper's contract is
    to hand the caller the payload, never the wrapper
    (`docs/implementation.md` §6). A caller never sees `{"documents": …}`.

    A `2xx` body **missing** that key raises an :class:`ApiError` with code
    `"bad_response"` rather than returning `None`. That is pinned across all
    three lanes, and the reason belongs next to the code: three wrappers each
    returning a silent `None` here would turn a server regression into an
    `AttributeError` somewhere in the caller's own code, minutes later, with
    nothing pointing back at the response that caused it.

    `"bad_response"` stays distinct from `"error"`. `"error"` is a **non-2xx**
    whose body carried no usable envelope (`_http._request`, failure mode 3);
    `"bad_response"` is *the server said yes and then did not send what it
    promised*. A caller triaging by code can tell "my request was rejected" from
    "this server is broken" only while the two stay apart.

    This is the *only* place an operation module inspects a body's shape, and it
    is not schema validation: extra keys are ignored and the payload itself is
    handed back untouched.

    :param response: The response the transport returned.
    :param key: The envelope key to read, e.g. `"document"`, `"vars"`.
    :returns: The unwrapped payload, exactly as it arrived.
    :raises ApiError: `bad_response` when the body is not an object or lacks the key.
    """
    body = response.body
    if isinstance(body, dict) and key in body:
        return body[key]
    raise ApiError(
        response.status,
        "bad_response",
        'Server returned a {status} with no "{key}" in the response body.'.format(
            status=response.status,
            key=key,
        ),
        body,
    )


def unwrap_object(response: HttpResponse, key: str) -> Dict[str, Any]:
    """Read a single-item envelope, e.g. `{"document": {...}}`.

    A key present but carrying something other than an object — `null`, a
    string, a list — is a `bad_response` for the same reason a missing key is:
    the next thing that happens either way is an attribute error in someone
    else's code. (The `node` lane's `unwrap` checks only `!== undefined` and
    would pass a `null` through; this lane stops it here, where the status is
    still in hand to report.)

    :param response: The response the transport returned.
    :param key: The envelope key, e.g. `"document"`, `"var"`.
    :returns: The payload object.
    :raises ApiError: `bad_response` when the key is missing or is not an object.
    """
    payload = unwrap(response, key)
    if not isinstance(payload, dict):
        raise ApiError(
            response.status,
            "bad_response",
            'Server returned a {status} whose "{key}" is {kind}, not an object.'.format(
                status=response.status,
                key=key,
                kind=type(payload).__name__,
            ),
            response.body,
        )
    return payload


def unwrap_list(response: HttpResponse, key: str) -> List[Any]:
    """Read a list envelope, e.g. `{"documents": [...]}`.

    :param response: The response the transport returned.
    :param key: The envelope key, e.g. `"documents"`, `"vars"`.
    :returns: The payload list.
    :raises ApiError: `bad_response` when the key is missing or is not a list.
    """
    payload = unwrap(response, key)
    if not isinstance(payload, list):
        raise ApiError(
            response.status,
            "bad_response",
            'Server returned a {status} whose "{key}" is {kind}, not a list.'.format(
                status=response.status,
                key=key,
                kind=type(payload).__name__,
            ),
            response.body,
        )
    return payload


def require_object(response: HttpResponse, what: str) -> Dict[str, Any]:
    """Read a **flat**, envelope-less `2xx` body, or fail the same way.

    Two routes have no envelope key at all — `me` and `workflows.run` — so
    :func:`unwrap` has nothing to unwrap for them. What they
    still need is the *other* half of what `unwrap` does: the assertion that a
    `2xx` body is the kind of thing it promised to be, reported as
    `bad_response` while the status is still in hand.

    A body that is not an object cannot be identity or run data, and the
    degenerate alternative is not hypothetical — it is **measured**. In the
    `node` lane a `200 []` spread into an object produced a `Me` whose only
    populated field was the one the client had just added, and `200 [{…}]`
    produced character-indexed keys (`evals/T2.1.4.eval.md`). Python's
    `isinstance(body, dict)` excludes a list for free; this function is where
    that check is spent once rather than at each call site, so all three lanes
    raise on the same input.

    :param response: The response the transport returned.
    :param what: What the body was expected to be, for the message — e.g.
        `"an identity object"`.
    :returns: The body, as a mapping.
    :raises ApiError: `bad_response` when the body is not a JSON object.
    """
    body = response.body
    if isinstance(body, dict):
        return body
    raise ApiError(
        response.status,
        "bad_response",
        "Server returned a {status} whose body is not {what}.".format(
            status=response.status,
            what=what,
        ),
        body,
    )


def _text(body: Any, key: str) -> str:
    """Read a string field off a wire object, tolerating absence and wrong types.

    Returns `""` rather than raising, and rather than `str()`-coercing (which
    would turn a missing field into the literal `"None"`). A wrapper is a
    transport: a server that stops sending a documented field is a server bug,
    but raising here would convert it into an outage for every installed client,
    on every call, including the ones whose fields all arrived.

    :param body: The wire object, or anything else.
    :param key: The field to read.
    :returns: The string value, or `""`.
    """
    value = body.get(key) if isinstance(body, dict) else None
    return value if isinstance(value, str) else ""


def _nullable_text(body: Any, key: str) -> Optional[str]:
    """Read a **nullable** string field, keeping `null` distinct from `""`.

    The counterpart to :func:`_text`, and the difference is the whole point: a
    field the wire declares as `string | null` carries meaning in its `null`.
    `lastTestedAt: null` means *never tested*, which is not the same statement
    as "tested, and the timestamp was empty" — so it stays `None` here rather
    than being flattened to `""` the way a non-nullable field is.

    :param body: The wire object, or anything else.
    :param key: The field to read.
    :returns: The string value, or `None`.
    """
    value = body.get(key) if isinstance(body, dict) else None
    return value if isinstance(value, str) else None


def _nullable_flag(body: Any, key: str) -> Optional[bool]:
    """Read a `boolean | null` field, keeping all three states apart.

    `True`, `False` and `None` are three different answers to "did the last test
    pass?", and the third one (*never tested*) must not collapse into the second.

    :param body: The wire object, or anything else.
    :param key: The field to read.
    :returns: The boolean value, or `None` for absent/null/not-a-boolean.
    """
    value = body.get(key) if isinstance(body, dict) else None
    return value if isinstance(value, bool) else None


def _count(body: Any, key: str) -> int:
    """Read an integer counter, defaulting to `0`.

    `isinstance(value, bool)` is excluded deliberately: `bool` is a subclass of
    `int` in Python, so a wire `true` would otherwise arrive as the count `1`.

    :param body: The wire object, or anything else.
    :param key: The field to read.
    :returns: The integer value, or `0`.
    """
    value = body.get(key) if isinstance(body, dict) else None
    return value if isinstance(value, int) and not isinstance(value, bool) else 0


def _text_list(body: Any, key: str) -> List[str]:
    """Read a list-of-strings field, defaulting to `[]`.

    Absent reads as empty rather than as `None`, so a caller iterating tags
    never has to branch on whether the server sent the field — the same reason
    an empty list result is `[]` and not `null`.

    :param body: The wire object, or anything else.
    :param key: The field to read.
    :returns: The string items, in order; non-string items are dropped.
    """
    value = body.get(key) if isinstance(body, dict) else None
    if not isinstance(value, list):
        return []
    return [item for item in value if isinstance(item, str)]


def _mapping(body: Any, key: str) -> Dict[str, Any]:
    """Read an opaque object field, defaulting to `{}`.

    The values are **pass-through** and stay `Any`: `profile` is free-form
    metadata an app's auth wrote, and a wrapper that modelled its internals
    would be wrong for someone. A copy is returned, so a caller mutating it
    cannot reach back into the parsed response body.

    :param body: The wire object, or anything else.
    :param key: The field to read.
    :returns: A shallow copy of the mapping, or `{}`.
    """
    value = body.get(key) if isinstance(body, dict) else None
    return dict(value) if isinstance(value, dict) else {}


#: A document's format hint.
#:
#: A **hint only**: it does not gate the content, which the server stores
#: verbatim and never parses. A create that omits it gets `"text"` server-side.
DocFormat = Literal["text", "markdown", "yaml", "html", "json"]

#: A variable's declared type. `value` is validated against it **server-side**.
VarType = Literal["string", "number", "boolean", "json"]


@dataclass(frozen=True)
class Doc:
    """A document — a keyed blob of text in the document store.

    `id` is the server-issued `doc_…` handle that addresses update and delete;
    `key` is the human-chosen name used at create time (and by
    `documents.get_by_key`). **`key` is immutable** — it appears in no patch
    body (`docs/implementation.md` §7).

    Timestamps are ISO-8601 **strings**, exactly as they arrive. They are not
    parsed into `datetime`: date parsing is a policy that would have to be
    identical in three languages and reversible for round-trips, so the wrappers
    adopt it together or not at all.

    Frozen, because a document instance is a snapshot of a response — mutating
    one changes nothing server-side, and a mutable copy invites code that
    believes otherwise.
    """

    #: Server-issued id, `doc_…`. Addresses update and delete.
    id: str
    #: Caller-chosen key: non-empty, ≤128 characters, unique per scope + project.
    key: str
    #: Raw text. Stored verbatim and never parsed by the server.
    content: str
    #: Format hint.
    format: DocFormat
    #: Free-text description; `""` when unset.
    description: str
    #: ISO-8601 timestamp. A string, deliberately.
    createdAt: str
    #: ISO-8601 timestamp. A string, deliberately.
    updatedAt: str

    @classmethod
    def from_wire(cls, body: Any) -> "Doc":
        """Build a :class:`Doc` from a parsed wire object, ignoring unknown keys.

        Field by field rather than `cls(**body)`: a key the server adds
        tomorrow must be ignored, not raised on (`docs/implementation.md` §5).

        :param body: The parsed `document` payload.
        :returns: The document.
        """
        raw_format = body.get("format") if isinstance(body, dict) else None
        return cls(
            id=_text(body, "id"),
            key=_text(body, "key"),
            content=_text(body, "content"),
            # The server defaults an omitted format to "text"; mirroring that
            # default is the one place this class fills a gap, and it fills it
            # with the server's own answer rather than an invented one.
            format=raw_format if isinstance(raw_format, str) else "text",  # type: ignore[arg-type]
            description=_text(body, "description"),
            createdAt=_text(body, "createdAt"),
            updatedAt=_text(body, "updatedAt"),
        )


@dataclass(frozen=True)
class Var:
    """A typed variable, scoped by tenant/subject.

    `value` is **`Any`** on purpose: it is whatever the declared
    :data:`VarType` allows, including an arbitrary JSON document, and a wrapper
    that modelled its internals would be wrong for someone. Narrow it at the
    call site after checking `type`.

    `name` is immutable and appears in no patch body; `id` (`var_…`) addresses
    update and delete.
    """

    #: Server-issued id, `var_…`. Addresses update and delete.
    id: str
    #: Caller-chosen name, matching `^[a-z_][a-z0-9_]*$`. Immutable.
    name: str
    #: Declared type.
    type: VarType
    #: The value; opaque pass-through, and `None` is a legitimate one.
    value: Any
    #: Free-text description; `""` when unset.
    description: str
    #: ISO-8601 timestamp. A string, deliberately.
    createdAt: str
    #: ISO-8601 timestamp. A string, deliberately.
    updatedAt: str

    @classmethod
    def from_wire(cls, body: Any) -> "Var":
        """Build a :class:`Var` from a parsed wire object, ignoring unknown keys.

        :param body: The parsed `var` payload.
        :returns: The variable.
        """
        raw_type = body.get("type") if isinstance(body, dict) else None
        return cls(
            id=_text(body, "id"),
            name=_text(body, "name"),
            # No default is invented: an absent type reads as "string", the
            # server's own first type, and the value is passed through whatever
            # it was.
            type=raw_type if isinstance(raw_type, str) else "string",  # type: ignore[arg-type]
            value=body.get("value") if isinstance(body, dict) else None,
            description=_text(body, "description"),
            createdAt=_text(body, "createdAt"),
            updatedAt=_text(body, "updatedAt"),
        )


@dataclass(frozen=True)
class Me:
    """Who the caller is, plus the versions of the components that answered.

    **The body is flat.** There is no wrapping object around the four identity
    fields and this class does not add one: the operation calls the host's own
    `/auth/me` handler, whose live consumer is the studio, so a nested
    `{"user": {…}}` shape would need a second handler on the server or would
    break that consumer. The four fields mirror the server's `Principal`
    exactly.

    `versions` is a **string→string map that is open by construction**: it may
    be absent from the wire entirely (an older server), and it may carry keys
    this release has never heard of. Modelled as a `Dict[str, str]` rather than
    a closed record for that reason — adding a key server-side must never break
    an installed client.

    Two keys are contracted today. `composition` is a build string the server
    derives at build time. `wrapper` is filled in by :func:`w6w.fetch_me` from
    this package's own version, because the server cannot know it — as a
    **default that the server overrides**, never as an overwrite (the precedence
    rule lives at that call site, with the merge that implements it).

    What this class does **not** do is edit the map. A value that looks like an
    unbumped placeholder reaches the caller exactly as the server sent it;
    presenting such a value as `dev` is a *rendering* rule (D5) that belongs to
    whatever puts a version in front of a person — the CLI's `w6w info` banner —
    and applying it to the data here would leave a bug report quoting a version
    the server never sent.
    """

    #: The tenant the credential resolves to.
    tenant: str
    #: The authenticated principal, e.g. `user_…`.
    subject: str
    #: The account within the tenant.
    account: str
    #: The principal's role, e.g. `"admin"`. A plain string: the set is the
    #: server's to extend, and a closed union would reject a newer role.
    role: str
    #: Component versions. Always present on a :func:`w6w.fetch_me` result, and
    #: always carrying `wrapper`; open to keys this release does not know.
    versions: Dict[str, str] = field(default_factory=dict)

    @classmethod
    def from_wire(cls, body: Any) -> "Me":
        """Build a :class:`Me` from a parsed wire object, ignoring unknown keys.

        `versions` is **copied** rather than aliased, so the merge that follows
        (and any caller mutation) cannot reach back into the parsed body. A
        `versions` that is not an object — a string, a list, `null` — is dropped
        rather than merged, matching the `node` lane: spreading a string there
        produced character-indexed junk that satisfied the declared type, and
        inventing keys out of a malformed block would be worse than reporting
        only what this client actually knows.

        :param body: The parsed, flat `me` body.
        :returns: The identity, with `versions` exactly as it arrived.
        """
        raw = body.get("versions") if isinstance(body, dict) else None
        return cls(
            tenant=_text(body, "tenant"),
            subject=_text(body, "subject"),
            account=_text(body, "account"),
            role=_text(body, "role"),
            versions=dict(raw) if isinstance(raw, dict) else {},
        )


#: The lifecycle state of a connection.
#:
#: `pending` is the state a connection is in before an auth flow completes;
#: `needs_refresh`, `broken` and `revoked` are the three ways a live one stops
#: working, and they are kept apart because a caller triaging them acts
#: differently on each.
ConnectionState = Literal["pending", "connected", "needs_refresh", "broken", "revoked"]


@dataclass(frozen=True)
class ConnectionSummary:
    """One connection, as the list route projects it.

    This is the server's **redacted projection**: the stored connection minus
    the two secret-bearing fields it strips on the way out (named, with the
    reason, in `connections.py`). Those two are deliberately absent from this
    class rather than typed as optional — declaring a field that never arrives
    invites a caller to look for it, and no response will ever carry it.

    The wire additionally carries a field this class deliberately omits, and
    that is a *tolerance* requirement rather than an oversight: the server's own
    summary type has a `tenant` the exposed surface does not, so a reader that
    refused unknown keys would raise on **every real response**. Unknown keys
    are dropped here, never fatal.

    Timestamps are ISO-8601 strings, exactly as they arrive; `lastTestedAt` and
    `lastTestOk` are additionally **nullable**, and their `None` means *never
    tested* — a distinct answer that is not flattened into `""` or `False`.
    """

    #: Server-issued id, `conn_…`. This is the URN a caller hands to `run`.
    id: str
    #: The app this connection authorizes against, e.g. `"sendgrid"`.
    appId: str
    #: Which of the app's auth methods this connection was made with.
    authKey: str
    #: The principal that owns it. Connections are user-private.
    owner: str
    #: Human-chosen label.
    displayName: str
    #: Lifecycle state.
    state: ConnectionState
    #: Free-form metadata an app's auth wrote. Opaque pass-through.
    profile: Dict[str, Any]
    #: Result of the last test: `True`/`False`, or `None` for never tested.
    lastTestOk: Optional[bool]
    #: ISO-8601 timestamp, or `None` for never tested.
    lastTestedAt: Optional[str]
    #: ISO-8601 timestamp. A string, deliberately.
    createdAt: str
    #: ISO-8601 timestamp. A string, deliberately.
    updatedAt: str

    @classmethod
    def from_wire(cls, body: Any) -> "ConnectionSummary":
        """Build a :class:`ConnectionSummary`, ignoring unknown keys.

        :param body: One parsed item of the `connections` array.
        :returns: The connection summary.
        """
        raw_state = body.get("state") if isinstance(body, dict) else None
        return cls(
            id=_text(body, "id"),
            appId=_text(body, "appId"),
            authKey=_text(body, "authKey"),
            owner=_text(body, "owner"),
            displayName=_text(body, "displayName"),
            # An absent state reads as `pending`, the one member that asserts
            # nothing about a working credential. There is no server-side
            # default to mirror here (unlike `Doc.format`), and defaulting to
            # `connected` would have this client claim a connection works on the
            # strength of a field that never arrived.
            state=raw_state if isinstance(raw_state, str) else "pending",  # type: ignore[arg-type]
            profile=_mapping(body, "profile"),
            lastTestOk=_nullable_flag(body, "lastTestOk"),
            lastTestedAt=_nullable_text(body, "lastTestedAt"),
            createdAt=_text(body, "createdAt"),
            updatedAt=_text(body, "updatedAt"),
        )


#: A workflow's lifecycle state: an editable draft, or a published, live one.
WorkflowStatus = Literal["draft", "active"]


@dataclass(frozen=True)
class WorkflowSummary:
    """One workflow definition, as the list route projects it.

    `id` is the `wf_…` handle a caller hands to `workflows.run` — which is the
    whole reason the list operation is in a minimal surface (D4): without it
    there is no way to *discover* what to run.
    """

    #: Server-issued id, `wf_…`. The handle `workflows.run` takes.
    id: str
    #: The callable key, or `None` when this workflow has none yet — the normal
    #: state for every workflow that predates keys.
    key: Optional[str]
    #: Machine name, unique per scope.
    name: str
    #: Human-facing label.
    displayName: str
    #: Free-text description; `""` when unset.
    description: str
    #: Lifecycle state.
    status: WorkflowStatus
    #: Free-form labels; `[]` when there are none.
    tags: List[str]
    #: Total runs accumulated; `0` when the server sends none.
    runCount: int
    #: ISO-8601 timestamp. A string, deliberately.
    updatedAt: str

    @classmethod
    def from_wire(cls, body: Any) -> "WorkflowSummary":
        """Build a :class:`WorkflowSummary`, ignoring unknown keys.

        :param body: One parsed item of the `workflows` array.
        :returns: The workflow summary.
        """
        raw_status = body.get("status") if isinstance(body, dict) else None
        return cls(
            id=_text(body, "id"),
            key=_nullable_text(body, "key"),
            name=_text(body, "name"),
            displayName=_text(body, "displayName"),
            description=_text(body, "description"),
            # `draft` is the server's own answer for a row with no status, not
            # an invented one — its repository reads the column as
            # `status ?? "draft"`.
            status=raw_status if isinstance(raw_status, str) else "draft",  # type: ignore[arg-type]
            tags=_text_list(body, "tags"),
            runCount=_count(body, "runCount"),
            updatedAt=_text(body, "updatedAt"),
        )


#: The lifecycle state of a run.
#:
#: `queued` and `running` are in flight; `succeeded`, `failed` and `canceled`
#: are terminal (:func:`is_terminal_run_status`). **`failed` is a status, not an
#: error**: a run that failed comes back as an ordinary `200` carrying this
#: value, and no operation in this package raises on it
#: (`docs/implementation.md` §4).
RunStatus = Literal["queued", "running", "succeeded", "failed", "canceled"]

#: The terminal members of :data:`RunStatus`, written down once so that
#: :func:`is_terminal_run_status` and the rule it implements cannot drift apart.
_TERMINAL_RUN_STATUSES = frozenset({"succeeded", "failed", "canceled"})


@dataclass(frozen=True)
class StepError:
    """One step's failure inside a run.

    `error` is **opaque pass-through**: it is whatever the step reported, and
    its shape belongs to the app that reported it, not to this client.
    """

    #: Id of the step that failed.
    stepId: str
    #: Whatever the step reported.
    error: Any

    @classmethod
    def from_wire(cls, body: Any) -> "StepError":
        """Build a :class:`StepError`, ignoring unknown keys.

        :param body: One parsed item of the `stepErrors` array.
        :returns: The step failure.
        """
        return cls(
            stepId=_text(body, "stepId"),
            error=body.get("error") if isinstance(body, dict) else None,
        )


@dataclass(frozen=True)
class RunResult:
    """A workflow run: the handle, its state, and the result when it has one.

    A `202` body carries only `runId` + `status` — the run is queued or still
    going — while a `200` additionally carries `output`, `error` and `steps`.
    That is why everything after the first two fields has a default.

    `output`, `error` and the values in `steps` are **opaque pass-through**:
    they come from user workflows and vendor apps, and a client that modelled
    their internals would be wrong for someone. `steps` is a map **keyed by step
    id**, not a list (`docs/implementation.md` §5), and it is normalised to `{}`
    rather than left absent so a caller iterating a run's steps never has to
    branch on which status carried the body.

    `None` for `output` and `error` means *either* absent *or* an explicit wire
    `null` — the server sends `"error": null` on a successful waited run, and
    the two readings are the same statement here. The question a caller actually
    has is answered by `status`.
    """

    #: Server-issued run handle, `run_…`. Present on every response, queued
    #: included.
    runId: str
    #: Where the run has got to.
    status: RunStatus
    #: Per-step state, keyed by step id. `{}` when the server sent none.
    steps: Dict[str, Any] = field(default_factory=dict)
    #: The run's output when it finished; `None` while it is still going.
    output: Any = None
    #: The run-level error when it failed. **Data, never a raised exception.**
    error: Any = None
    #: Per-step failures, when the server reports them; `None` when it does not.
    stepErrors: Optional[List[StepError]] = None

    @classmethod
    def from_wire(cls, body: Any) -> "RunResult":
        """Build a :class:`RunResult` from a parsed wire object.

        :param body: The parsed, flat run body.
        :returns: The run result.
        """
        return cls(**_run_fields(body))


@dataclass(frozen=True)
class WorkflowRunResult(RunResult):
    """What `workflows.run` returns: the wire body, plus two derived signals.

    It **is** a :class:`RunResult` — the wire fields are present under their wire
    names, unwrapped from nothing (this route has no envelope). The two extra
    fields exist because a caller otherwise cannot tell a queued run from a
    finished one without re-deriving the rule:

    - :attr:`terminal` answers "has this run finished?" from the **run's own
      status**, which is the question a caller actually has.
    - :attr:`httpStatus` is the transport's own answer (`200` finished in time,
      `202` still going), kept because it is the distinction the server makes:
      dropping it would leave a caller unable to tell a `?wait=` timeout from a
      run that was never waited on.

    Both defaults exist only because a dataclass cannot put a required field
    after an inherited optional one. :meth:`from_wire` always supplies them.
    """

    #: `True` when `status` is `succeeded`, `failed` or `canceled`.
    terminal: bool = False
    #: The HTTP status that carried this body: `200` terminal, `202` queued or
    #: still running.
    httpStatus: int = 0

    @classmethod
    def from_wire(cls, body: Any, http_status: int = 0) -> "WorkflowRunResult":
        """Build a :class:`WorkflowRunResult` from a body and the status that carried it.

        :param body: The parsed, flat run body.
        :param http_status: The HTTP status of the response.
        :returns: The run result, with `terminal` derived from `status`.
        """
        fields = _run_fields(body)
        return cls(
            terminal=is_terminal_run_status(fields["status"]),
            httpStatus=http_status,
            **fields,
        )


def _run_fields(body: Any) -> Dict[str, Any]:
    """Read the six wire fields of a run body, with the pinned normalisations.

    Shared by :meth:`RunResult.from_wire` and
    :meth:`WorkflowRunResult.from_wire` so the two can never disagree about what
    a run body means.

    :param body: The parsed, flat run body.
    :returns: Constructor keyword arguments for a run result.
    """
    raw_status = body.get("status") if isinstance(body, dict) else None
    raw_steps = body.get("steps") if isinstance(body, dict) else None
    raw_step_errors = body.get("stepErrors") if isinstance(body, dict) else None
    return {
        "runId": _text(body, "runId"),
        # `queued` is the server's own answer for a run it has just accepted,
        # not an invented one. The callers that reach this default are the ones
        # whose body failed the caller-facing guard anyway.
        "status": raw_status if isinstance(raw_status, str) else "queued",
        # `{}` rather than absent: see the class docstring.
        "steps": dict(raw_steps) if isinstance(raw_steps, dict) else {},
        "output": body.get("output") if isinstance(body, dict) else None,
        "error": body.get("error") if isinstance(body, dict) else None,
        "stepErrors": (
            [StepError.from_wire(item) for item in raw_step_errors]
            if isinstance(raw_step_errors, list)
            else None
        ),
    }


#: What `client.run()` returns: the parsed envelope, **exactly as it arrived**.
#:
#: A plain dict and deliberately **not** a dataclass, which is the one place
#: this lane's usual "transcribe into a frozen dataclass" rule is suspended.
#: `docs/implementation.md` §5 pins the return type as the three known arms
#: **plus an open fallback** — "a plain `dict`" in so many words — because a
#: `kind` this release has never heard of must reach the caller with every
#: sibling field intact. A dataclass drops unknown keys by construction (that is
#: its contract everywhere else in this file), so modelling the envelope as one
#: would throw away exactly the payload the open arm exists to preserve.
#:
#: The three arms the server sends today:
#:
#: ===================  ==================  ======
#: ``kind``             field               HTTP
#: ===================  ==================  ======
#: ``"action"``         ``value``           200
#: ``"function"``       ``output``          200
#: ``"workflow"``       ``runId``/``status``  202
#: ===================  ==================  ======
#:
#: Discriminate with :func:`is_action_run`, :func:`is_function_run` and
#: :func:`is_workflow_run`; anything else is a kind this release does not know,
#: and it is handed back rather than raised.
#:
#: ── The invocation frame (server, 2026-08-20) ──
#:
#: Every arm now also carries the platform's own record of the attempt:
#: ``invocationId`` (an ``inv_…`` id), ``status``, ``startedAt``, ``finishedAt``
#: and ``durationMs`` — plus ``output`` on the ``action`` arm beside the
#: existing ``value``, carrying the identical payload. All of it is **additive**,
#: and this lane needed no code change to carry it: the envelope is a plain
#: dict, so the new keys arrive verbatim, which is the same property the open
#: fourth arm relies on.
#:
#: Two things worth keeping straight:
#:
#: * ``status`` here is the **platform's** verdict on the call — ``succeeded``,
#:   ``failed`` or, on the workflow arm, ``queued``. A status the *target*
#:   reported inside ``output`` (a SendGrid ``{"statusCode": 202}``, say) is a
#:   different statement about a different request.
#: * ``invocationId`` and ``runId`` are **different ids**. ``invocationId``
#:   names this call and resolves through ``GET /invocations/{id}``; ``runId``
#:   names the queued workflow run a call may have started.
#:
#: A **failed** call's 4xx body carries the same frame keys beside its
#: ``error``, so the attempt stays lookup-able — but that body reaches callers
#: as a raised :class:`~w6w.errors.W6WError`, not as an envelope.
RunEnvelope = Dict[str, Any]


def is_action_run(env: Mapping[str, Any]) -> bool:
    """Is this the `action` arm — a `conn_…` URN that executed an app action?

    :param env: Any envelope `run` returned.
    :returns: `True` when `kind` is `"action"`; the value is under `value`.
    """
    return env.get("kind") == "action"


def is_function_run(env: Mapping[str, Any]) -> bool:
    """Is this the `function` arm — a `fn_…` / `ep_…` URN that executed?

    :param env: Any envelope `run` returned.
    :returns: `True` when `kind` is `"function"`; the value is under `output`.
    """
    return env.get("kind") == "function"


def is_workflow_run(env: Mapping[str, Any]) -> bool:
    """Is this the `workflow` arm — a `wf_…` URN that was enqueued?

    :param env: Any envelope `run` returned.
    :returns: `True` when `kind` is `"workflow"`; the handle is under `runId`.
    """
    return env.get("kind") == "workflow"


def is_terminal_run_status(status: str) -> bool:
    """Has a run reached a state it will not leave?

    Public because it is the same question :attr:`WorkflowRunResult.terminal`
    answers, and a caller following a `202` handle on its own schedule needs it
    too. It reads the **run's** status rather than an HTTP code: a `202` can
    carry `queued` or `running`, and the answer is about the run, not the
    transport.

    :param status: A run status.
    :returns: `True` for `succeeded`, `failed` and `canceled`.
    """
    return status in _TERMINAL_RUN_STATUSES


@dataclass(frozen=True)
class FunctionSummary:
    """One Function definition, as the list route projects it.

    `key` is the name the Function is **called** by —
    `client.functions.run(key)` — and `displayName` is the label a human reads;
    the server falls back to the key when no display name was set, so
    `displayName` is never empty and never a substitute for `key`.

    There is no `status` here, and no lifecycle to have one: a Function is
    either runnable or it is not, which is what :attr:`valid` answers.
    """

    #: Server-issued id, `fn_…`.
    id: str
    #: The callable name, e.g. `"send-email"`. Kebab-case, never contains `_`.
    key: str
    #: Human-facing label; falls back to `key` server-side.
    displayName: str
    #: Free-text description; `""` when unset.
    description: str
    #: ISO-8601 timestamp. A string, deliberately.
    updatedAt: str
    #: Whether this Function can actually be run — server-computed, from the
    #: same single predicate the invoke path guards with
    #: (`db/repos/functions.ts`'s `is_function_valid`). A draft with no `impl`
    #: is `False`, and running it is `422 function_incomplete`.
    valid: bool

    @classmethod
    def from_wire(cls, body: Any) -> "FunctionSummary":
        """Build a :class:`FunctionSummary`, ignoring unknown keys.

        :param body: One parsed item of the `functions` array.
        :returns: The Function summary.
        """
        raw_valid = body.get("valid") if isinstance(body, dict) else None
        return cls(
            id=_text(body, "id"),
            key=_text(body, "key"),
            displayName=_text(body, "displayName"),
            description=_text(body, "description"),
            updatedAt=_text(body, "updatedAt"),
            # A missing `valid` reads as `False`, never `True`: the field gates
            # whether a caller offers this Function as runnable, and the safe
            # default for an answer the server did not give is "no".
            valid=raw_valid if isinstance(raw_valid, bool) else False,
        )


@dataclass(frozen=True)
class WorkflowDetail:
    """What `workflows.get` returns: the definition, plus what is not in it.

    **`updatedAt` is a top-level sibling of `workflow`, never a field inside
    it**, and that placement is load-bearing rather than incidental: the
    definition is the portable document (it can be exported, re-imported, or
    committed to a repo) and a server timestamp must not enter it.
    """

    #: The stored definition, overlaid with the authoritative `status` and
    #: `tags`. A plain dict: see :meth:`w6w.WorkflowsApi.get`.
    workflow: Dict[str, Any]
    #: Where this workflow was imported from, when it was imported at all.
    sourceRef: Optional[str]
    #: ISO-8601. The optimistic-concurrency token — hand it back to
    #: :meth:`w6w.WorkflowsApi.update` as `if_unmodified_since`.
    updatedAt: str

    @classmethod
    def from_wire(cls, body: Any) -> "WorkflowDetail":
        """Build a :class:`WorkflowDetail`, ignoring unknown keys.

        :param body: The parsed response body.
        :returns: The workflow detail.
        """
        return cls(
            workflow=_mapping(body, "workflow"),
            sourceRef=_nullable_text(body, "sourceRef"),
            updatedAt=_text(body, "updatedAt"),
        )


@dataclass(frozen=True)
class WorkflowSaveResult:
    """What both `workflows.create` and `workflows.update` return.

    `id` and `name` are lifted out of the wire's nested `{"workflow": {...}}`
    and onto this class: every caller wants the id, and a one-key wrapper class
    whose only job is to hold two strings is a level of indirection with nothing
    in it.
    """

    #: The saved workflow's `wf_…` id — the one to pass to `run`.
    id: str
    #: The saved workflow's machine name.
    name: str
    #: `True` when this save also (re)applied a schedule from the definition's
    #: `trigger.cron`. A workflow that already had one is not re-scheduled, so
    #: `False` does not mean "not scheduled" — it means "not scheduled by THIS
    #: call".
    scheduled: bool
    #: The new concurrency token, so a caller can chain saves without re-reading.
    updatedAt: str

    @classmethod
    def from_wire(cls, body: Any) -> "WorkflowSaveResult":
        """Build a :class:`WorkflowSaveResult`, ignoring unknown keys.

        :param body: The parsed response body.
        :returns: The save result.
        """
        workflow = _mapping(body, "workflow")
        raw_scheduled = body.get("scheduled") if isinstance(body, dict) else None
        return cls(
            id=_text(workflow, "id"),
            name=_text(workflow, "name"),
            scheduled=raw_scheduled if isinstance(raw_scheduled, bool) else False,
            updatedAt=_text(body, "updatedAt"),
        )


@dataclass(frozen=True)
class FunctionDetail:
    """What `functions.get` returns: the definition, plus the server's verdict.

    :attr:`valid` stays a **sibling** of :attr:`function` rather than being
    spliced into it. It is computed per request, it is not part of the stored
    document (`rfcs/function.md`), and folding it in would put it inside the
    object a caller sends straight back to :meth:`w6w.FunctionsApi.update`.
    """

    #: The stored definition, verbatim. A plain dict: see
    #: :meth:`w6w.FunctionsApi.get`.
    function: Dict[str, Any]
    #: Whether the Function can be run.
    valid: bool

    @classmethod
    def from_wire(cls, body: Any) -> "FunctionDetail":
        """Build a :class:`FunctionDetail`, ignoring unknown keys.

        :param body: The parsed response body.
        :returns: The Function detail.
        """
        raw_valid = body.get("valid") if isinstance(body, dict) else None
        return cls(
            function=_mapping(body, "function"),
            valid=raw_valid if isinstance(raw_valid, bool) else False,
        )


@dataclass(frozen=True)
class SaveResult:
    """What `functions.create` and `functions.update` return: the two ids.

    Deliberately NOT reused for workflows, whose save answers three more fields
    (:class:`WorkflowSaveResult`). One class covering both would have to make
    `scheduled` and `updatedAt` optional, and a field that is absent for half
    the callers is a field nobody can rely on.
    """

    #: The saved Function's `fn_…` id.
    id: str
    #: The saved Function's `key` — the name `functions.run` takes.
    key: str

    @classmethod
    def from_wire(cls, body: Any) -> "SaveResult":
        """Build a :class:`SaveResult`, ignoring unknown keys.

        :param body: The parsed `function` envelope payload.
        :returns: The save result.
        """
        return cls(id=_text(body, "id"), key=_text(body, "key"))


def mint_id(prefix: str) -> str:
    """Mint a client-side id for a definition the caller is creating.

    **Both `POST /workflows` and `POST /functions` REQUIRE an `id` in the body
    and never generate one** (`admin/workflows.ts`'s and `admin/functions.ts`'s
    `validateDefinition`: "`id` is required."). The id is synthetic and never
    user-facing — the display name is what a user sees and edits — so a caller
    writing ``create({"name": ..., "steps": [...]})`` should not have to know
    that, and every consumer that did know it ended up writing the same helper
    (studio's `newWorkflowId`/`newFunctionId`). This is that helper, once, and
    it is the same shape the `node` lane mints so the two lanes produce
    interchangeable ids.

    :param prefix: The kind prefix, without its underscore: `"wf"` or `"fn"`.
    :returns: A new id of the form `wf_…` / `fn_…`.
    """
    return "{prefix}_{uuid}".format(prefix=prefix, uuid=uuid4())
