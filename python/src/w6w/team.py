"""`client.team.*` — the caller's account team, self-service.

Six operations, **one HTTP call each**: list the roster, invite someone (or
mint an open, shareable invite link), list open invites, revoke one, change a
member's role, remove a member. No client-side list-then-filter anywhere in
this module — `team.invites()` returns only OPEN invites because the
**server** filters them, not because this module scans the account's whole
invite history and drops the closed ones (`packages/wrappers/README.md`,
"What a wrapper is").

**Not project-scoped.** Team membership is an account-wide concept, so
(unlike `documents`) this namespace carries no `project` parameter anywhere
and is constructed with the client's bound `request` method alone — the same
narrow shape `connections.py` and `_vars.py` use, so there is no default
project to reach even by accident.

The pinned wire contract these six methods transcribe
(`docs/team.md`, mirrored in this task's `plan.md` §"Pinned wire contract")::

    GET    /me/account/members                      -> 200 { members: [TeamMember] }
    POST   /me/account/invites   { email?, role? }  -> 201 { invite: TeamInviteWithLink }
    GET    /me/account/invites                      -> 200 { invites: [TeamInvite] }
    DELETE /me/account/invites/:id                  -> 200 { ok: true }
    PATCH  /me/account/members/:userId  { role }    -> 200 { member: TeamMember }
    DELETE /me/account/members/:userId              -> 200 { ok: true }

This module implements the client half **ahead of** the server route
(`endpoints.json`'s ``"status": "planned"`` on all six — `docs/parity.md`
§Conformance: ``status`` records server readiness, never wrapper obligation).
Calling any of these against a server that has not shipped T1.2.1 yet answers
`404`, which reaches the caller as an ordinary :class:`~w6w.errors.ApiError`.

The three wire dataclasses below (:class:`TeamMember`, :class:`TeamInvite`,
:class:`TeamInviteWithLink`) live in this module rather than in ``types.py``:
this task's scope does not touch that file, and the `node` lane makes the
identical choice for the identical reason (its team types live in
``team.ts``, not ``types.ts``).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, List, Mapping, Optional, Protocol

from ._http import HttpResponse, path
from .types import unwrap_list, unwrap_object


def _text(body: Any, key: str) -> str:
    """Read a string field, tolerating absence and wrong types.

    :param body: The wire object, or anything else.
    :param key: The field to read.
    :returns: The string value, or `""`.
    """
    value = body.get(key) if isinstance(body, dict) else None
    return value if isinstance(value, str) else ""


def _nullable_text(body: Any, key: str) -> Optional[str]:
    """Read a nullable string field, keeping `null` distinct from `""`.

    :param body: The wire object, or anything else.
    :param key: The field to read.
    :returns: The string value, or `None`.
    """
    value = body.get(key) if isinstance(body, dict) else None
    return value if isinstance(value, str) else None


@dataclass(frozen=True)
class TeamMember:
    """One member of the caller's account team, as the roster projects it.

    `email`/`display_name` are nullable rather than defaulted to `""`: a
    member whose profile carries neither is a real, distinct state (a machine
    principal, or a user who has set up neither), and flattening it to an
    empty string would make "no display name" indistinguishable from "the
    server sent an empty one".
    """

    #: The member's `usr_…` id — addresses :meth:`TeamApi.set_role` and
    #: :meth:`TeamApi.remove_member`.
    user_id: str
    #: The member's email, or `None` when the profile carries none.
    email: Optional[str]
    #: The member's display name, or `None` when unset.
    display_name: Optional[str]
    #: The member's role within the account, e.g. `"owner"`, `"admin"`, `"member"`.
    role: str
    #: ISO-8601 timestamp: when this membership began.
    created_at: str

    @classmethod
    def from_wire(cls, body: Any) -> "TeamMember":
        """Build a :class:`TeamMember` from a parsed wire object.

        :param body: The parsed `member` payload.
        :returns: The member.
        """
        return cls(
            user_id=_text(body, "userId"),
            email=_nullable_text(body, "email"),
            display_name=_nullable_text(body, "displayName"),
            role=_text(body, "role"),
            created_at=_text(body, "createdAt"),
        )


@dataclass(frozen=True)
class TeamInvite:
    """One invite, as :meth:`TeamApi.invites` lists it.

    Deliberately carries no token: see :class:`TeamInviteWithLink`, the only
    response that does, and only once.
    """

    #: The invite's own id — addresses :meth:`TeamApi.revoke_invite`.
    id: str
    #: The account this invite joins.
    account: str
    #: The invited email, or `None` for an open (link-only) invite.
    email: Optional[str]
    #: The role the invite grants on redemption, or `None` (server defaults to `"member"`).
    role: Optional[str]
    #: ISO-8601 expiry, or `None` for an invite that does not expire.
    expires_at: Optional[str]
    #: ISO-8601 timestamp: when this invite was created.
    created_at: str

    @classmethod
    def from_wire(cls, body: Any) -> "TeamInvite":
        """Build a :class:`TeamInvite` from a parsed wire object.

        :param body: The parsed `invite` payload.
        :returns: The invite.
        """
        return cls(
            id=_text(body, "id"),
            account=_text(body, "account"),
            email=_nullable_text(body, "email"),
            role=_nullable_text(body, "role"),
            expires_at=_nullable_text(body, "expiresAt"),
            created_at=_text(body, "createdAt"),
        )


@dataclass(frozen=True)
class TeamInviteWithLink(TeamInvite):
    """What :meth:`TeamApi.invite` returns: a :class:`TeamInvite` plus the
    redemption material, present **only** in this one response.

    The server never re-sends `token` or `redemption_link` from any other
    route — :meth:`TeamApi.invites` lists the invite without them — so a
    caller that drops this return value cannot recover it and must revoke and
    re-invite instead.
    """

    #: The plaintext redemption token. Shown once.
    token: str = ""
    #: The ready-to-share redemption URL, built around `token`. Shown once.
    redemption_link: str = ""

    @classmethod
    def from_wire(cls, body: Any) -> "TeamInviteWithLink":
        """Build a :class:`TeamInviteWithLink` from a parsed wire object.

        :param body: The parsed `invite` payload.
        :returns: The invite, with its one-time redemption material.
        """
        base = TeamInvite.from_wire(body)
        return cls(
            id=base.id,
            account=base.account,
            email=base.email,
            role=base.role,
            expires_at=base.expires_at,
            created_at=base.created_at,
            token=_text(body, "token"),
            redemption_link=_text(body, "redemptionLink"),
        )


class TeamHost(Protocol):
    """The slice of `Client` this namespace needs: the transport, and nothing
    else.

    Team operations carry no per-call scope to resolve, so — as with
    `connections.py` and `_vars.py` — this host cannot reach the client's
    configuration even by accident.
    """

    def request(
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


class TeamApi:
    """The `team` namespace on a `Client`.

    Reached as `client.team`; never constructed directly by a caller.

    Example::

        members = client.team.members()
        invite = client.team.invite(role="admin")
        client.team.set_role(members[0].user_id, "admin")
    """

    def __init__(self, host: TeamHost) -> None:
        """Bind the namespace to the client it issues requests through.

        :param host: The client. Only its transport is read; nothing here is
            module state.
        """
        self._host = host

    def members(self) -> List[TeamMember]:
        """List the caller's account team.

        Member-readable: any active member of the account may call this,
        regardless of role — only the write operations below require
        `canManageMembers`.

        :returns: The team, unwrapped from the `members` envelope.
        :raises ConfigError: When no token is configured.
        :raises ApiError: On any non-2xx.
        """
        response = self._host.request("GET", "/me/account/members")
        return [TeamMember.from_wire(item) for item in unwrap_list(response, "members")]

    def invite(
        self,
        email: Optional[str] = None,
        role: Optional[str] = None,
    ) -> TeamInviteWithLink:
        """Invite someone to the account, or mint an open, shareable invite link.

        :param email: The address to invite. Omitted mints an OPEN invite — a
            shareable link with no target address.
        :param role: The role the invite grants on redemption. Omitted
            defaults server-side to `"member"`.
        :returns: The created invite, including its one-time `token` and
            `redemption_link`.
        :raises ConfigError: When no token is configured.
        :raises ApiError: `403 forbidden` without `canManageMembers`.
        :raises ApiError: `400 invalid_role` for `role="owner"` or an
            unrecognised role.
        """
        body: Dict[str, Any] = {}
        if email is not None:
            body["email"] = email
        if role is not None:
            body["role"] = role
        response = self._host.request("POST", "/me/account/invites", body=body)
        return TeamInviteWithLink.from_wire(unwrap_object(response, "invite"))

    def invites(self) -> List[TeamInvite]:
        """List the account's open (pending, unrevoked, unexpired) invites.

        The filtering happens server-side — this is one `GET`, never a
        list-then-filter over the account's whole invite history.

        :returns: The open invites, unwrapped from the `invites` envelope.
        :raises ConfigError: When no token is configured.
        :raises ApiError: `403 forbidden` without `canManageMembers`.
        """
        response = self._host.request("GET", "/me/account/invites")
        return [TeamInvite.from_wire(item) for item in unwrap_list(response, "invites")]

    def revoke_invite(self, id: str) -> None:
        """Revoke a pending invite before it is redeemed.

        Not idempotent: revoking an invite that is already used or already
        revoked is a rejected request, not a silent success.

        :param id: The invite's own id (see: :meth:`invites`).
        :raises ConfigError: When no token is configured.
        :raises ApiError: `403 forbidden` without `canManageMembers`.
        :raises ApiError: `404 invite_not_found` for an unknown id.
        :raises ApiError: `409 invite_not_open` when it was already used or
            revoked.
        """
        self._host.request("DELETE", path("/me/account/invites/{id}", id=id))

    def set_role(self, user_id: str, role: str) -> TeamMember:
        """Change a team member's role.

        :param user_id: The member's `usr_…` id (see: :meth:`members`).
        :param role: The role to set.
        :returns: The updated member.
        :raises ConfigError: When no token is configured.
        :raises ApiError: `403 forbidden` without `canManageMembers`.
        :raises ApiError: `403 cannot_change_owner_role` for `role="owner"`
            or when `user_id` is the account's current owner — there is no
            self-service ownership transfer.
        :raises ApiError: `400 invalid_role` for an unrecognised role.
        :raises ApiError: `404 member_not_found` for an unknown `user_id`.
        """
        response = self._host.request(
            "PATCH",
            path("/me/account/members/{userId}", userId=user_id),
            body={"role": role},
        )
        return TeamMember.from_wire(unwrap_object(response, "member"))

    def remove_member(self, user_id: str) -> None:
        """Remove a member from the account.

        Tombstones the membership server-side rather than deleting it
        outright (D-R3), but that is a server implementation detail this
        method does not surface — it returns nothing, the same pin as
        `documents.delete`.

        :param user_id: The member's `usr_…` id (see: :meth:`members`).
        :raises ConfigError: When no token is configured.
        :raises ApiError: `403 forbidden` without `canManageMembers`.
        :raises ApiError: `403 cannot_remove_owner` when `user_id` is the
            account's owner.
        :raises ApiError: `404 member_not_found` for an unknown `user_id`.
        :raises ApiError: `409 last_member` when `user_id` is the account's
            only active member.
        """
        self._host.request("DELETE", path("/me/account/members/{userId}", userId=user_id))
