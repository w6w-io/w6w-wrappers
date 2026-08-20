"""`client.endpoints.*` — run an Endpoint by the key you gave it.

An Endpoint is a callable entry point that dispatches to whatever it targets: an
app action, a Function, or a Workflow::

    client.endpoints.run("send-email", payload={"to": to})

The name is the FIRST argument, matching ``functions.run`` and
``workflows.run``, so all three runnable kinds read alike. It may be the
Endpoint's key or its ``ep_…`` id — the server takes either in one slot, because
an id carries a kind prefix (and so an underscore) while a key is a kebab-slug
(which forbids one), so no flag or prefix is needed.

UNLIKE ``functions.run``, THIS RETURNS AN ENVELOPE, and that asymmetry is the
honest one: a Function's kind is settled by the method name, but an Endpoint
dispatches to one of three things and the caller genuinely does not know which
answered. The ``kind`` discriminant is information here, not ceremony — and the
Workflow arm is asynchronous (``202``, a ``runId``) where the other two are not.
"""

from __future__ import annotations

from typing import Any, Mapping, Optional, Protocol

from ._config import ResolvedConfig
from ._http import HttpResponse, path
from .errors import ApiError
from .types import RunEnvelope


class EndpointsHost(Protocol):
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


class EndpointsApi:
    """The `endpoints` namespace on a :class:`~w6w.client.Client`.

    Example::

        envelope = client.endpoints.run("send-email", payload={"to": "ada"})
        if envelope["kind"] == "workflow":
            print(envelope["runId"])  # the async arm
    """

    def __init__(self, host: EndpointsHost) -> None:
        """Bind the namespace to the client it issues requests through.

        :param host: The client this namespace issues requests through.
        """
        self._host = host

    def run(
        self,
        name: str,
        payload: Optional[Mapping[str, Any]] = None,
    ) -> RunEnvelope:
        """Run one Endpoint; the envelope's ``kind`` says which arm answered.

        :param name: The Endpoint's key (``"send-email"``) or its ``ep_…`` id.
            Percent-encoded into the path.
        :param payload: The Endpoint's input. Sent as ``{}`` when omitted.
        :returns: The kind-discriminated envelope, exactly as it arrived — an
            unknown future ``kind`` reaches the caller intact rather than
            raising.
        :raises ConfigError: When no token is configured.
        :raises ApiError: ``404 unknown_endpoint`` when no Endpoint of that name
            exists for the caller.
        :raises ApiError: ``bad_response`` when a `2xx` body carries no string
            ``kind``.
        """
        response = self._host.request(
            "POST",
            path("/endpoints/{name}/invoke", name=name),
            body={"input": dict(payload) if payload is not None else {}},
        )

        # The same guard `run.py` applies, for the same reason: a dict-only
        # check lets `{}` through and hands back an envelope whose `kind` is
        # missing at runtime.
        body = response.body
        if not isinstance(body, dict) or not isinstance(body.get("kind"), str):
            raise ApiError(
                response.status,
                "bad_response",
                f'Server returned a {response.status} with no "kind" in the response body.',
                body,
            )
        return body
