"""The transport: one :func:`_request`, three failure modes, no policy.

Everything the operation modules do goes through :func:`_request`. It attaches
the bearer, serialises a JSON body, reads the response exactly once, parses it
guardedly, and raises one of the three failure modes pinned in
`docs/implementation.md` §3 — and nothing else. In particular it does **not**
retry, does **not** refresh a token, does **not** poll, and does **not** inspect
an error code to decide on a side effect. A `401` raises and stops.

It also returns the **HTTP status** alongside the parsed body, because a `202`
is a normal outcome on this API (a queued workflow run), not an error — a
signature that dropped the status would leave the run operations unable to tell
"finished" from "queued" (§4).

Two things live here rather than at the call sites, and both are mechanism, not
convenience:

- :func:`path` — the **one** primitive that percent-encodes caller-supplied
  values into a URL path. "Every call site remembered to encode" is not a
  property anyone can verify later; one primitive is.
- The `urllib` trap. `urlopen` **raises** `HTTPError` for any non-2xx status,
  and an `HTTPError` *is* a response object. It must be routed to the envelope
  mapper, never to `network_error`, and its body must be read off the exception
  rather than lost.
"""

from __future__ import annotations

import json
import re
import socket
from typing import Any, Callable, Dict, List, Mapping, NamedTuple, Optional, Tuple
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode
from urllib.request import Request, urlopen

from ._config import ResolvedConfig, require_token
from .errors import ApiError

#: How much of a non-JSON error body is quoted back in a `bad_response`
#: message. Enough to recognise a Cloudflare page; not enough to paste a
#: megabyte of HTML into a log.
SNIPPET_LIMIT: int = 200

#: The transport seam.
#:
#: A callable taking a :class:`urllib.request.Request` and returning a
#: response-like object exposing ``.status`` (or ``.code`` / ``.getcode()``),
#: ``.reason`` and ``.read()``. `urllib`'s own `HTTPResponse` and `HTTPError`
#: both satisfy it, and so does a five-line fake.
#:
#: It is **constructor-injected**, for the same reason the credential is: no
#: test in this package may require a live server or open a real socket
#: (`docs/implementation.md` §9), and a module-patched global cannot be
#: exercised two different ways in one process.
Transport = Callable[[Request], Any]

_PLACEHOLDER_RE = re.compile(r"\{([A-Za-z_][A-Za-z0-9_]*)\}")


class HttpResponse(NamedTuple):
    """A successful response: the parsed body plus the status that carried it.

    :ivar status: The HTTP status. `202` is success on this API and reaches the
        caller intact.
    :ivar body: The parsed body, or `None` for an empty one — a `204`-style
        response must not crash a caller.
    """

    status: int
    body: Any


def path(template: str, **values: str) -> str:
    """Build a base-relative path, percent-encoding every interpolated value.

    ::

        path("/documents/by-key/{key}", key="a/b")
        # -> "/documents/by-key/a%2Fb"

    **Use this for every path containing a caller-supplied value**, per the
    encoding pin in `docs/implementation.md` §2. It exists as a single primitive
    at the transport seam — not as a `quote()` call per operation — because
    encoding then cannot be forgotten one call site at a time. A template
    placeholder with no matching value (or a value with no placeholder) raises
    immediately, so a typo fails a test rather than shipping a literal `{key}`
    in a URL.

    ``safe=""`` is **load-bearing**. `urllib.parse.quote` defaults to
    ``safe="/"``, which deliberately leaves `/` alone because its usual job is
    encoding a whole path rather than one segment::

        quote("a/b")            -> 'a/b'     # still two path segments: WRONG
        quote("a/b", safe="")   -> 'a%2Fb'   # one segment: correct

    Why it matters, in one line: the server accepts any non-empty key up to 128
    characters, so `".."` is a key a user can legitimately create — and
    `"/documents/by-key/" + ".."` naively concatenated resolves to the **list**
    route, returning every document with a `200` and no error anywhere.

    This is encoding, **never validation**. A key the server accepts is encoded
    and sent; the wrapper does not reject, canonicalise or rewrite it. A
    character policy for keys is business logic and it lives in the server —
    a wrapper that refused `"../.."` locally would make a document that is
    legitimately creatable through the same API permanently unreadable through
    this client.

    The one case encoding cannot fix is a dot-only segment: `.` is unreserved in
    RFC 3986, so no percent-encoder touches it. Unlike the WHATWG URL parser
    behind `fetch`, `urllib` does **not** normalise the path away, so the
    segment reaches the server verbatim and the server (or a proxy) decides what
    it means. Encode it and send it either way.

    :param template: An **author-controlled** path literal with `{name}`
        placeholders, e.g. `"/documents/by-key/{key}"`. Never build this from
        caller input.
    :param values: One value per placeholder. Each is percent-encoded.
    :returns: The assembled, encoded path.
    :raises ValueError: If placeholders and values do not correspond exactly.
    """
    names = _PLACEHOLDER_RE.findall(template)
    missing = [name for name in names if name not in values]
    unused = [name for name in values if name not in names]
    if missing or unused:
        raise ValueError(
            "path() placeholders and values do not match for {template!r}: "
            "missing={missing}, unused={unused}".format(
                template=template,
                missing=sorted(missing),
                unused=sorted(unused),
            ),
        )
    return _PLACEHOLDER_RE.sub(lambda m: quote(str(values[m.group(1)]), safe=""), template)


def _query_pairs(query: Optional[Mapping[str, Any]]) -> List[Tuple[str, str]]:
    """Normalise query parameters to encodable name/value pairs.

    `None` values are **dropped**, so an optional argument can be forwarded
    without a conditional at every call site. Booleans render as `true`/`false`
    rather than Python's `True`/`False`, because `?wait=true` is what the server
    reads and what the other two wrappers send.

    :param query: Parameters, or `None`.
    :returns: Pairs in insertion order.
    """
    pairs: List[Tuple[str, str]] = []
    for name, value in (query or {}).items():
        if value is None:
            continue
        if isinstance(value, bool):
            pairs.append((name, "true" if value else "false"))
        else:
            pairs.append((name, str(value)))
    return pairs


def build_url(
    config: ResolvedConfig,
    url_path: str,
    query: Optional[Mapping[str, Any]] = None,
) -> str:
    """Assemble the full request URL from a resolved base, a path and query params.

    The base is already joined with the API base path by `_config`; the path is
    appended verbatim (it is expected to be encoded already — see :func:`path`),
    and the query string is built with `urlencode`, which encodes both names and
    values.

    The parameter is `url_path` rather than `path` **so it does not shadow the
    encoder**: inside a function whose parameter is called `path`, the name
    `path` is a plain string, and `path("/documents/{id}", id=id)` is a
    `TypeError` at best and a silently unencoded URL at worst. One primitive
    that every call site must reach is worth an unambiguous name.

    :param config: The resolved configuration.
    :param url_path: Base-relative path with a leading slash, e.g. `/documents`.
        Build it with :func:`path` whenever any part of it comes from the caller.
    :param query: Query parameters, if any.
    :returns: The absolute URL to request.
    """
    pairs = _query_pairs(query)
    suffix = "?" + urlencode(pairs) if pairs else ""
    return config.base_url + url_path + suffix


def default_transport(request: Request) -> Any:
    """The stdlib transport: `urllib.request.urlopen`.

    Isolated in a named function so the default is injectable-shaped like every
    fake, and so the one place this package opens a socket is greppable.

    :param request: The request to send.
    :returns: The `HTTPResponse`.
    """
    return urlopen(request)  # noqa: S310 — the URL comes from resolved config, not user input


def _status_of(response: Any) -> int:
    """Extract the HTTP status from a response-like object.

    `HTTPResponse` and `HTTPError` both expose `.status` on Python 3.9+ (it is
    an `addinfourl` property over `.code`); `.code` and `.getcode()` are tried
    afterwards so an older-style or hand-rolled fake still works.

    :param response: The object the transport returned or raised.
    :returns: The HTTP status.
    :raises ApiError: If the object carries no status at all — a transport that
        does not meet the seam's contract, reported as such rather than as a
        confusing `AttributeError` three frames later.
    """
    status = getattr(response, "status", None)
    if status is None:
        status = getattr(response, "code", None)
    if status is None:
        getcode = getattr(response, "getcode", None)
        status = getcode() if callable(getcode) else None
    if not isinstance(status, int):
        raise ApiError(
            0,
            "bad_response",
            "The transport returned an object with no HTTP status: "
            + repr(response)[:SNIPPET_LIMIT],
        )
    return status


def _reason_of(response: Any) -> str:
    """Extract the HTTP reason phrase, or `""` when there is none.

    Used only as the last fallback for an error message: an envelope's own
    message always wins.

    :param response: The response-like object.
    :returns: The reason phrase.
    """
    reason = getattr(response, "reason", None)
    return reason if isinstance(reason, str) else ""


def _read_body(response: Any) -> str:
    """Read a response body exactly once, as text.

    Decoded leniently: a mis-encoded byte in a proxy's error page must not turn
    into a `UnicodeDecodeError` that hides the page.

    :param response: The response-like object.
    :returns: The body, or `""` when there is none.
    """
    read = getattr(response, "read", None)
    raw = read() if callable(read) else b""
    if isinstance(raw, bytes):
        return raw.decode("utf-8", errors="replace")
    return str(raw or "")


def _request(
    config: ResolvedConfig,
    transport: Transport,
    method: str,
    url_path: str,
    query: Optional[Mapping[str, Any]] = None,
    body: Optional[Any] = None,
) -> HttpResponse:
    """Perform one request and map its outcome.

    Returns `(status, body)` on any `2xx`. Raises :class:`ApiError` in exactly
    three cases, transcribed from the studio's client, which has these three and
    no others:

    1. **Transport failure** — the request never produced an HTTP response
       (`URLError`, `socket.timeout`, DNS failure, connection refused).
       `status = 0`, `code = "network_error"`, and the message names the
       **method and full URL** plus the underlying message, because a bare
       `URLError` says nothing a user can act on.
    2. **Non-JSON body on a non-OK status** — a proxy or Cloudflare HTML error
       page. `code = "bad_response"`, message carrying a ≤200-character snippet;
       reporting it as an opaque `JSONDecodeError` would throw away the only
       diagnostic present. A non-JSON body on an **OK** status is not an error.

       **A non-OK status with NO body is case 3, not case 2** — `code` is
       `"error"` and the message falls back to the HTTP reason. The boundary is
       pinned because it is exactly the kind of thing a plausible refactor
       flips: `"bad_response"` means *the server sent something and it was
       unusable*, so there has to be a something. An empty `503` is an ordinary
       unenveloped failure, and reporting it as a malformed response would send
       a reader hunting for a response body that never existed.
    3. **Envelope error** — a non-OK status with a JSON body. `code` from
       `body["error"]["code"]` (else `"error"`), `message` from
       `body["error"]["message"]` (else the HTTP reason), and `raw` = the parsed
       body, which carries the fields an invoke failure rides alongside
       (`logs`, `apiCalls`).

    A `424` lands in case 3 like any other non-OK JSON status: the target app or
    its upstream vendor failed during execute. It is deliberately a 4xx so
    Cloudflare cannot swallow it, and it is never normalised into a transport
    error or a 5xx.

    :param config: Resolved configuration (base URL and credential).
    :param transport: The transport to use; injected, never a module global.
    :param method: `GET`, `POST`, `PATCH` or `DELETE`.
    :param url_path: Base-relative path — build it with :func:`path` whenever
        any part of it comes from the caller. Named `url_path` so that the
        encoder is never shadowed inside this function (see :func:`build_url`).
    :param query: Query parameters; `None` values are dropped.
    :param body: Request body. Serialised as JSON when not `None`; a bodiless
        request sends no `Content-Type`.
    :returns: The status and parsed body.
    :raises ConfigError: When no token is configured — raised *before* the
        transport is touched.
    :raises ApiError: On any of the three failure modes above.
    """
    url = build_url(config, url_path, query)
    # Resolved per request rather than at construction: a client with no token
    # is constructible (so a CLI's --help works offline) and fails here instead.
    headers: Dict[str, str] = {"Authorization": "Bearer " + require_token(config)}
    payload: Optional[bytes] = None
    if body is not None:
        headers["Content-Type"] = "application/json"
        payload = json.dumps(body).encode("utf-8")

    request = Request(url, data=payload, headers=headers, method=method)

    try:
        response = transport(request)
    except HTTPError as err:
        # THE urllib TRAP: urlopen *raises* on any non-2xx, and an HTTPError IS
        # a response — it has a status, a reason and a readable body. It must
        # reach the envelope/bad_response mapping below; routing it to
        # `network_error` would report every 404 as "the server is unreachable"
        # and throw the error envelope away. Ordering matters: HTTPError is a
        # subclass of URLError, so this clause has to come first.
        status, reason, text = _status_of(err), _reason_of(err), _read_body(err)
    except (URLError, socket.timeout, OSError) as err:
        # URLError and socket.timeout are both OSError subclasses; all three are
        # named so the mapping is legible against §3, and so a bare
        # ConnectionRefusedError is covered too.
        raise ApiError(
            0,
            "network_error",
            "Could not reach the w6w server ({method} {url}). "
            "It may be down or unreachable. ({err})".format(method=method, url=url, err=err),
        ) from err
    else:
        status, reason, text = _status_of(response), _reason_of(response), _read_body(response)

    ok = 200 <= status < 300
    data: Any = None
    if text:
        try:
            data = json.loads(text)
        except ValueError:
            if not ok:
                raise ApiError(
                    status,
                    "bad_response",
                    "Server returned a non-JSON {status} response: {snippet}".format(
                        status=status,
                        snippet=text[:SNIPPET_LIMIT],
                    ),
                ) from None
            # A non-JSON body on an OK status is not an error: the body simply
            # carried nothing this client models, and `data` stays None.

    if not ok:
        envelope = data.get("error") if isinstance(data, dict) else None
        if not isinstance(envelope, dict):
            envelope = {}
        raise ApiError(
            status,
            str(envelope.get("code") or "error"),
            str(envelope.get("message") or reason or "HTTP {0}".format(status)),
            data,
        )

    return HttpResponse(status, data)
