"""`connections.get/delete`, `apps.by_ids`, `dashboard.stats`, `projects.list`,
`reliability.list/members` and `ConnectionSummary.built_in`.

Against an injected fake transport; no case opens a socket. Literal wire
expectations come from `endpoints.json`.
"""

from __future__ import annotations

import email.message
import io
import json
import unittest
from urllib.parse import parse_qs, urlsplit
from typing import Any, Callable, List, Tuple
from urllib.error import HTTPError
from urllib.request import Request

from w6w import ApiError, Client, ConfigError

BASE = "https://api.example.com"


class FakeResponse:
    """The minimum a transport must return: a status, a reason and a body."""

    def __init__(self, status: int, body: str = "", reason: str = "") -> None:
        self.status = status
        self.reason = reason
        self._body = body.encode("utf-8")

    def read(self) -> bytes:
        """Read the body once, as `urllib` would."""
        return self._body


def http_error(status: int, body: Any) -> HTTPError:
    """Build the exception `urlopen` raises for a non-2xx status."""
    return HTTPError(
        BASE, status, "", email.message.Message(), io.BytesIO(json.dumps(body).encode("utf-8"))
    )


def client(*outcomes: Any) -> Tuple[Client, List[Request]]:
    """A client whose transport answers each request with the next outcome.

    An outcome is `(status, body)` or an exception to raise. The last one repeats.
    """
    calls: List[Request] = []

    def transport(request: Request) -> Any:
        outcome = outcomes[min(len(calls), len(outcomes) - 1)]
        calls.append(request)
        if isinstance(outcome, BaseException):
            raise outcome
        status, body = outcome
        return FakeResponse(status, json.dumps(body))

    return Client(base_url=BASE, token="tok_1", project="prj_default", transport=transport), calls


def sent_body(request: Request) -> Any:
    """The JSON body a recorded request carried."""
    assert request.data is not None, "expected a request body"
    return json.loads(request.data.decode("utf-8"))

from w6w import ConnectionSummary

CONN = {
    "id": "conn_1",
    "appId": "sendgrid",
    "authKey": "api_key",
    "tenant": "default",
    "subject": "u1",
    "displayName": "SG",
    "state": "connected",
    "profile": {},
    "lastTestOk": True,
    "lastTestedAt": "t",
    "createdAt": "t",
    "updatedAt": "t",
}


def query_of(request: Request) -> Any:
    """The parsed query string of a recorded request."""
    return parse_qs(urlsplit(request.full_url).query)


class ConnectionsTest(unittest.TestCase):
    def test_get_unwraps_the_connection_envelope(self) -> None:
        c, calls = client((200, {"connection": CONN}))

        got = c.connections.get("conn_1")

        self.assertIsInstance(got, ConnectionSummary)
        self.assertEqual(got.id, "conn_1")
        self.assertEqual((calls[0].get_method(), calls[0].full_url), ("GET", f"{BASE}/connections/conn_1"))

    def test_get_encodes_the_id_into_the_path(self) -> None:
        c, calls = client((200, {"connection": CONN}))
        c.connections.get("zerocred:a/b")
        self.assertEqual(calls[0].full_url, f"{BASE}/connections/zerocred%3Aa%2Fb")

    def test_get_without_the_envelope_is_bad_response(self) -> None:
        c, _ = client((200, CONN))
        with self.assertRaises(ApiError) as caught:
            c.connections.get("conn_1")
        self.assertEqual(caught.exception.code, "bad_response")

    def test_delete_returns_none_and_sends_a_bare_delete(self) -> None:
        c, calls = client((200, {"ok": True}))

        self.assertIsNone(c.connections.delete("conn_1"))
        self.assertEqual((calls[0].get_method(), calls[0].full_url), ("DELETE", f"{BASE}/connections/conn_1"))
        self.assertIsNone(calls[0].data)

    def test_delete_force_sends_query_only_when_true(self) -> None:
        c, calls = client((200, {"ok": True, "disabled": []}), (200, {"ok": True}))
        self.assertIsNone(c.connections.delete("conn_1", force=True))
        self.assertIsNone(c.connections.delete("conn_1", force=False))
        self.assertEqual(calls[0].full_url, f"{BASE}/connections/conn_1?force=true")
        self.assertEqual(calls[1].full_url, f"{BASE}/connections/conn_1")

    def test_delete_409_exposes_dependents(self) -> None:
        deps = {"callables": [{"id": "fn_1", "kind": "function"}], "subscriptions": []}
        body = {"error": {"code": "connection_in_use", "message": "in use", "dependents": deps}}
        c, _ = client(http_error(409, body))
        with self.assertRaises(ApiError) as caught:
            c.connections.delete("conn_1")
        self.assertEqual((caught.exception.status, caught.exception.code), (409, "connection_in_use"))
        self.assertEqual(caught.exception.raw["error"]["dependents"], deps)

    def test_get_and_delete_keep_the_server_error_intact(self) -> None:
        body = {"error": {"code": "unknown_connection", "message": "No such connection."}}
        for op in ("get", "delete"):
            with self.subTest(op=op):
                c, _ = client(http_error(404, body))
                with self.assertRaises(ApiError) as caught:
                    getattr(c.connections, op)("conn_x")
                self.assertEqual(
                    (caught.exception.status, caught.exception.code, caught.exception.raw),
                    (404, "unknown_connection", body),
                )

    def test_built_in_is_true_for_a_wire_true_and_none_when_absent(self) -> None:
        self.assertIs(ConnectionSummary.from_wire({**CONN, "builtIn": True}).built_in, True)
        self.assertIsNone(ConnectionSummary.from_wire(CONN).built_in)

    def test_credential_id_reads_a_string_and_collapses_null_absent_and_non_string(self) -> None:
        self.assertEqual(
            ConnectionSummary.from_wire({**CONN, "credentialId": "cred_1"}).credentialId, "cred_1"
        )
        self.assertIsNone(ConnectionSummary.from_wire({**CONN, "credentialId": None}).credentialId)
        self.assertIsNone(ConnectionSummary.from_wire(CONN).credentialId)
        self.assertIsNone(ConnectionSummary.from_wire({**CONN, "credentialId": 7}).credentialId)

    def test_credential_id_rides_through_list(self) -> None:
        c, _ = client((200, {"connections": [{**CONN, "credentialId": "cred_1"}, CONN]}))
        rows = c.connections.list()
        self.assertEqual([r.credentialId for r in rows], ["cred_1", None])

    def test_access_scope_maps_known_values_and_defaults_to_none(self) -> None:
        for scope in ("account", "user"):
            self.assertEqual(ConnectionSummary.from_wire({**CONN, "accessScope": scope}).accessScope, scope)
        self.assertIsNone(ConnectionSummary.from_wire(CONN).accessScope)
        for bad in ("team", "", None, 1, ["user"]):
            self.assertIsNone(ConnectionSummary.from_wire({**CONN, "accessScope": bad}).accessScope)

    def test_keep_alive_fields_parse(self) -> None:
        body = {
            **CONN,
            "state": "broken",
            "autoRefresh": False,
            "lastRefreshedAt": "2026-11-01T10:00:00.000Z",
            "refreshFailingSince": "2026-11-02T10:00:00.000Z",
        }
        c, _ = client((200, {"connections": [body]}))
        row = c.connections.list()[0]
        self.assertIs(row.autoRefresh, False)
        self.assertEqual(row.lastRefreshedAt, "2026-11-01T10:00:00.000Z")
        self.assertEqual(row.refreshFailingSince, "2026-11-02T10:00:00.000Z")
        self.assertEqual(row.state, "broken")

        current = {**CONN, "autoRefresh": True, "lastRefreshedAt": None, "refreshFailingSince": None}
        c, _ = client((200, {"connection": current}))
        one = c.connections.get("conn_1")
        self.assertIs(one.autoRefresh, True)
        self.assertIsNone(one.lastRefreshedAt)
        self.assertIsNone(one.refreshFailingSince)

    def test_keep_alive_fields_absent_on_an_older_server_read_none(self) -> None:
        row = ConnectionSummary.from_wire(CONN)
        self.assertIsNone(row.autoRefresh)
        self.assertIsNone(row.lastRefreshedAt)
        self.assertIsNone(row.refreshFailingSince)
        # A malformed value never becomes a wrong answer.
        bad = ConnectionSummary.from_wire({**CONN, "autoRefresh": "yes", "lastRefreshedAt": 1})
        self.assertIsNone(bad.autoRefresh)
        self.assertIsNone(bad.lastRefreshedAt)

    def test_built_in_rides_through_list(self) -> None:
        c, _ = client((200, {"connections": [{**CONN, "id": "zerocred:x", "builtIn": True}, CONN]}))
        rows = c.connections.list()
        self.assertEqual([r.built_in for r in rows], [True, None])


class AppsByIdsTest(unittest.TestCase):
    def test_one_request_with_comma_joined_ids_unwrapping_apps(self) -> None:
        c, calls = client((200, {"apps": [{"id": "a"}, {"id": "b"}], "nextCursor": None}))

        self.assertEqual(c.apps.by_ids(["a", "b"]), [{"id": "a"}, {"id": "b"}])
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0].get_method(), "GET")
        self.assertEqual(calls[0].full_url, f"{BASE}/apps?ids=a%2Cb")

    def test_a_bare_string_raises_config_error_with_no_request(self) -> None:
        c, calls = client((200, {"apps": [{"id": "never"}]}))

        with self.assertRaises(ConfigError):
            c.apps.by_ids("abc")  # type: ignore[arg-type]
        self.assertEqual(calls, [])

    def test_empty_set_is_empty_list_with_no_request(self) -> None:
        c, calls = client((200, {"apps": [{"id": "never"}]}))

        self.assertEqual(c.apps.by_ids([]), [])
        self.assertEqual(calls, [])

    def test_duplicates_are_collapsed_keeping_first_order(self) -> None:
        c, calls = client((200, {"apps": []}))
        c.apps.by_ids(["b", "a", "b", "a"])
        self.assertEqual(query_of(calls[0]), {"ids": ["b,a"]})

    def test_a_set_that_collapses_to_nothing_new_still_makes_one_request(self) -> None:
        c, calls = client((200, {"apps": []}))
        c.apps.by_ids(["a", "a", "a"])
        self.assertEqual(len(calls), 1)

    def test_chunks_of_at_most_100_in_order_and_results_concatenate(self) -> None:
        ids = [f"app{i}" for i in range(250)]
        pages = [{"apps": [{"id": "c0"}]}, {"apps": [{"id": "c1"}]}, {"apps": [{"id": "c2"}]}]
        c, calls = client((200, pages[0]), (200, pages[1]), (200, pages[2]))

        got = c.apps.by_ids(ids)

        self.assertEqual([a["id"] for a in got], ["c0", "c1", "c2"])
        sizes = [len(query_of(r)["ids"][0].split(",")) for r in calls]
        self.assertEqual(sizes, [100, 100, 50])
        self.assertEqual(query_of(calls[0])["ids"][0].split(",")[0], "app0")
        self.assertEqual(query_of(calls[2])["ids"][0].split(",")[-1], "app249")

    def test_exactly_100_is_one_request(self) -> None:
        c, calls = client((200, {"apps": []}))
        c.apps.by_ids([f"a{i}" for i in range(100)])
        self.assertEqual(len(calls), 1)

    def test_an_error_mid_chunks_surfaces_unchanged(self) -> None:
        body = {"error": {"code": "too_many_ids", "message": "Too many."}}
        c, calls = client((200, {"apps": []}), http_error(400, body))
        with self.assertRaises(ApiError) as caught:
            c.apps.by_ids([f"a{i}" for i in range(150)])
        self.assertEqual((caught.exception.status, caught.exception.raw), (400, body))
        self.assertEqual(len(calls), 2)

    def test_a_body_without_apps_is_bad_response(self) -> None:
        c, _ = client((200, {"nope": []}))
        with self.assertRaises(ApiError) as caught:
            c.apps.by_ids(["a"])
        self.assertEqual(caught.exception.code, "bad_response")


class DashboardTest(unittest.TestCase):
    STATS = {"range": {}, "headline": {}, "series": [], "recent": []}

    def test_no_arguments_sends_no_query_and_no_project(self) -> None:
        c, calls = client((200, self.STATS))

        self.assertEqual(c.dashboard.stats(), self.STATS)
        # The client has a default project; it must not leak onto this route.
        self.assertEqual(calls[0].full_url, f"{BASE}/dashboard/stats")
        self.assertEqual(calls[0].get_method(), "GET")

    def test_each_argument_is_sent_only_when_given_under_its_wire_name(self) -> None:
        c, calls = client((200, self.STATS))
        c.dashboard.stats(from_="2026-01-01T00:00:00Z", to="2026-02-01T00:00:00Z", bucket="week")
        self.assertEqual(
            query_of(calls[0]),
            {"from": ["2026-01-01T00:00:00Z"], "to": ["2026-02-01T00:00:00Z"], "bucket": ["week"]},
        )
        c.dashboard.stats(bucket="day")
        self.assertEqual(query_of(calls[1]), {"bucket": ["day"]})

    def test_error_is_intact_and_non_object_is_bad_response(self) -> None:
        body = {"error": {"code": "invalid_range", "message": "Bad."}}
        c, _ = client(http_error(400, body))
        with self.assertRaises(ApiError) as caught:
            c.dashboard.stats()
        self.assertEqual((caught.exception.status, caught.exception.raw), (400, body))
        c, _ = client((200, []))
        with self.assertRaises(ApiError) as caught:
            c.dashboard.stats()
        self.assertEqual(caught.exception.code, "bad_response")


class ProjectsTest(unittest.TestCase):
    def test_list_unwraps_the_projects_envelope(self) -> None:
        rows = [{"id": "prj_1", "name": "Default", "isDefault": True}]
        c, calls = client((200, {"projects": rows}))

        self.assertEqual(c.projects.list(), rows)
        self.assertEqual((calls[0].get_method(), calls[0].full_url), ("GET", f"{BASE}/projects"))

    def test_error_is_intact_and_missing_envelope_is_bad_response(self) -> None:
        body = {"error": {"code": "unauthorized", "message": "No."}}
        c, _ = client(http_error(401, body))
        with self.assertRaises(ApiError) as caught:
            c.projects.list()
        self.assertEqual((caught.exception.status, caught.exception.raw), (401, body))
        c, _ = client((200, {}))
        with self.assertRaises(ApiError) as caught:
            c.projects.list()
        self.assertEqual(caught.exception.code, "bad_response")


class ReliabilityTest(unittest.TestCase):
    BOARD = {"services": []}

    def test_list_sends_project_and_comma_joined_apps(self) -> None:
        c, calls = client((200, self.BOARD))

        self.assertEqual(c.reliability.list("prj_1", ["a", "b"]), self.BOARD)
        self.assertEqual(calls[0].get_method(), "GET")
        self.assertEqual(
            calls[0].full_url, f"{BASE}/reliability/services?project=prj_1&apps=a%2Cb"
        )

    def test_list_sends_days_and_limit_as_strings_only_when_given(self) -> None:
        c, calls = client((200, self.BOARD))
        c.reliability.list("prj_1", ["a"], days=7, limit=3)
        self.assertEqual(query_of(calls[0]), {"project": ["prj_1"], "apps": ["a"], "days": ["7"], "limit": ["3"]})

    def test_list_sends_exactly_the_ids_given_with_no_batching(self) -> None:
        ids = [f"a{i}" for i in range(11)]
        c, calls = client((200, self.BOARD))
        c.reliability.list("prj_1", ids)
        self.assertEqual(len(calls), 1)
        self.assertEqual(query_of(calls[0])["apps"], [",".join(ids)])

    def test_the_servers_400_surfaces_unchanged(self) -> None:
        body = {"error": {"code": "invalid_app_filter", "message": "1 to 10 ids."}}
        c, _ = client(http_error(400, body))
        with self.assertRaises(ApiError) as caught:
            c.reliability.list("prj_1", [])
        self.assertEqual(
            (caught.exception.status, caught.exception.code, caught.exception.raw),
            (400, "invalid_app_filter", body),
        )

    def test_members_wire(self) -> None:
        members = {"appIds": ["a", "b"]}
        c, calls = client((200, members))

        self.assertEqual(c.reliability.members("prj_1"), members)
        self.assertEqual(
            (calls[0].get_method(), calls[0].full_url),
            ("GET", f"{BASE}/reliability/services/members?project=prj_1"),
        )
        c.reliability.members("prj_1", days=30)
        self.assertEqual(query_of(calls[1]), {"project": ["prj_1"], "days": ["30"]})

    def test_non_object_bodies_are_bad_response(self) -> None:
        for op in (lambda c: c.reliability.list("p", ["a"]), lambda c: c.reliability.members("p")):
            c, _ = client((200, []))
            with self.assertRaises(ApiError) as caught:
                op(c)
            self.assertEqual(caught.exception.code, "bad_response")


if __name__ == "__main__":  # pragma: no cover - convenience for a single-file run.
    unittest.main()
