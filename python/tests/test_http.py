"""The transport, against an **injected fake transport**.

No test here (or anywhere in this package) requires a live server or opens a
socket (`docs/implementation.md` §9): every case hands `_request` a callable
that records the `urllib.request.Request` it was given and returns — or raises —
whatever the case is about. The real `urlopen` is never called.

Each case asserts either the request the wrapper *made* (method, full URL,
headers, serialised body) or the outcome it produced, including all three pinned
failure modes and the `urllib`-specific `HTTPError` trap.
"""

from __future__ import annotations

import email.message
import io
import json
import socket
import unittest
from typing import Any, Callable, List, Optional
from urllib.error import HTTPError, URLError
from urllib.request import Request

from w6w import ApiError, Client, ConfigError, HttpResponse, path
from w6w._config import resolve_config
from w6w._http import _request, build_url, default_transport

CONFIG = resolve_config(base_url="https://api.example.com", token="tok_1")

#: What a Cloudflare/proxy error page looks like: long, HTML, not JSON.
HTML_ERROR_PAGE = "<!DOCTYPE html><html><body>" + ("error " * 100) + "</body></html>"


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


def responding(
    body: Any,
    status: int = 200,
    reason: str = "",
) -> Recorder:
    """A transport that answers every request with one JSON body."""
    text = json.dumps(body)
    return Recorder(lambda _request: FakeResponse(status, text, reason))


def raising(error: BaseException) -> Recorder:
    """A transport that raises — a transport failure, or `urlopen`'s `HTTPError`."""

    def _raise(_request: Request) -> Any:
        raise error

    return Recorder(_raise)


def http_error(status: int, body: str, reason: str = "") -> HTTPError:
    """Build the exception `urlopen` raises for a non-2xx status.

    An `HTTPError` **is** a response: it carries the status, the reason and a
    readable body. Constructing a real one (rather than a stand-in) is the point
    of the test that uses it.
    """
    return HTTPError(
        "https://api.example.com/x",
        status,
        reason,
        email.message.Message(),
        io.BytesIO(body.encode("utf-8")),
    )


class SuccessTest(unittest.TestCase):
    """`2xx` outcomes — including the ones a naive client mistakes for errors."""

    def test_a_200_returns_the_parsed_body_the_status_and_sends_the_bearer(self) -> None:
        transport = responding({"vars": [{"id": "var_1"}]})

        response = _request(CONFIG, transport, "GET", "/vars")

        self.assertIsInstance(response, HttpResponse)
        self.assertEqual(response.status, 200)
        self.assertEqual(response.body, {"vars": [{"id": "var_1"}]})
        self.assertEqual(len(transport.calls), 1)
        sent = transport.calls[0]
        self.assertEqual(sent.full_url, "https://api.example.com/vars")
        self.assertEqual(sent.get_method(), "GET")
        self.assertEqual(sent.get_header("Authorization"), "Bearer tok_1")
        # No body, no Content-Type: a GET must not advertise one. (urllib
        # capitalises header names via str.capitalize(), so the stored key is
        # "Content-type" — worth knowing before writing the next assertion.)
        self.assertIsNone(sent.get_header("Content-type"))
        self.assertIsNone(sent.data)

    def test_a_202_is_success_and_its_status_reaches_the_caller(self) -> None:
        # 202 means the run is queued and still going — a normal outcome on this
        # API, not an error. The status is the only thing distinguishing it from
        # a 200, so a status-losing signature would make `workflows.run`
        # impossible to implement correctly.
        transport = responding({"runId": "run_1", "status": "queued"}, status=202)

        response = _request(
            CONFIG,
            transport,
            "POST",
            "/workflows/wf_1/run",
            query={"wait": True},
            body={"variables": {"a": 1}},
        )

        self.assertEqual(response.status, 202)
        self.assertEqual(response.body, {"runId": "run_1", "status": "queued"})
        sent = transport.calls[0]
        self.assertEqual(
            sent.full_url,
            "https://api.example.com/workflows/wf_1/run?wait=true",
        )
        self.assertEqual(sent.get_method(), "POST")
        self.assertEqual(sent.get_header("Content-type"), "application/json")
        self.assertEqual(sent.data, b'{"variables": {"a": 1}}')

    def test_a_failed_run_is_data_and_does_not_raise(self) -> None:
        # A run that failed comes back 200 with status "failed" in the envelope.
        # Mapping it to an exception is the most common way a thin client gets
        # this API wrong (§4).
        transport = responding({"runId": "run_1", "status": "failed", "error": "boom"})

        response = _request(CONFIG, transport, "POST", "/workflows/wf_1/run")

        self.assertEqual(response.status, 200)
        self.assertEqual(response.body["status"], "failed")

    def test_a_2xx_with_an_empty_body_returns_successfully(self) -> None:
        # A 204-style empty body must not blow up json.loads on the way out.
        transport = Recorder(lambda _request: FakeResponse(204, ""))

        response = _request(CONFIG, transport, "DELETE", "/vars/var_1")

        self.assertEqual(response.status, 204)
        self.assertIsNone(response.body)
        self.assertEqual(transport.calls[0].get_method(), "DELETE")

    def test_a_non_json_body_on_an_ok_status_is_not_an_error(self) -> None:
        transport = Recorder(lambda _request: FakeResponse(200, "plain text"))

        response = _request(CONFIG, transport, "GET", "/vars")

        self.assertEqual(response.status, 200)
        self.assertIsNone(response.body)


class FailureModeTest(unittest.TestCase):
    """The three failure modes of §3 — and nothing else raises."""

    def test_an_error_envelope_becomes_an_apierror_that_keeps_the_raw_body(self) -> None:
        raw = {"error": {"code": "unknown_document", "message": "No such document."}, "logs": ["x"]}
        transport = responding(raw, status=404, reason="Not Found")

        with self.assertRaises(ApiError) as caught:
            _request(CONFIG, transport, "GET", "/documents/doc_x")

        err = caught.exception
        self.assertEqual(err.status, 404)
        self.assertEqual(err.code, "unknown_document")
        self.assertEqual(err.message, "No such document.")
        # The raw body is kept because error bodies carry fields the message
        # drops (an invoke failure rides alongside `logs` and `apiCalls`).
        self.assertEqual(err.raw, raw)
        self.assertEqual(str(err), "[404 unknown_document] No such document.")

    def test_an_error_body_with_no_envelope_falls_back_to_error_and_the_reason(self) -> None:
        transport = responding({}, status=500, reason="Internal Server Error")

        with self.assertRaises(ApiError) as caught:
            _request(CONFIG, transport, "GET", "/vars")

        err = caught.exception
        self.assertEqual(err.status, 500)
        self.assertEqual(err.code, "error")
        self.assertEqual(err.message, "Internal Server Error")
        self.assertEqual(err.raw, {})

    def test_a_non_ok_status_with_no_body_is_error_and_never_bad_response(self) -> None:
        # The boundary between the two codes, pinned so a refactor cannot flip
        # it: "bad_response" means the server sent something and it was
        # unusable, so there has to be a something. An empty 503 is an ordinary
        # unenveloped failure — calling it a malformed response would send a
        # reader hunting for a body that never existed.
        for status, reason in ((503, "Service Unavailable"), (500, ""), (404, "Not Found")):
            with self.subTest(status=status):
                transport = Recorder(lambda _request: FakeResponse(status, "", reason))
                with self.assertRaises(ApiError) as caught:
                    _request(CONFIG, transport, "GET", "/vars")
                err = caught.exception
                self.assertEqual(err.status, status)
                self.assertEqual(err.code, "error")
                self.assertNotEqual(err.code, "bad_response")
                self.assertEqual(err.message, reason or "HTTP {0}".format(status))
                self.assertIsNone(err.raw)

    def test_a_non_json_error_body_is_bad_response_with_a_capped_snippet(self) -> None:
        # Reporting this as an opaque JSONDecodeError would throw away the only
        # diagnostic present — the page itself.
        transport = Recorder(
            lambda _request: FakeResponse(502, HTML_ERROR_PAGE, reason="Bad Gateway"),
        )

        with self.assertRaises(ApiError) as caught:
            _request(CONFIG, transport, "GET", "/vars")

        err = caught.exception
        self.assertEqual(err.status, 502)
        self.assertEqual(err.code, "bad_response")
        self.assertIn("non-JSON 502", err.message)
        self.assertIn(HTML_ERROR_PAGE[:200], err.message)
        self.assertNotIn(HTML_ERROR_PAGE, err.message)  # capped at 200 characters
        self.assertIsNone(err.raw)

    def test_a_urlerror_is_network_error_with_status_zero_naming_method_and_url(self) -> None:
        transport = raising(URLError("Connection refused"))

        with self.assertRaises(ApiError) as caught:
            _request(CONFIG, transport, "GET", "/vars")

        err = caught.exception
        self.assertEqual(err.status, 0)
        self.assertEqual(err.code, "network_error")
        # A bare URLError is useless on its own — the message has to say which
        # request, to where.
        self.assertIn("GET https://api.example.com/vars", err.message)
        self.assertIn("Connection refused", err.message)
        self.assertIsNone(err.raw)

    def test_a_socket_timeout_and_a_refused_connection_are_network_errors_too(self) -> None:
        for error in (socket.timeout("timed out"), ConnectionRefusedError("refused")):
            with self.subTest(error=type(error).__name__):
                transport = raising(error)
                with self.assertRaises(ApiError) as caught:
                    _request(CONFIG, transport, "GET", "/vars")
                self.assertEqual(caught.exception.status, 0)
                self.assertEqual(caught.exception.code, "network_error")

    def test_an_httperror_404_reaches_the_envelope_mapper_and_not_network_error(self) -> None:
        # THE urllib TRAP. urlopen RAISES HTTPError for any non-2xx, and
        # HTTPError is a subclass of URLError — so a `except URLError` written
        # first would report every 404 as "the server is unreachable" and throw
        # the error envelope away. HTTPError is itself a response: its body has
        # to be read off the exception, not lost.
        raw = {"error": {"code": "unknown_var", "message": "No such var."}}
        transport = raising(http_error(404, json.dumps(raw), "Not Found"))

        with self.assertRaises(ApiError) as caught:
            _request(CONFIG, transport, "GET", "/vars/var_x")

        err = caught.exception
        self.assertNotEqual(err.code, "network_error")
        self.assertNotEqual(err.status, 0)
        self.assertEqual(err.status, 404)
        self.assertEqual(err.code, "unknown_var")
        self.assertEqual(err.message, "No such var.")
        self.assertEqual(err.raw, raw)

    def test_an_httperror_with_an_html_body_is_bad_response_not_network_error(self) -> None:
        transport = raising(http_error(502, HTML_ERROR_PAGE, "Bad Gateway"))

        with self.assertRaises(ApiError) as caught:
            _request(CONFIG, transport, "GET", "/vars")

        self.assertEqual(caught.exception.status, 502)
        self.assertEqual(caught.exception.code, "bad_response")

    def test_a_424_is_an_apierror_with_its_code_preserved(self) -> None:
        # 424 = the target app or its upstream vendor failed during execute. It
        # is a 4xx on purpose: Cloudflare replaces an origin 5xx with a
        # CORS-less HTML page, which would strip the real message. Passing it
        # through intact is the whole point, so it must never be normalised into
        # a 5xx or into a transport error.
        raw = {"error": {"code": "app_error", "message": "Stripe said no."}, "apiCalls": []}
        transport = raising(http_error(424, json.dumps(raw), "Failed Dependency"))

        with self.assertRaises(ApiError) as caught:
            _request(CONFIG, transport, "POST", "/run", body={"urn": "conn_1"})

        err = caught.exception
        self.assertEqual(err.status, 424)
        self.assertEqual(err.code, "app_error")
        self.assertEqual(err.message, "Stripe said no.")
        self.assertEqual(err.raw, raw)

    def test_a_401_raises_and_has_no_side_effect(self) -> None:
        # A library has nowhere to redirect to: no callback, no refresh, no
        # retry. One request, one raise (§3, §8).
        transport = raising(
            http_error(401, json.dumps({"error": {"code": "unauthorized"}}), "Unauthorized"),
        )

        with self.assertRaises(ApiError) as caught:
            _request(CONFIG, transport, "GET", "/me")

        self.assertEqual(caught.exception.status, 401)
        self.assertEqual(caught.exception.code, "unauthorized")
        self.assertEqual(len(transport.calls), 1)  # no retry

    def test_a_transport_returning_no_status_is_reported_as_a_bad_response(self) -> None:
        # Enforces the transport seam's contract: a fake that forgets `.status`
        # gets a named error, not an AttributeError three frames away.
        transport = Recorder(lambda _request: object())

        with self.assertRaises(ApiError) as caught:
            _request(CONFIG, transport, "GET", "/vars")

        self.assertEqual(caught.exception.status, 0)
        self.assertEqual(caught.exception.code, "bad_response")


class TokenTest(unittest.TestCase):
    """The credential is attached per request, and its absence stops the request."""

    def test_a_request_with_no_token_raises_before_reaching_the_transport(self) -> None:
        unauthenticated = resolve_config(base_url="https://api.example.com", environ={})
        transport = responding({})

        with self.assertRaises(ConfigError) as caught:
            _request(unauthenticated, transport, "GET", "/vars")

        self.assertIn("W6W_TOKEN", str(caught.exception))
        self.assertEqual(transport.calls, [])

    def test_a_token_with_a_newline_never_reaches_the_transport(self) -> None:
        # Header injection, stopped in this package's own error model rather
        # than by a ValueError from inside http.client at send time — which
        # this suite, having no send, would never see at all.
        injected = resolve_config(
            base_url="https://api.example.com",
            token="tok_1\r\nX-Injected: yes",
        )
        transport = responding({})

        with self.assertRaises(ConfigError) as caught:
            _request(injected, transport, "GET", "/vars")

        self.assertIn("control character", str(caught.exception))
        self.assertEqual(transport.calls, [])

    def test_a_valid_token_is_sent_verbatim_as_a_bearer(self) -> None:
        config = resolve_config(base_url="https://api.example.com", token="eyJ.abc-_=.sig")
        transport = responding({})

        _request(config, transport, "GET", "/me")

        self.assertEqual(
            transport.calls[0].get_header("Authorization"),
            "Bearer eyJ.abc-_=.sig",
        )


class PathEncodingTest(unittest.TestCase):
    """One primitive, and it encodes at the point of interpolation."""

    def test_path_percent_encodes_every_interpolation(self) -> None:
        # Not defensive ceremony: unencoded, each of these silently addresses a
        # DIFFERENT route than the caller asked for, with no error anywhere.
        self.assertEqual(path("/documents/by-key/{key}", key="a/b"), "/documents/by-key/a%2Fb")
        self.assertEqual(path("/documents/by-key/{key}", key="a b"), "/documents/by-key/a%20b")
        self.assertEqual(
            path("/documents/by-key/{key}", key="a?x=1"),
            "/documents/by-key/a%3Fx%3D1",
        )
        self.assertEqual(path("/documents/by-key/{key}", key="a#f"), "/documents/by-key/a%23f")
        # Server-safe values are encoded anyway — the rule is "every
        # interpolation", not "every interpolation the server currently allows
        # to be unsafe". Encoding a safe value costs one call and changes
        # nothing; the day the server's validator relaxes, a wrapper that
        # encoded selectively becomes wrong silently, in a release it was not
        # part of.
        self.assertEqual(path("/vars/by-name/{name}", name="my_var"), "/vars/by-name/my_var")
        self.assertEqual(path("/documents/{id}/x", id="doc_1"), "/documents/doc_1/x")
        # Author-controlled fragments are left alone; only interpolations are
        # encoded. A path with no placeholders passes through untouched.
        self.assertEqual(path("/vars"), "/vars")

    def test_the_encoder_is_quote_with_safe_empty_not_the_default(self) -> None:
        # `urllib.parse.quote` defaults to safe="/", which leaves the separator
        # alone because its usual job is a whole path. That default *looks*
        # encoded and still has the a/b bug, so it is pinned here rather than
        # left to each author's judgement.
        from urllib.parse import quote

        self.assertEqual(quote("a/b"), "a/b")  # the near-miss
        self.assertEqual(quote("a/b", safe=""), "a%2Fb")  # what this package does
        self.assertIn("a%2Fb", path("/documents/by-key/{key}", key="a/b"))

    def test_path_raises_when_placeholders_and_values_disagree(self) -> None:
        # A typo must fail loudly rather than ship a literal "{key}" in a URL.
        with self.assertRaises(ValueError):
            path("/documents/by-key/{key}")
        with self.assertRaises(ValueError):
            path("/documents/by-key/{key}", key="k", project="p")
        with self.assertRaises(ValueError):
            path("/vars", id="var_1")

    def test_an_unsafe_key_is_encoded_and_sent_never_rejected(self) -> None:
        # A wrapper must not reject a key the server accepts: the server's
        # validateKey trims, rejects empty and caps at 128 characters, and
        # restricts nothing else — so "../.." is a document a user can
        # legitimately create. Refusing it locally would make that document
        # permanently unreadable through this client, with no server-side trace.
        transport = responding({"document": {"id": "doc_1"}})

        response = _request(
            CONFIG,
            transport,
            "GET",
            path("/documents/by-key/{key}", key="../.."),
            query={"project": "prj_a b"},
        )

        self.assertEqual(response.status, 200)
        self.assertEqual(
            transport.calls[0].full_url,
            "https://api.example.com/documents/by-key/..%2F..?project=prj_a+b",
        )
        # urllib does not normalise the path away, so the encoded segment
        # reaches the server verbatim and the server decides what it means.
        self.assertEqual(
            transport.calls[0].selector,
            "/documents/by-key/..%2F..?project=prj_a+b",
        )


class QueryTest(unittest.TestCase):
    """Query strings: encoded, `None` dropped, booleans lowercase."""

    def test_none_values_are_dropped(self) -> None:
        self.assertEqual(
            build_url(CONFIG, "/documents", {"project": None}),
            "https://api.example.com/documents",
        )

    def test_values_are_encoded_and_booleans_are_wire_shaped(self) -> None:
        self.assertEqual(
            build_url(CONFIG, "/documents", {"project": "p/1", "wait": True}),
            "https://api.example.com/documents?project=p%2F1&wait=true",
        )
        # str(False) would be "False", which is not what the server reads.
        self.assertEqual(
            build_url(CONFIG, "/workflows/wf_1/run", {"wait": False}),
            "https://api.example.com/workflows/wf_1/run?wait=false",
        )


class ClientTest(unittest.TestCase):
    """`Client` holds instance state and defaults its transport to `urllib`."""

    def test_the_client_routes_requests_through_its_injected_transport(self) -> None:
        transport = responding({"tenant": "t_1"})
        client = Client(base_url="https://api.example.com/", token="tok_c", transport=transport)

        response = client.request("GET", "/me")

        self.assertEqual(response.body, {"tenant": "t_1"})
        self.assertEqual(client.config.base_url, "https://api.example.com")
        self.assertEqual(transport.calls[0].full_url, "https://api.example.com/me")
        self.assertEqual(transport.calls[0].get_header("Authorization"), "Bearer tok_c")

    def test_the_transport_defaults_to_urllib(self) -> None:
        # Asserted by identity, never by calling it: this suite opens no socket.
        client = Client(base_url="https://api.example.com", token="tok_c")
        self.assertIs(client.transport, default_transport)

    def test_two_clients_in_one_process_hold_different_credentials(self) -> None:
        # The mechanism pin, tested end to end: this is what actually prevents
        # the module-global-credential regression the browser client has.
        first_transport = responding({"tenant": "t_1"})
        second_transport = responding({"tenant": "t_2"})
        first = Client(
            base_url="https://one.example.com",
            token="tok_1",
            transport=first_transport,
        )
        second = Client(
            base_url="https://two.example.com",
            token="tok_2",
            transport=second_transport,
        )

        first.request("GET", "/me")
        second.request("GET", "/me")
        first.request("GET", "/me")  # again, after the second client existed

        self.assertEqual(
            [call.get_header("Authorization") for call in first_transport.calls],
            ["Bearer tok_1", "Bearer tok_1"],
        )
        self.assertEqual(
            [call.get_header("Authorization") for call in second_transport.calls],
            ["Bearer tok_2"],
        )
        self.assertEqual(first_transport.calls[0].full_url, "https://one.example.com/me")
        self.assertEqual(second_transport.calls[0].full_url, "https://two.example.com/me")

    def test_a_client_with_no_base_url_never_reaches_the_transport(self) -> None:
        # Belt and braces on "no request is ever made with a relative URL": the
        # failure happens at construction, before a transport is even stored.
        transport = responding({})
        with self.assertRaises(ConfigError) as caught:
            Client(base_url="", transport=transport)
        self.assertIn("W6W_BASE_URL", str(caught.exception))
        self.assertEqual(transport.calls, [])


class TypingTest(unittest.TestCase):
    """The signatures this package publishes are annotated, not implied."""

    def test_every_public_callable_is_fully_annotated(self) -> None:
        import inspect

        import w6w

        unannotated: List[str] = []
        for name in w6w.__all__:
            symbol: Optional[Any] = getattr(w6w, name)
            candidates = [(name, symbol)]
            if inspect.isclass(symbol):
                candidates = [
                    ("{0}.{1}".format(name, attr), getattr(symbol, attr))
                    # Public methods only: a NamedTuple's stdlib-generated
                    # `_replace` / `_asdict` are not this package's signatures.
                    for attr in vars(symbol)
                    if callable(getattr(symbol, attr)) and not attr.startswith("_")
                ]
                init = symbol.__dict__.get("__init__")
                if init is not None:
                    candidates.append(("{0}.__init__".format(name), init))
            for label, candidate in candidates:
                if not inspect.isfunction(candidate):
                    continue
                # Only signatures THIS PACKAGE wrote. `typing.Protocol` injects
                # its own `__init__` (`typing._no_init_or_replace_init`, spelled
                # `(self, *args, **kwargs)` with no annotations) into every
                # protocol class, so without this filter the gate reports a
                # stdlib function as an unannotated public signature the moment
                # a protocol is exported — a false positive it cannot act on,
                # and one that would push someone into un-exporting a type to
                # silence it.
                if not getattr(candidate, "__module__", "").startswith("w6w"):
                    continue
                signature = inspect.signature(candidate)
                for parameter in signature.parameters.values():
                    if parameter.name in ("self", "cls"):
                        continue
                    if parameter.annotation is inspect.Signature.empty:
                        unannotated.append("{0}({1})".format(label, parameter.name))
                if signature.return_annotation is inspect.Signature.empty:
                    unannotated.append("{0} -> ?".format(label))
        self.assertEqual(unannotated, [])


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
