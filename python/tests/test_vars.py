"""`client.vars.*`, against an **injected fake transport**.

No case here needs a live server or opens a socket
(`docs/implementation.md` §9). Each one asserts the request the wrapper *made*
(method, full resolved URL, bearer, serialised body) **and** the value it
returned, which is always the unwrapped payload and never the server's envelope.

Two of the cases below are about something a variable operation must **not** do:
send a scoping query parameter, or be able to reach one. Variables are scoped by
tenant/subject only — the server's routes read no such parameter and the table
has no column for it — so `NoScopeParameterTest` asserts the absence directly,
on every one of the six operations, with a client that has a default configured.
"""

from __future__ import annotations

import email.message
import io
import json
import unittest
from typing import Any, Callable, List, Tuple
from urllib.error import HTTPError
from urllib.request import Request

from w6w import UNSET, ApiError, Client, HttpResponse, ResolvedConfig, Var, VarsApi

#: One variable, as the server sends it — the singular envelope key is `var`.
VAR_BODY = {
    "id": "var_1",
    "name": "sender_email",
    "type": "string",
    "value": "a@b.c",
    "description": "From address.",
    "createdAt": "2026-07-01T12:00:00.000Z",
    "updatedAt": "2026-07-22T18:03:00.000Z",
}

VAR = Var(
    id="var_1",
    name="sender_email",
    type="string",
    value="a@b.c",
    description="From address.",
    createdAt="2026-07-01T12:00:00.000Z",
    updatedAt="2026-07-22T18:03:00.000Z",
)


class FakeResponse:
    """The minimum a transport must return: a status, a reason and a body."""

    def __init__(self, status: int, body: str = "", reason: str = "") -> None:
        self.status = status
        self.reason = reason
        self._body = body.encode("utf-8")

    def read(self) -> bytes:
        """Read the body once, as `urllib` would."""
        return self._body


class Recorder:
    """A transport-shaped fake that records every request it is handed."""

    def __init__(self, respond: Callable[[Request], Any]) -> None:
        self.calls: List[Request] = []
        self._respond = respond

    def __call__(self, request: Request) -> Any:
        """Record the request, then produce (or raise) the case's outcome."""
        self.calls.append(request)
        return self._respond(request)


def http_error(status: int, body: Any, reason: str = "") -> HTTPError:
    """Build the exception `urlopen` raises for a non-2xx status."""
    return HTTPError(
        "https://api.example.com/vars",
        status,
        reason,
        email.message.Message(),
        io.BytesIO(json.dumps(body).encode("utf-8")),
    )


def client(respond: Callable[[Request], Any]) -> Tuple[Client, List[Request]]:
    """A client wired to a fake transport.

    A **default scope is deliberately configured** on every client built here.
    A client without one could not fail `NoScopeParameterTest`: the assertion
    that nothing leaks into a variable request is only meaningful when there is
    something available to leak.
    """
    transport = Recorder(respond)
    return (
        Client(
            base_url="https://api.example.com",
            token="tok_1",
            project="prj_default",
            transport=transport,
        ),
        transport.calls,
    )


def responding(body: Any, status: int = 200) -> Callable[[Request], Any]:
    """Answer every request with one JSON body."""
    text = json.dumps(body)
    return lambda _request: FakeResponse(status, text)


def raising(error: BaseException) -> Callable[[Request], Any]:
    """Raise, the way `urlopen` does for a non-2xx status."""

    def _raise(_request: Request) -> Any:
        raise error

    return _raise


def sent_body(request: Request) -> Any:
    """The JSON body actually put on the wire, parsed back."""
    assert request.data is not None, "expected a request body"
    return json.loads(request.data.decode("utf-8"))


class SurfaceTest(unittest.TestCase):
    """The namespace exists and is complete."""

    def test_all_six_operations_are_callable_on_a_constructed_client(self) -> None:
        # A runtime assertion, not a type-level one: a namespace that silently
        # lost a method would still typecheck in every other case in this file.
        # The names are `naming.python`'s, character for character.
        instance = Client(base_url="https://api.example.com", token="t")

        for name in ("list", "get", "get_by_name", "create", "update", "delete"):
            with self.subTest(operation=name):
                self.assertTrue(
                    callable(getattr(instance.vars, name, None)),
                    "vars.{0} is missing".format(name),
                )


class ReadTest(unittest.TestCase):
    """The three reads: list, by id, by name."""

    def test_list_unwraps_the_envelope_and_returns_the_variables(self) -> None:
        instance, calls = client(responding({"vars": [VAR_BODY]}))

        variables = instance.vars.list()

        # The list itself, not {"vars": […]}.
        self.assertEqual(variables, [VAR])
        self.assertEqual(variables[0].updatedAt, "2026-07-22T18:03:00.000Z")
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0].get_method(), "GET")
        self.assertEqual(calls[0].full_url, "https://api.example.com/vars")
        self.assertEqual(calls[0].get_header("Authorization"), "Bearer tok_1")

    def test_get_reads_the_singular_var_key(self) -> None:
        instance, calls = client(responding({"var": VAR_BODY}))

        variable = instance.vars.get("var_1")

        self.assertEqual(variable, VAR)
        self.assertEqual(calls[0].full_url, "https://api.example.com/vars/var_1")

    def test_a_json_variable_carries_its_value_through_untouched(self) -> None:
        # `value` is opaque pass-through: a nested structure arrives as it left,
        # and `None` is a legitimate stored value for a "json" variable.
        payload = {"a": [1, 2, {"b": None}]}
        body = dict(VAR_BODY, type="json", value=payload)
        instance, _calls = client(responding({"var": body}))

        variable = instance.vars.get("var_1")

        self.assertEqual(variable.type, "json")
        self.assertEqual(variable.value, payload)

    def test_get_by_name_addresses_the_by_name_route_and_encodes_the_name(self) -> None:
        instance, calls = client(responding({"var": VAR_BODY}))

        instance.vars.get_by_name("sender_email")
        # The server's own rule would reject this name — which is the server's
        # job. This lane encodes and sends rather than validating locally.
        instance.vars.get_by_name("a b/c")

        self.assertEqual(calls[0].full_url, "https://api.example.com/vars/by-name/sender_email")
        self.assertEqual(calls[1].full_url, "https://api.example.com/vars/by-name/a%20b%2Fc")

    def test_one_read_is_one_http_call_never_a_list_then_filter(self) -> None:
        instance, calls = client(responding({"var": VAR_BODY}))

        instance.vars.get_by_name("sender_email")

        self.assertEqual(len(calls), 1)


class WriteTest(unittest.TestCase):
    """Create, update and delete — and what each one puts on the wire."""

    def test_create_sends_name_type_and_value_and_accepts_201(self) -> None:
        instance, calls = client(responding({"var": VAR_BODY}, status=201))

        variable = instance.vars.create("sender_email", "string", "a@b.c")

        self.assertEqual(variable, VAR)
        self.assertEqual(calls[0].get_method(), "POST")
        self.assertEqual(calls[0].full_url, "https://api.example.com/vars")
        self.assertEqual(
            sent_body(calls[0]),
            {"name": "sender_email", "type": "string", "value": "a@b.c"},
        )

    def test_create_sends_a_null_value_because_null_is_storable_json(self) -> None:
        # `value` is required and is therefore ALWAYS sent, `None` included:
        # for a "json" variable the server accepts `null` as a stored value, so
        # dropping it would make one of the four types partly unusable.
        instance, calls = client(responding({"var": VAR_BODY}, status=201))

        instance.vars.create("maybe", "json", None, description="d")

        self.assertEqual(
            sent_body(calls[0]),
            {"name": "maybe", "type": "json", "value": None, "description": "d"},
        )

    def test_create_surfaces_the_409_conflict_code_intact(self) -> None:
        instance, _calls = client(
            raising(
                http_error(
                    409,
                    {
                        "error": {
                            "code": "var_exists",
                            "message": 'A var named "sender_email" already exists.',
                        },
                    },
                ),
            ),
        )

        with self.assertRaises(ApiError) as caught:
            instance.vars.create("sender_email", "string", "a@b.c")

        self.assertEqual(caught.exception.status, 409)
        self.assertEqual(caught.exception.code, "var_exists")

    def test_update_sends_only_the_fields_supplied(self) -> None:
        instance, calls = client(responding({"var": VAR_BODY}))

        variable = instance.vars.update("var_1", value="c@d.e")

        self.assertEqual(variable, VAR)
        self.assertEqual(calls[0].get_method(), "PATCH")
        self.assertEqual(calls[0].full_url, "https://api.example.com/vars/var_1")
        # D2: `type` and `description` are ABSENT, not null. The server tests
        # `body.field !== undefined`, so a null would be an instruction.
        self.assertEqual(sent_body(calls[0]), {"value": "c@d.e"})

    def test_update_sends_an_explicit_null_when_the_value_is_set_to_none(self) -> None:
        # The other half of D2, and the operation it exists for: nulling a
        # "json" variable is a thing a caller can legitimately want, and a
        # signature defaulting `value` to `None` could not express it without
        # also nulling every field the caller did not mention.
        instance, calls = client(responding({"var": VAR_BODY}))

        instance.vars.update("var_1", value=None)

        self.assertEqual(sent_body(calls[0]), {"value": None})
        self.assertIn(b'"value": null', calls[0].data or b"")

    def test_update_with_no_fields_sends_an_empty_body(self) -> None:
        instance, calls = client(responding({"var": VAR_BODY}))

        instance.vars.update("var_1")

        self.assertEqual(sent_body(calls[0]), {})

    def test_update_distinguishes_unset_from_none_on_the_same_field(self) -> None:
        # The two intents, side by side, on one field — the assertion that
        # would fail if `UNSET` were ever "tidied" into `None`.
        instance, calls = client(responding({"var": VAR_BODY}))

        instance.vars.update("var_1", description=UNSET)
        instance.vars.update("var_1", description=None)

        self.assertEqual(sent_body(calls[0]), {})
        self.assertEqual(sent_body(calls[1]), {"description": None})

    def test_delete_returns_none_rather_than_the_ok_envelope(self) -> None:
        instance, calls = client(responding({"ok": True}))

        result = instance.vars.delete("var_1")

        self.assertIsNone(result)
        self.assertEqual(calls[0].get_method(), "DELETE")
        self.assertEqual(calls[0].full_url, "https://api.example.com/vars/var_1")

    def test_delete_of_an_unknown_id_raises_rather_than_succeeding_silently(self) -> None:
        # The delete is not idempotent and this namespace must not pretend
        # otherwise: a swallowed 404 would make `delete` a no-op that reports
        # success, which is the one outcome a caller cannot detect.
        instance, _calls = client(
            raising(http_error(404, {"error": {"code": "unknown_var", "message": "Not found."}})),
        )

        with self.assertRaises(ApiError) as caught:
            instance.vars.delete("var_missing")

        self.assertEqual(caught.exception.status, 404)
        self.assertEqual(caught.exception.code, "unknown_var")

    def test_an_unknown_id_raises_api_error_with_the_servers_code(self) -> None:
        instance, _calls = client(
            raising(http_error(404, {"error": {"code": "unknown_var", "message": "Var not found."}})),
        )

        with self.assertRaises(ApiError) as caught:
            instance.vars.get("var_missing")

        self.assertEqual(caught.exception.status, 404)
        self.assertEqual(caught.exception.code, "unknown_var")


class NoScopeParameterTest(unittest.TestCase):
    """Variables take no scoping query parameter — asserted, not assumed."""

    def test_no_operation_ever_sends_a_scoping_query_parameter(self) -> None:
        # The client below HAS a default configured (see `client()`), so this
        # case fails the moment any variable operation learns to forward it.
        instance, calls = client(responding({"var": VAR_BODY, "vars": []}))

        instance.vars.list()
        instance.vars.get("var_1")
        instance.vars.get_by_name("sender_email")
        instance.vars.create("n", "string", "v")
        instance.vars.update("var_1", value="v")
        instance.vars.delete("var_1")

        self.assertEqual(len(calls), 6)
        for call in calls:
            with self.subTest(url=call.full_url):
                # No query string at all: not the configured default, not an
                # empty one, not a differently-named one.
                self.assertNotIn("?", call.full_url)
                self.assertNotIn("prj_default", call.full_url)

    def test_the_namespace_holds_no_configuration_to_scope_a_call_with(self) -> None:
        # The structural half, stated precisely — this comment previously
        # claimed more than the code delivers (corrected 2026-07-27, T2.3.4,
        # conductor-authorised). `VarsApi` HOLDS no configuration: its only
        # attribute is a callable, and nothing typed `ResolvedConfig` is in it.
        #
        # It is not a capability barrier, and calling it one would be false:
        # `instance.vars._request.__self__` is the client, so `config` is
        # reachable in one hop from a bound method. What makes the asymmetry a
        # mechanism rather than a convention is the pair — the narrow host type
        # (`VarsRequest` is a callable, so a type checker rejects a namespace
        # that starts reading a client) and the wire assertions above, which
        # fail on the parameter itself no matter how it was obtained.
        instance, _calls = client(responding({"vars": []}))

        held = list(vars(instance.vars).values())

        self.assertEqual(len(held), 1)
        self.assertTrue(callable(held[0]))
        self.assertFalse(any(isinstance(value, ResolvedConfig) for value in held))
        self.assertFalse(hasattr(instance.vars, "config"))

    def test_the_namespace_is_constructible_from_a_bare_callable(self) -> None:
        # The same point from the other side: everything in this module works
        # with a transport alone. If `VarsApi` ever needed a client to be built,
        # this stops compiling — and so would the claim above.
        calls: List[Any] = []

        def request(method: str, path: str, query: Any = None, body: Any = None) -> Any:
            calls.append((method, path, query, body))
            return HttpResponse(200, {"vars": [VAR_BODY]})

        namespace = VarsApi(request)

        self.assertEqual(namespace.list(), [VAR])
        self.assertEqual(calls, [("GET", "/vars", None, None)])


class BadResponseTest(unittest.TestCase):
    """D3 — a `2xx` that does not carry what it promised."""

    def test_a_2xx_without_the_envelope_key_raises_bad_response(self) -> None:
        instance, _calls = client(responding({"variable": VAR_BODY}))

        with self.assertRaises(ApiError) as caught:
            instance.vars.get("var_1")

        self.assertEqual(caught.exception.code, "bad_response")
        self.assertEqual(caught.exception.status, 200)
        self.assertEqual(caught.exception.raw, {"variable": VAR_BODY})
        # The message must say the key was MISSING, not that its value had the
        # wrong type — the two bad-response shapes send a reader to different
        # places, and an `unwrap` that returned `None` rather than raising would
        # produce the wrong one a layer further down.
        self.assertIn('no "var"', caught.exception.message)

    def test_a_list_that_is_not_a_list_raises_bad_response(self) -> None:
        instance, _calls = client(responding({"vars": {"var_1": VAR_BODY}}))

        with self.assertRaises(ApiError) as caught:
            instance.vars.list()

        self.assertEqual(caught.exception.code, "bad_response")
        self.assertIn("not a list", caught.exception.message)

    def test_bad_response_stays_distinct_from_a_server_error_code(self) -> None:
        instance, _calls = client(
            raising(http_error(400, {"error": {"code": "invalid_name", "message": "Bad name."}})),
        )

        with self.assertRaises(ApiError) as caught:
            instance.vars.create("Bad Name", "string", "v")

        self.assertEqual(caught.exception.code, "invalid_name")
        self.assertNotEqual(caught.exception.code, "bad_response")


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
