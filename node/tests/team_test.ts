/**
 * `client.team.*`, against an injected fake `fetch`.
 *
 * No case here needs a live server (`docs/implementation.md` §9) — every
 * `team.*` route is `status: "planned"` in `endpoints.json` (T1.2.1 has not
 * landed), so this suite is exactly the kind of thing `docs/implementation.md`
 * §9 exists for. Each case asserts the request the wrapper *made* — method,
 * full resolved URL, bearer, serialised body — **and** the value it returned,
 * which is always the unwrapped payload and never the server's envelope.
 */

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { W6WClient } from "../src/client.ts";
import type { FetchLike } from "../src/config.ts";
import { ApiError } from "../src/errors.ts";
import type { TeamInvite, TeamInviteWithLink, TeamMember } from "../src/team.ts";

/** One recorded call to the fake transport. */
interface Call {
  url: string;
  method: string | undefined;
  headers: Headers;
  body: string | null;
}

/** A `fetch`-shaped fake; `respond` produces the `Response` to hand back. */
function fakeFetch(respond: (call: Call) => Response): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: FetchLike = (input, init) => {
    calls.push({
      url: input,
      method: init?.method,
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? init.body : null,
    });
    return Promise.resolve(respond(calls[calls.length - 1]));
  };
  return { fetch, calls };
}

function json(body: unknown, status = 200, statusText?: string): Response {
  return new Response(JSON.stringify(body), {
    status,
    statusText,
    headers: { "content-type": "application/json" },
  });
}

/** A client wired to a fake transport. Team ops carry no `?project=`, so no default is seeded. */
function client(respond: (call: Call) => Response): { client: W6WClient; calls: Call[] } {
  const fake = fakeFetch(respond);
  return {
    client: new W6WClient({
      baseUrl: "https://api.example.com",
      token: "tok_1",
      fetch: fake.fetch,
    }),
    calls: fake.calls,
  };
}

const MEMBER: TeamMember = {
  userId: "usr_1",
  email: "owner@example.com",
  displayName: "Ada Owner",
  role: "owner",
  createdAt: "2026-07-01T12:00:00.000Z",
};

const INVITE: TeamInvite = {
  id: "inv_1",
  account: "acc_1",
  email: "new@example.com",
  role: "admin",
  expiresAt: null,
  createdAt: "2026-08-01T09:00:00.000Z",
};

const INVITE_WITH_LINK: TeamInviteWithLink = {
  ...INVITE,
  token: "tok_plaintext",
  redemptionLink: "https://app.example.com/join?token=tok_plaintext",
};

Deno.test("team: all six operations are functions on a constructed client", () => {
  // Deliberately a runtime assertion, not a type-level one: a namespace that
  // silently lost a method would still typecheck in every OTHER case in this
  // file, because they all call through the same object.
  const c = new W6WClient({ baseUrl: "https://api.example.com", token: "t" });
  for (
    const name of [
      "members",
      "invite",
      "invites",
      "revokeInvite",
      "setRole",
      "removeMember",
    ] as const
  ) {
    assertEquals(typeof c.team[name], "function", `team.${name} is missing`);
  }
});

Deno.test("team: carries no ?project= anywhere — team membership is account-wide", async () => {
  // Seeded WITH a client-level default project, on purpose: if `team` ever
  // regressed to reading `config.project` the way `documents` does, this is
  // where it would show up as an unwanted query string.
  const fake = fakeFetch(() => json({ members: [MEMBER], invites: [INVITE], ok: true }));
  const c = new W6WClient({
    baseUrl: "https://api.example.com",
    token: "tok_1",
    project: "prj_default",
    fetch: fake.fetch,
  });

  await c.team.members();
  await c.team.invites();
  await c.team.revokeInvite("inv_1");
  await c.team.removeMember("usr_2");

  for (const call of fake.calls) {
    assertEquals(call.url.includes("project"), false, call.url);
  }
});

Deno.test("team.members unwraps the envelope and returns the roster", async () => {
  const c = client(() => json({ members: [MEMBER] }));

  const members = await c.client.team.members();

  assertEquals(members, [MEMBER]);
  assertEquals(c.calls.length, 1);
  assertEquals(c.calls[0].method, "GET");
  assertEquals(c.calls[0].url, "https://api.example.com/me/account/members");
  assertEquals(c.calls[0].headers.get("authorization"), "Bearer tok_1");
});

Deno.test("team.invite posts the two optional fields and accepts 201", async () => {
  const c = client(() => json({ invite: INVITE_WITH_LINK }, 201));

  const invite = await c.client.team.invite({ email: "new@example.com", role: "admin" });

  assertEquals(invite, INVITE_WITH_LINK);
  assertEquals(c.calls[0].method, "POST");
  assertEquals(c.calls[0].url, "https://api.example.com/me/account/invites");
  assertEquals(JSON.parse(c.calls[0].body ?? "null"), {
    email: "new@example.com",
    role: "admin",
  });
});

Deno.test("team.invite omits both fields when called with no arguments — an OPEN invite", async () => {
  const c = client(() => json({ invite: INVITE_WITH_LINK }, 201));

  await c.client.team.invite();

  // Neither field present, and neither `null`: omission is how a caller mints
  // an open, shareable invite rather than one addressed to a specific email.
  assertEquals(JSON.parse(c.calls[0].body ?? "null"), {});
});

Deno.test("team.invites unwraps the envelope and returns only what the server sent", async () => {
  const c = client(() => json({ invites: [INVITE] }));

  const invites = await c.client.team.invites();

  assertEquals(invites, [INVITE]);
  assertEquals(c.calls[0].method, "GET");
  assertEquals(c.calls[0].url, "https://api.example.com/me/account/invites");
});

Deno.test("team.revokeInvite addresses the invite by id and returns nothing", async () => {
  const c = client(() => json({ ok: true }));

  const result = await c.client.team.revokeInvite("inv_1");

  assertEquals(result, undefined);
  assertEquals(c.calls[0].method, "DELETE");
  assertEquals(c.calls[0].url, "https://api.example.com/me/account/invites/inv_1");
  assertEquals(c.calls[0].body, null);
});

Deno.test("team.revokeInvite does not swallow a 409 — revoking is not idempotent", async () => {
  const c = client(() =>
    json({ error: { code: "invite_not_open", message: "Already used." } }, 409, "Conflict")
  );

  const err = await assertRejects(() => c.client.team.revokeInvite("inv_1"), ApiError);

  assertEquals(err.status, 409);
  assertEquals(err.code, "invite_not_open");
});

Deno.test("team.setRole patches by userId and unwraps the member envelope", async () => {
  const updated: TeamMember = { ...MEMBER, role: "admin" };
  const c = client(() => json({ member: updated }));

  const result = await c.client.team.setRole("usr_1", "admin");

  assertEquals(result, updated);
  assertEquals(c.calls[0].method, "PATCH");
  assertEquals(c.calls[0].url, "https://api.example.com/me/account/members/usr_1");
  assertEquals(JSON.parse(c.calls[0].body ?? "null"), { role: "admin" });
});

Deno.test("team.setRole surfaces cannot_change_owner_role unswallowed", async () => {
  const c = client(() =>
    json(
      { error: { code: "cannot_change_owner_role", message: "Cannot change the owner's role." } },
      403,
      "Forbidden",
    )
  );

  const err = await assertRejects(() => c.client.team.setRole("usr_1", "owner"), ApiError);

  assertEquals(err.status, 403);
  assertEquals(err.code, "cannot_change_owner_role");
});

Deno.test("team.removeMember addresses the member by userId and returns nothing", async () => {
  const c = client(() => json({ ok: true }));

  const result = await c.client.team.removeMember("usr_2");

  assertEquals(result, undefined);
  assertEquals(c.calls[0].method, "DELETE");
  assertEquals(c.calls[0].url, "https://api.example.com/me/account/members/usr_2");
  assertEquals(c.calls[0].body, null);
});

Deno.test("team.removeMember does not swallow last_member or cannot_remove_owner", async () => {
  const owner = client(() =>
    json({ error: { code: "cannot_remove_owner", message: "Cannot remove the owner." } }, 403)
  );
  const ownerErr = await assertRejects(() => owner.client.team.removeMember("usr_1"), ApiError);
  assertEquals(ownerErr.code, "cannot_remove_owner");

  const last = client(() =>
    json({ error: { code: "last_member", message: "Cannot remove the last member." } }, 409)
  );
  const lastErr = await assertRejects(() => last.client.team.removeMember("usr_2"), ApiError);
  assertEquals(lastErr.code, "last_member");
});

Deno.test("team: the userId/id is percent-encoded into every path-addressed route", async () => {
  const c = client(() => json({ member: MEMBER, ok: true }));

  await c.client.team.setRole("usr/1", "admin");
  await c.client.team.removeMember("usr/1");
  await c.client.team.revokeInvite("inv/1");

  assertEquals(c.calls[0].url, "https://api.example.com/me/account/members/usr%2F1");
  assertEquals(c.calls[1].url, "https://api.example.com/me/account/members/usr%2F1");
  assertEquals(c.calls[2].url, "https://api.example.com/me/account/invites/inv%2F1");
});

Deno.test("team: an envelope key present but null is bad_response, not null", async () => {
  const c = client(() => json({ members: null }));

  const err = await assertRejects(() => c.client.team.members(), ApiError);

  assertEquals(err.code, "bad_response");
  assertEquals(err.status, 200);
  assertStringIncludes(err.message, '"members"');
});

Deno.test("team: a 200 missing its envelope key is bad_response, not undefined", async () => {
  const c = client(() => json({ unexpected: true }));

  const err = await assertRejects(() => c.client.team.members(), ApiError);

  assertEquals(err.code, "bad_response");
  assertEquals(err.status, 200);
  assertStringIncludes(err.message, '"members"');
});

Deno.test("team: a 404 not-yet-served route reaches the caller as an ordinary ApiError", async () => {
  // Every `team.*` route is `status: "planned"` — a server that has not
  // shipped T1.2.1 answers 404, and this wrapper does not special-case that.
  const c = client(() => json({ error: { code: "not_found", message: "No such route." } }, 404));

  const err = await assertRejects(() => c.client.team.members(), ApiError);

  assertEquals(err.status, 404);
  assertEquals(err.code, "not_found");
});
