"""`client.me()` — who the caller is, and what answered.

One GET to `/auth/me` — the server's real identity route (verified live: `200`,
`{tenant, subject, account, role}`). The response body is **flat**, so there is
nothing for `unwrap` to do here; this is one of the two operations that reads a
flat body, and it asserts the body's shape with
:func:`w6w.types.require_object` instead.

**Fixed 2026-07-28** (`docs/endpoints.md` §1): every wrapper calls `/auth/me`
directly rather than waiting on the `/me` alias D15 originally specced and that
was never built. The live consumer of that route is the studio, whose typed `Me`
is the flat body — a nested envelope would break it. What is still missing
server-side is the optional `versions` block, which this module tolerates being
absent entirely.

It is deliberately **not a namespace class**. `endpoints.json` names this
operation `client.me()` — a method on the client itself — so this module exports
a function over a narrow request seam and `Client` delegates to it, rather
than inventing a `client.me.me()`.

── The one value this module adds, and the one it must not ──
`versions["wrapper"]` is filled in here because the server cannot know it: it is
this package's own published version. It is a **default, never an overwrite** —
a key the server supplied wins, `wrapper` included, so a future host with a
better answer is not silently overruled by the client
(`docs/implementation.md` §5, "precedence on collision is server-wins").

The map is otherwise **carried through unaltered**. A server that sends an
unbumped placeholder version reaches the caller with that value intact;
presenting such a value as `dev` is a separate *rendering* rule (D5) that applies
where a version is shown to a person — the CLI's `w6w info` banner. The two rules
act at different layers and this module implements exactly one of them: a wrapper
does not edit the map it returns, because a bug report is read off these values
and it has to quote what the server actually said.
"""

from __future__ import annotations

from dataclasses import replace
from typing import Any, Mapping, Optional, Protocol

from ._http import HttpResponse
from ._version import __version__
from .types import Me, require_object


class MeRequest(Protocol):
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


def fetch_me(request: MeRequest) -> Me:
    """Fetch the caller's identity and the component versions behind it.

    Reached as `client.me()`; this function is the implementation the client
    delegates to.

    `versions` is normalised to **always exist and always carry `wrapper`**, so
    a caller printing a version banner never has to branch on whether the server
    sent the block at all. Everything else in the block is the server's.

    :param request: The client's bound `request` method.
    :returns: The identity, with `versions["wrapper"]` filled in as a default.
    :raises ConfigError: When no token is configured.
    :raises ApiError: On any non-2xx — e.g. `401` when the token is not
        accepted.
    :raises ApiError: `bad_response` when a `2xx` body is not an object. A list
        included: `200 []` must fail here rather than return an identity whose
        only populated field is the one this function just added (measured in the
        `node` lane, `evals/T2.1.4.eval.md`; `isinstance(body, dict)` is what
        makes this lane get it right for free).
    """
    response = request("GET", "/auth/me")
    identity = Me.from_wire(require_object(response, "an identity object"))
    # Merge order IS the policy, and the two orders are observably different on
    # the one field a bug report is read off: this package's version is the
    # DEFAULT and every key the server sent lands on top of it. The reverse
    # (`{**identity.versions, "wrapper": __version__}`) would make the wrapper's
    # own value win — see `docs/implementation.md` §5, which pins this literal
    # expression rather than leaving it to be decided three times.
    return replace(identity, versions={"wrapper": __version__, **identity.versions})
