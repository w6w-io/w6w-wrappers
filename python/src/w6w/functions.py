"""`client.functions.*` — run a Function by the name you gave it.

A Function is a canonical, vendor-stable interface bound to one swappable app
Action. Before this namespace existed, calling one meant the URN operation::

    client.run("fn_a9b39917-cd4e-4eea-ab89-c3d079684193", payload=payload)

— an opaque id for a Function the user named ``send-email``. ``client.run`` is
still the right tool when the caller is *dispatching* something whose kind it
does not know; it is the wrong tool for "call my send-email Function"::

    client.functions.run("send-email", payload={"to": to, "subject": subject})

The name is the FIRST argument, matching ``workflows.run(id, ...)`` — the
namespace already shaped this way — so all three runnable kinds read alike.

ID OR KEY, one argument. The server's ``/functions/{idOrKey}/invoke`` accepts
either, because the two shapes cannot collide: an id carries a kind prefix and
therefore an underscore, and a key is a kebab-slug, which forbids one. So this
takes no flag and no prefix to say which you meant — pass whichever you have.
"""

from __future__ import annotations

from typing import Any, Mapping, Optional, Protocol

from ._config import ResolvedConfig
from ._http import HttpResponse, path
from .errors import ApiError


class FunctionsHost(Protocol):
    """The slice of `Client` this namespace needs.

    Structural rather than a concrete client type, so the namespace stays
    independently constructible in a test and this module never imports the
    client back.
    """

    #: The resolved configuration.
    config: ResolvedConfig

    def request(
        self,
        method: str,
        path: str,
        query: Optional[Mapping[str, Any]] = None,
        body: Optional[Any] = None,
    ) -> HttpResponse:
        """Perform one request."""
        ...


class FunctionsApi:
    """The `functions` namespace on a :class:`~w6w.client.Client`.

    Example::

        output = client.functions.run(
            "send-email",
            payload={"to": "ada@example.com", "subject": "Hi"},
        )
    """

    def __init__(self, host: FunctionsHost) -> None:
        """Bind the namespace to the client it issues requests through.

        :param host: The client this namespace issues requests through.
        """
        self._host = host

    def run(
        self,
        name: str,
        payload: Optional[Mapping[str, Any]] = None,
    ) -> Any:
        """Run one Function and return its output.

        Returns the Function's OUTPUT, not an envelope. ``client.run`` returns a
        kind-discriminated envelope because the caller does not know what the
        URN will resolve to; here the kind is in the method name, so the
        discriminant would be a field the caller unwraps to learn nothing.

        :param name: The Function's key (``"send-email"``) or its ``fn_…`` id.
            Percent-encoded into the path.
        :param payload: The Function's canonical inputs. Sent as ``{}`` when
            omitted rather than left out — the server's parameter schemas are
            written against an object, and ``{}`` says "no input" where an
            absent key says "I forgot".
        :returns: The Function's output, verbatim.
        :raises ConfigError: When no token is configured.
        :raises ApiError: ``404 unknown_function`` when no Function of that name
            exists for the caller.
        :raises ApiError: ``422 function_incomplete`` when the Function has no
            runnable ``impl``.
        :raises ApiError: ``bad_response`` when a `2xx` body carries no
            ``output`` key at all.
        """
        response = self._host.request(
            "POST",
            path("/functions/{name}/invoke", name=name),
            body={"inputs": dict(payload) if payload is not None else {}},
        )

        # Deliberately NOT the shared `unwrap` helper. That treats `None` as
        # "the server did not send what it promised" — correct for a `documents`
        # envelope, where null is never a document. It is wrong here: a
        # Function's output is an OPAQUE pass-through, and an action that
        # returns nothing yields `{"output": null}`, which is a successful run.
        # So the guard is PRESENCE of the key, not truthiness of the value.
        body = response.body
        if not isinstance(body, dict) or "output" not in body:
            raise ApiError(
                response.status,
                "bad_response",
                f'Server returned a {response.status} with no "output" in the response body.',
                body,
            )
        return body["output"]
