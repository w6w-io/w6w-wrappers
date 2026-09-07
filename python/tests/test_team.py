"""`client.team.*`, against an **injected fake transport**.

No case here needs a live server or opens a socket
(`docs/implementation.md` §9) — every `team.*` route is `status: "planned"`
in `endpoints.json` today, so this is exactly the kind of test that
discipline exists for. Each case asserts the request the wrapper *made*
(method, full resolved URL, bearer, serialised body) **and** the value it
returned, which is always the unwrapped payload and never the server's
envelope.
"""

from __future__ import annotations

import email.message
import io
import json
import unittest
from typing import Any, Callable, List, Tuple
from urllib.error import HTTPError
from urllib.request import Request

from w6w import ApiError, Client, TeamInvite, TeamInviteWithLink, TeamMember

#: One member, as the server sends it — camelCase keys included.
MEMBER_BODY = {
    "userId": "usr_1",
    "email": "owner@example.com",
    "displayName": "Ada Owner",
    "role": "owner",
    "createdAt": "2026-07-01T12:00:00.000Z",
}

MEMBER = TeamMember(
    user_id="usr_1",
    email="owner@example.com",
    display_name="Ada Owner",
    role="owner",
    created_at="2026-07-01T12:00:00.000Z",
)

INVITE_BODY = {
    "id": "inv_1",
    "account": "acc_1",
    "email": "new@example.com",
    "role": "admin",
    "expiresAt": None,
    "createdAt": "2026-08-01T09:00:00.000Z",
}

INVITE = TeamInvite(
    id="inv_1",
    account="acc_1",
    email="new@example.com",
    role="admin",
    expires_at=None,
    created_at="2026-08-01T09:00:00.000Z",
)

INVITE_WITH_LINK_BODY = {**INVITE_BODY, "token": "tok_plaintext", "redemptionLink": "https://app.example.com/join?token=tok_plaintext"}

INVITE_WITH_LINK = TeamInviteWithLink(
    id="inv_1",
    account="acc_1",
    email="new@example.com",
    role="admin",
    expires_at=None,
    created_at="2026-08-01T09:00:00.000Z",
    token="tok_plaintext",
    redemption_link="https://app.example.com/join?token=tok_plaintext",
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
        "https://api.example.com/me/account/members",
        status,
        reason,
        email.message.Message(),
        io.BytesIO(json.dumps(body).encode("utf-8")),
    )


def client(respond: Callable[[Request], Any]) -> Tuple[Client, List[Request]]:
    """A client wired to a fake transport. No `project` — team ops take none."""
    transport = Recorder(respond)
    return (
        Client(base_url="https://api.example.com", token="tok_1", transport=transport),
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
        # Deliberately a runtime assertion, not a type-level one: a namespace
        # that silently lost a method would still typecheck in every OTHER
        # case in this file. The names are `naming.python`'s, character for
        # character.
        instance = Client(base_url="https://api.example.com", token="t")

        for name in ("members", "invite", "invites", "revoke_invite", "set_role", "remove_member"):
            with self.subTest(operation=name):
                self.assertTrue(
                    callable(getattr(instance.team, name, None)),
                    "team.{0} is missing".format(name),
                )


class NoProjectScopeTest(unittest.TestCase):
    """Team ops carry no `project` parameter and send no `?project=`."""

    def test_no_project_query_is_ever_sent_even_though_the_client_has_a_default(self) -> None:
        transport = Recorder(
            responding({"members": [MEMBER_BODY], "invites": [INVITE_BODY], "ok": True}),
        )
        instance = Client(
            base_url="https://api.example.com",
            token="tok_1",
            project="prj_default",
            transport=transport,
        )

        instance.team.members()
        instance.team.invites()
        instance.team.revoke_invite("inv_1")
        instance.team.remove_member("usr_2")

        for call in transport.calls:
            with self.subTest(url=call.full_url):
                self.assertNotIn("project", call.full_url)


class MembersTest(unittest.TestCase):
    """`team.members()` — the roster, read-only."""

    def test_members_unwraps_the_envelope_and_returns_the_roster(self) -> None:
        instance, calls = client(responding({"members": [MEMBER_BODY]}))

        members = instance.team.members()

        self.assertEqual(members, [MEMBER])
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0].get_method(), "GET")
        self.assertEqual(calls[0].full_url, "https://api.example.com/me/account/members")
        self.assertEqual(calls[0].get_header("Authorization"), "Bearer tok_1")

    def test_a_member_with_no_email_or_display_name_keeps_them_none_not_empty_string(self) -> None:
        body = {**MEMBER_BODY, "email": None, "displayName": None}
        instance, _calls = client(responding({"members": [body]}))

        member = instance.team.members()[0]

        self.assertIsNone(member.email)
        self.assertIsNone(member.display_name)


class InviteTest(unittest.TestCase):
    """`team.invite()` — both fields optional, and the response's link is one-time."""

    def test_invite_sends_both_fields_and_accepts_201(self) -> None:
        instance, calls = client(responding({"invite": INVITE_WITH_LINK_BODY}, status=201))

        invite = instance.team.invite(email="new@example.com", role="admin")

        self.assertEqual(invite, INVITE_WITH_LINK)
        self.assertEqual(calls[0].get_method(), "POST")
        self.assertEqual(calls[0].full_url, "https://api.example.com/me/account/invites")
        self.assertEqual(sent_body(calls[0]), {"email": "new@example.com", "role": "admin"})

    def test_invite_with_no_arguments_sends_an_empty_body_an_open_invite(self) -> None:
        instance, calls = client(responding({"invite": INVITE_WITH_LINK_BODY}, status=201))

        instance.team.invite()

        # Neither key present, and neither null: omission is how a caller
        # mints an open, shareable invite.
        self.assertEqual(sent_body(calls[0]), {})

    def test_invite_surfaces_invalid_role_intact(self) -> None:
        instance, _calls = client(
            raising(
                http_error(400, {"error": {"code": "invalid_role", "message": "Unknown role."}}),
            ),
        )

        with self.assertRaises(ApiError) as caught:
            instance.team.invite(role="owner")

        self.assertEqual(caught.exception.status, 400)
        self.assertEqual(caught.exception.code, "invalid_role")


class InvitesTest(unittest.TestCase):
    """`team.invites()` — the open ones the server already filtered."""

    def test_invites_unwraps_the_envelope(self) -> None:
        instance, calls = client(responding({"invites": [INVITE_BODY]}))

        invites = instance.team.invites()

        self.assertEqual(invites, [INVITE])
        self.assertEqual(calls[0].get_method(), "GET")
        self.assertEqual(calls[0].full_url, "https://api.example.com/me/account/invites")

    def test_invites_of_an_account_with_none_open_is_an_empty_list(self) -> None:
        instance, _calls = client(responding({"invites": []}))

        self.assertEqual(instance.team.invites(), [])


class RevokeInviteTest(unittest.TestCase):
    """`team.revoke_invite(id)` — not idempotent."""

    def test_revoke_invite_addresses_the_invite_by_id_and_returns_none(self) -> None:
        instance, calls = client(responding({"ok": True}))

        result = instance.team.revoke_invite("inv_1")

        self.assertIsNone(result)
        self.assertEqual(calls[0].get_method(), "DELETE")
        self.assertEqual(calls[0].full_url, "https://api.example.com/me/account/invites/inv_1")

    def test_revoking_an_already_revoked_invite_raises_rather_than_succeeding(self) -> None:
        instance, _calls = client(
            raising(
                http_error(409, {"error": {"code": "invite_not_open", "message": "Already used."}}),
            ),
        )

        with self.assertRaises(ApiError) as caught:
            instance.team.revoke_invite("inv_1")

        self.assertEqual(caught.exception.status, 409)
        self.assertEqual(caught.exception.code, "invite_not_open")


class SetRoleTest(unittest.TestCase):
    """`team.set_role(user_id, role)`."""

    def test_set_role_patches_by_user_id_and_unwraps_the_member_envelope(self) -> None:
        updated_body = {**MEMBER_BODY, "role": "admin"}
        instance, calls = client(responding({"member": updated_body}))

        member = instance.team.set_role("usr_1", "admin")

        self.assertEqual(member.role, "admin")
        self.assertEqual(calls[0].get_method(), "PATCH")
        self.assertEqual(calls[0].full_url, "https://api.example.com/me/account/members/usr_1")
        self.assertEqual(sent_body(calls[0]), {"role": "admin"})

    def test_set_role_surfaces_cannot_change_owner_role_intact(self) -> None:
        instance, _calls = client(
            raising(
                http_error(
                    403,
                    {
                        "error": {
                            "code": "cannot_change_owner_role",
                            "message": "Cannot change the owner's role.",
                        },
                    },
                ),
            ),
        )

        with self.assertRaises(ApiError) as caught:
            instance.team.set_role("usr_1", "owner")

        self.assertEqual(caught.exception.status, 403)
        self.assertEqual(caught.exception.code, "cannot_change_owner_role")


class RemoveMemberTest(unittest.TestCase):
    """`team.remove_member(user_id)`."""

    def test_remove_member_addresses_by_user_id_and_returns_none(self) -> None:
        instance, calls = client(responding({"ok": True}))

        result = instance.team.remove_member("usr_2")

        self.assertIsNone(result)
        self.assertEqual(calls[0].get_method(), "DELETE")
        self.assertEqual(calls[0].full_url, "https://api.example.com/me/account/members/usr_2")

    def test_remove_member_surfaces_last_member_and_cannot_remove_owner_intact(self) -> None:
        owner, _calls = client(
            raising(
                http_error(
                    403,
                    {"error": {"code": "cannot_remove_owner", "message": "Cannot remove owner."}},
                ),
            ),
        )
        with self.assertRaises(ApiError) as caught_owner:
            owner.team.remove_member("usr_1")
        self.assertEqual(caught_owner.exception.code, "cannot_remove_owner")

        last, _calls = client(
            raising(
                http_error(
                    409,
                    {"error": {"code": "last_member", "message": "Cannot remove the last member."}},
                ),
            ),
        )
        with self.assertRaises(ApiError) as caught_last:
            last.team.remove_member("usr_2")
        self.assertEqual(caught_last.exception.code, "last_member")


class PathEncodingTest(unittest.TestCase):
    """Every path-addressed route percent-encodes its identifier."""

    def test_slash_bearing_ids_stay_one_path_segment(self) -> None:
        instance, calls = client(responding({"member": MEMBER_BODY, "ok": True}))

        instance.team.set_role("usr/1", "admin")
        instance.team.remove_member("usr/1")
        instance.team.revoke_invite("inv/1")

        self.assertEqual(
            calls[0].full_url,
            "https://api.example.com/me/account/members/usr%2F1",
        )
        self.assertEqual(
            calls[1].full_url,
            "https://api.example.com/me/account/members/usr%2F1",
        )
        self.assertEqual(
            calls[2].full_url,
            "https://api.example.com/me/account/invites/inv%2F1",
        )


class BadResponseTest(unittest.TestCase):
    """D3 — a `2xx` that does not carry what it promised."""

    def test_a_2xx_without_the_envelope_key_raises_bad_response(self) -> None:
        instance, _calls = client(responding({"unexpected": True}))

        with self.assertRaises(ApiError) as caught:
            instance.team.members()

        self.assertEqual(caught.exception.code, "bad_response")
        self.assertEqual(caught.exception.status, 200)
        self.assertIn('no "members"', caught.exception.message)


class NotYetServedTest(unittest.TestCase):
    """`status: "planned"` — a 404 today is an ordinary `ApiError`, not special-cased."""

    def test_a_404_from_a_server_without_t1_2_1_is_an_ordinary_api_error(self) -> None:
        instance, _calls = client(
            raising(http_error(404, {"error": {"code": "not_found", "message": "No such route."}})),
        )

        with self.assertRaises(ApiError) as caught:
            instance.team.members()

        self.assertEqual(caught.exception.status, 404)
        self.assertEqual(caught.exception.code, "not_found")


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
