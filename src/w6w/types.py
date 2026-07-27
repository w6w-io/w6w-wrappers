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
have exactly one implementation shared by both operation modules:

- :func:`unwrap` (with :func:`unwrap_object` / :func:`unwrap_list`) — the one
  place an operation reads the server's envelope, and the one place a
  `bad_response` is raised for a `2xx` that does not carry what it promised.
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

from dataclasses import dataclass
from typing import Any, Dict, List, Literal, Mapping, Optional, Union

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
