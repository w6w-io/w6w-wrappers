"""The package's error types.

Two of them, and the split is deliberate — the same split the `node` wrapper
makes, so a reader of two SDKs sees one model:

- :class:`ApiError` — the server answered, or could not be reached at all.
  Four fields, pinned identically in all three w6w wrappers by
  `docs/implementation.md` §3, and raised by exactly the three failure modes in
  `_http._request`.
- :class:`ConfigError` — the client was never in a position to make a request:
  no base URL, or no token. No HTTP exchange happened, so an `ApiError`'s
  `status` and `code` would have to be invented — and `status = 0` is already
  spoken for by `network_error`. Conflating "your server is unreachable" with
  "you have not configured a server" is exactly the diagnosis a user needs kept
  apart.

Both derive directly from `Exception` rather than from a shared `W6WError` base,
because §3 pins the Python type as `class ApiError(Exception)` and three
wrappers agreeing on the model matters more here than the convenience of one
`except` clause catching both. The two are raised in different situations and
callers handle them differently.
"""

from __future__ import annotations

from typing import Any, Optional


class ApiError(Exception):
    """An error raised by a w6w API call.

    :ivar status: HTTP status, or `0` when the request never produced a
        response.
    :ivar code: Server-minted error code, `"network_error"`, or
        `"bad_response"`.
    :ivar message: Human-readable message. Also the exception's `args[0]`.
    :ivar raw: The **parsed response body** when the server sent one, otherwise
        `None`. It is kept because an error body carries fields the message
        alone drops — an invoke failure rides alongside `logs` and `apiCalls` —
        and because a caller inspecting a server error should never have to
        re-issue the request to see what came back.

    Classification is by :attr:`status` plus a **prefix** of :attr:`code` —
    `unknown_*` (404), `invalid_*` (400), `*_exists` / `*_conflict` (409),
    `forbidden` (403), `unauthorized` (401) — never by an exhaustive list of
    code strings. The server mints codes freely and a closed list in three
    wrappers would be stale within a release (`docs/implementation.md` §3).

    One status deserves singling out: **`424` is an app/upstream failure in the
    execute phase**, and it is a 4xx rather than a 5xx on purpose — Cloudflare
    replaces an origin 5xx with its own CORS-less HTML page, which would strip
    the real message. Do not normalise a 424 into a server error or into a
    transport failure; it passes through with its code and body intact.

    A `401` has **no side effect**: the wrapper raises and stops. No retry, no
    token refresh, no callback hook (§3, §8).

    Example::

        try:
            client.request("GET", "/vars/var_missing")
        except ApiError as err:
            if err.status == 404:
                ...  # err.code == "unknown_var", err.raw == {"error": {...}}
    """

    def __init__(self, status: int, code: str, message: str, raw: Optional[Any] = None) -> None:
        """Build an API error.

        :param status: HTTP status, or `0` for a transport failure.
        :param code: Error code.
        :param message: Human-readable message.
        :param raw: Parsed response body, when there was one.
        """
        super().__init__(message)
        self.status: int = status
        self.code: str = code
        self.message: str = message
        self.raw: Optional[Any] = raw

    def __str__(self) -> str:
        """Render status and code alongside the message.

        The default `Exception.__str__` would print the message alone, which
        drops the two fields a reader triages on. A traceback's last line should
        say *which* failure this was::

            w6w.errors.ApiError: [404 unknown_document] No such document.

        :returns: The formatted message.
        """
        return "[{status} {code}] {message}".format(
            status=self.status,
            code=self.code,
            message=self.message,
        )


class ConfigError(Exception):
    """The client is not configured well enough to make a request.

    Raised at construction when there is no base URL, and on the first request
    when there is no token — a client with no token can still be *built*, so a
    CLI's `--help` and `--version` work offline (`docs/implementation.md` §2).

    The message always names the environment variable that would have supplied
    the missing value, because "which variable?" is the only question a user has
    at this point.

    :ivar message: The message, also available as `args[0]`.
    """

    def __init__(self, message: str) -> None:
        """Build a configuration error.

        :param message: What is missing, naming the environment variable.
        """
        super().__init__(message)
        self.message: str = message
