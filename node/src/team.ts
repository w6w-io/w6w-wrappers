/**
 * `client.team.*` — the caller's account team, self-service.
 *
 * Six operations, one HTTP call each: list the roster, invite someone (or mint
 * an open, shareable invite link), list open invites, revoke one, change a
 * member's role, remove a member. Nothing here composes two requests or
 * filters a list client-side — `team.invites()` returns only OPEN invites
 * because the **server** filters them, not because this module scans the
 * account's whole invite history and drops the closed ones
 * (`docs/implementation.md`'s "what a wrapper is" rule, mirrored from
 * `documents.ts`'s header).
 *
 * **Not project-scoped.** Team membership is an account-wide concept, so
 * (unlike `documents`) this namespace carries no `?project=` anywhere and is
 * handed the transport only — the same narrow host `connections.ts` and
 * `vars.ts` use, so a caller cannot even accidentally reach a default project
 * to send.
 *
 * `docs/team.md`'s pinned wire contract (mirrored in this task's `plan.md`
 * §"Pinned wire contract") is the source these six methods transcribe:
 *
 * ```
 * GET    /me/account/members                      → 200 { members: TeamMember[] }
 * POST   /me/account/invites   { email?, role? }  → 201 { invite: TeamInviteWithLink }
 * GET    /me/account/invites                      → 200 { invites: TeamInvite[] }
 * DELETE /me/account/invites/:id                  → 200 { ok: true }
 * PATCH  /me/account/members/:userId  { role }    → 200 { member: TeamMember }
 * DELETE /me/account/members/:userId              → 200 { ok: true }
 * ```
 *
 * This module implements the client half **ahead of** the server route
 * (`endpoints.json`'s `status: "planned"` on all six — `docs/parity.md`
 * §Conformance: `status` records server readiness, never wrapper obligation).
 * Calling any of these against a server that has not shipped T1.2.1 yet
 * answers `404`, which reaches the caller as an ordinary `ApiError`.
 *
 * @module
 */

import { type HttpResponse, path, type RequestOptions } from "./http.ts";
import { unwrap } from "./types.ts";

/**
 * The slice of `W6WClient` this namespace needs: the transport, and nothing
 * else. Team operations carry no per-call scope to resolve, so — as with
 * `connections` and `vars` — this host cannot reach the client's
 * configuration even by accident.
 */
export interface TeamHost {
  /** Perform one request. */
  request<T>(options: RequestOptions): Promise<HttpResponse<T>>;
}

/**
 * One member of the caller's account team, as the roster projects it.
 *
 * `email`/`displayName` are nullable rather than defaulted to `""`: a member
 * whose profile carries neither is a real, distinct state (a machine
 * principal, or a user who has set up neither) and flattening it to an empty
 * string would make "no display name" indistinguishable from "the server sent
 * an empty one".
 */
export interface TeamMember {
  /** The member's `usr_…` id — addresses `setRole` and `removeMember`. */
  userId: string;
  /** The member's email, or `null` when the profile carries none. */
  email: string | null;
  /** The member's display name, or `null` when unset. */
  displayName: string | null;
  /** The member's role within the account, e.g. `"owner"`, `"admin"`, `"member"`. */
  role: string;
  /** ISO-8601 timestamp: when this membership began. */
  createdAt: string;
}

/**
 * One invite, as `team.invites()` lists it.
 *
 * Deliberately carries no `token` — see {@linkcode TeamInviteWithLink}, the
 * only response that does, and only once.
 */
export interface TeamInvite {
  /** The invite's own id — addresses `revokeInvite`. */
  id: string;
  /** The account this invite joins. */
  account: string;
  /** The invited email, or `null` for an open (link-only) invite. */
  email: string | null;
  /** The role the invite grants on redemption, or `null` (server defaults to `"member"`). */
  role: string | null;
  /** ISO-8601 expiry, or `null` for an invite that does not expire. */
  expiresAt: string | null;
  /** ISO-8601 timestamp: when this invite was created. */
  createdAt: string;
}

/**
 * What `team.invite()` returns: a {@linkcode TeamInvite} plus the redemption
 * material, present **only** in this one response.
 *
 * The server never re-sends `token` or `redemptionLink` from any other route
 * — `team.invites()` lists the invite without them — so a caller that drops
 * this return value cannot recover it and must revoke and re-invite instead.
 */
export interface TeamInviteWithLink extends TeamInvite {
  /** The plaintext redemption token. Shown once. */
  token: string;
  /** The ready-to-share redemption URL, built around `token`. Shown once. */
  redemptionLink: string;
}

/**
 * The body of `team.invite()`.
 *
 * Both fields are optional: an omitted `email` mints an OPEN invite (a
 * shareable link with no target address), and an omitted `role` defaults
 * server-side to `"member"`. `"owner"` is refused — there is no self-service
 * path to a second owner.
 */
export interface TeamInviteInput {
  /** The address to invite. Omitted for an open, shareable invite. */
  email?: string;
  /** The role the invite grants on redemption. Omitted defaults to `"member"`. */
  role?: string;
}

/**
 * The `team` namespace on a `W6WClient`.
 *
 * @example
 * ```ts
 * const members = await client.team.members();
 * const { redemptionLink } = await client.team.invite({ role: "admin" });
 * await client.team.setRole(members[0].userId, "admin");
 * ```
 */
export class TeamApi {
  readonly #host: TeamHost;

  /**
   * @param host - The client this namespace issues requests through.
   */
  constructor(host: TeamHost) {
    this.#host = host;
  }

  /**
   * List the caller's account team.
   *
   * Member-readable: any active member of the account may call this,
   * regardless of role — only the write operations below require
   * `canManageMembers`.
   *
   * @returns The team, unwrapped from the `members` envelope.
   * @throws {ApiError} On any non-2xx.
   */
  async members(): Promise<TeamMember[]> {
    const res = await this.#host.request<unknown>({ method: "GET", path: "/me/account/members" });
    return unwrap<TeamMember[]>(res, "members");
  }

  /**
   * Invite someone to the account, or mint an open, shareable invite link.
   *
   * @param input - `email` and `role`, both optional.
   * @returns The created invite, including its one-time `token` and `redemptionLink`.
   * @throws {ApiError} `403 forbidden` without `canManageMembers`.
   * @throws {ApiError} `400 invalid_role` for `role: "owner"` or an unrecognised role.
   */
  async invite(input: TeamInviteInput = {}): Promise<TeamInviteWithLink> {
    const res = await this.#host.request<unknown>({
      method: "POST",
      path: "/me/account/invites",
      // Assembled field by field, exactly the two documented fields: an
      // `undefined` one is dropped by JSON serialisation rather than sent as
      // an explicit `null`.
      body: { email: input.email, role: input.role },
    });
    return unwrap<TeamInviteWithLink>(res, "invite");
  }

  /**
   * List the account's open (pending, unrevoked, unexpired) invites.
   *
   * The filtering happens server-side — this is one `GET`, never a
   * list-then-filter over the account's whole invite history.
   *
   * @returns The open invites, unwrapped from the `invites` envelope.
   * @throws {ApiError} `403 forbidden` without `canManageMembers`.
   */
  async invites(): Promise<TeamInvite[]> {
    const res = await this.#host.request<unknown>({ method: "GET", path: "/me/account/invites" });
    return unwrap<TeamInvite[]>(res, "invites");
  }

  /**
   * Revoke a pending invite before it is redeemed.
   *
   * Not idempotent: revoking an invite that is already used or already
   * revoked is a rejected request, not a silent success.
   *
   * @param id - The invite's own id (see: `team.invites()`).
   * @throws {ApiError} `403 forbidden` without `canManageMembers`.
   * @throws {ApiError} `404 invite_not_found` for an unknown id.
   * @throws {ApiError} `409 invite_not_open` when it was already used or revoked.
   */
  async revokeInvite(id: string): Promise<void> {
    await this.#host.request<unknown>({
      method: "DELETE",
      path: path`/me/account/invites/${id}`,
    });
  }

  /**
   * Change a team member's role.
   *
   * @param userId - The member's `usr_…` id (see: `team.members()`).
   * @param role - The role to set.
   * @returns The updated member.
   * @throws {ApiError} `403 forbidden` without `canManageMembers`.
   * @throws {ApiError} `403 cannot_change_owner_role` for `role: "owner"` or when
   * `userId` is the account's current owner — there is no self-service ownership transfer.
   * @throws {ApiError} `400 invalid_role` for an unrecognised role.
   * @throws {ApiError} `404 member_not_found` for an unknown `userId`.
   */
  async setRole(userId: string, role: string): Promise<TeamMember> {
    const res = await this.#host.request<unknown>({
      method: "PATCH",
      path: path`/me/account/members/${userId}`,
      body: { role },
    });
    return unwrap<TeamMember>(res, "member");
  }

  /**
   * Remove a member from the account.
   *
   * Tombstones the membership server-side rather than deleting it outright
   * (D-R3), but that is a server implementation detail this method does not
   * surface — it returns nothing, the same pin as `documents.delete`.
   *
   * @param userId - The member's `usr_…` id (see: `team.members()`).
   * @throws {ApiError} `403 forbidden` without `canManageMembers`.
   * @throws {ApiError} `403 cannot_remove_owner` when `userId` is the account's owner.
   * @throws {ApiError} `404 member_not_found` for an unknown `userId`.
   * @throws {ApiError} `409 last_member` when `userId` is the account's only active member.
   */
  async removeMember(userId: string): Promise<void> {
    await this.#host.request<unknown>({
      method: "DELETE",
      path: path`/me/account/members/${userId}`,
    });
  }
}
