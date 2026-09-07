/**
 * `w6w team …`, driven through the dispatcher against a fake transport.
 *
 * Same discipline as `cmd_documents_test.ts`: every case runs the **real**
 * command line — `main()`, the real registry, the real SDK — with the
 * environment and `fetch` substituted. No live server is involved anywhere
 * (`docs/implementation.md` §9); every `team.*` route is `status: "planned"`
 * in `endpoints.json` today, so this suite is exactly the kind of thing that
 * discipline is for.
 *
 * What is being pinned, beyond "it works":
 *
 * - **No `--project` anywhere** — team membership is account-wide.
 * - **`invite`'s two flags are both optional**, and an omitted one does not
 *   reach the wire — asserted on the wire body, the only place that
 *   distinction exists.
 * - **`revoke-invite`/`remove-member` print nothing on stdout**, the same
 *   `{ok:true}`-unwraps-to-nothing pin as `documents delete`.
 * - **The exit codes**, mapped the same way every other group's are.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import type { FetchLike } from "@w6w/sdk";
import { HELP_TREE, main } from "../mod.ts";
import { COMMANDS, TEAM_COMMANDS } from "../src/commands/index.ts";
import type { EnvReader } from "../mod.ts";

const BASE = "https://api.example.test";
const CONFIGURED: Record<string, string> = { W6W_BASE_URL: BASE, W6W_TOKEN: "t_cli" };
const ENV: EnvReader = (name) => CONFIGURED[name];

/** One request the CLI made, in the terms the assertions are written in. */
interface Recorded {
  url: string;
  method: string;
  authorization: string | null;
  body: unknown;
}

type Reply = (call: Recorded) => Response;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

interface Ran {
  code: number;
  stdout: string;
  stderr: string;
  calls: Recorded[];
}

const MEMBER = {
  userId: "usr_01HQ8N",
  email: "owner@example.com",
  displayName: "Ada Owner",
  role: "owner",
  createdAt: "2026-07-01T12:00:00.000Z",
};

const INVITE_WITH_LINK = {
  id: "inv_01HQ8N",
  account: "acc_1",
  email: "new@example.com",
  role: "admin",
  expiresAt: null,
  createdAt: "2026-08-01T09:00:00.000Z",
  token: "tok_plaintext",
  redemptionLink: "https://app.example.com/join?token=tok_plaintext",
};

/** Run one command line and report everything it did. */
async function w6w(argv: string[], reply: Reply = () => json(200, {})): Promise<Ran> {
  const calls: Recorded[] = [];
  const stdout: string[] = [];
  const stderr: string[] = [];
  const fetch: FetchLike = (url, init) => {
    const call: Recorded = {
      url,
      method: init?.method ?? "GET",
      authorization: new Headers(init?.headers).get("authorization"),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    return Promise.resolve(reply(call));
  };
  const code = await main(argv, {
    stdout: (text) => stdout.push(text),
    stderr: (text) => stderr.push(text),
  }, { env: ENV, fetch, commands: COMMANDS });
  return { code, stdout: stdout.join("\n"), stderr: stderr.join("\n"), calls };
}

// ---------------------------------------------------------------------------
// Reads.
// ---------------------------------------------------------------------------

Deno.test("team members: one GET, a readable table, and --json prints the payload alone", async () => {
  const human = await w6w(["team", "members"], () => json(200, { members: [MEMBER] }));

  assertEquals(human.code, 0, human.stderr);
  assertEquals(human.calls.length, 1);
  assertEquals(human.calls[0].method, "GET");
  assertEquals(human.calls[0].url, `${BASE}/me/account/members`);
  assertEquals(human.calls[0].authorization, "Bearer t_cli");
  assertStringIncludes(human.stdout, "ROLE");
  assertStringIncludes(human.stdout, "owner@example.com");
  assert(!human.stdout.includes("project"), "team commands carry no ?project=");

  const machine = await w6w(["team", "members", "--json"], () => json(200, { members: [MEMBER] }));
  assertEquals(machine.code, 0, machine.stderr);
  assertEquals(JSON.parse(machine.stdout), [MEMBER]);
});

Deno.test("team invites: lists only the open ones the server already filtered", async () => {
  const result = await w6w(["team", "invites"], () =>
    json(200, {
      invites: [{
        id: "inv_1",
        account: "acc_1",
        email: "pending@example.com",
        role: "member",
        expiresAt: null,
        createdAt: "2026-08-01T09:00:00.000Z",
      }],
    }));

  assertEquals(result.code, 0, result.stderr);
  assertEquals(result.calls.length, 1);
  assertEquals(result.calls[0].method, "GET");
  assertEquals(result.calls[0].url, `${BASE}/me/account/invites`);
  assertStringIncludes(result.stdout, "pending@example.com");

  const empty = await w6w(["team", "invites"], () => json(200, { invites: [] }));
  assertStringIncludes(empty.stdout, "No open invites.");
});

// ---------------------------------------------------------------------------
// Writes.
// ---------------------------------------------------------------------------

Deno.test("team invite: both flags reach the body, and both are optional (D2)", async () => {
  const both = await w6w(
    ["team", "invite", "--email", "new@example.com", "--role", "admin"],
    () => json(201, { invite: INVITE_WITH_LINK }),
  );
  assertEquals(both.code, 0, both.stderr);
  assertEquals(both.calls[0].method, "POST");
  assertEquals(both.calls[0].url, `${BASE}/me/account/invites`);
  assertEquals(both.calls[0].body, { email: "new@example.com", role: "admin" });
  assertStringIncludes(both.stdout, "new@example.com");
  assertStringIncludes(both.stdout, "Redemption link");

  // Neither flag given: an OPEN invite. Neither key reaches the wire — not
  // even as null — because omission is the whole mechanism here.
  const open = await w6w(["team", "invite"], () => json(201, { invite: INVITE_WITH_LINK }));
  assertEquals(open.code, 0, open.stderr);
  assertEquals(open.calls[0].body, {});
});

Deno.test("team revoke-invite: addressed by id, and nothing at all on stdout", async () => {
  const result = await w6w(["team", "revoke-invite", "inv_01HQ8N"], () => json(200, { ok: true }));
  assertEquals(result.code, 0, result.stderr);
  assertEquals(result.calls[0].method, "DELETE");
  assertEquals(result.calls[0].url, `${BASE}/me/account/invites/inv_01HQ8N`);
  assertEquals(result.calls[0].body, undefined);
  assertStringIncludes(result.stdout, "Revoked inv_01HQ8N.");

  const machine = await w6w(
    ["team", "revoke-invite", "inv_01HQ8N", "--json"],
    () => json(200, { ok: true }),
  );
  assertEquals(machine.code, 0, machine.stderr);
  assertEquals(machine.stdout, "");
});

Deno.test("team set-role: the userId is positional, the role is a required flag", async () => {
  const updated = { ...MEMBER, role: "admin" };
  const result = await w6w(
    ["team", "set-role", "usr_01HQ8N", "--role", "admin"],
    () => json(200, { member: updated }),
  );
  assertEquals(result.code, 0, result.stderr);
  assertEquals(result.calls[0].method, "PATCH");
  assertEquals(result.calls[0].url, `${BASE}/me/account/members/usr_01HQ8N`);
  assertEquals(result.calls[0].body, { role: "admin" });
  assertStringIncludes(result.stdout, "admin");

  const missingFlag = await w6w(["team", "set-role", "usr_01HQ8N"]);
  assertEquals(missingFlag.code, 1);
  assertStringIncludes(missingFlag.stderr, "--role <role>");
  assertEquals(missingFlag.calls.length, 0);
});

Deno.test("team remove-member: addressed by userId, and nothing at all on stdout", async () => {
  const result = await w6w(["team", "remove-member", "usr_01HQ8N"], () => json(200, { ok: true }));
  assertEquals(result.code, 0, result.stderr);
  assertEquals(result.calls[0].method, "DELETE");
  assertEquals(result.calls[0].url, `${BASE}/me/account/members/usr_01HQ8N`);
  assertEquals(result.calls[0].body, undefined);
  assertStringIncludes(result.stdout, "Removed usr_01HQ8N.");
});

// ---------------------------------------------------------------------------
// Failure.
// ---------------------------------------------------------------------------

Deno.test("team: an API error exits 2, on stderr, with stdout left clean", async () => {
  const forbidden = await w6w(
    ["team", "set-role", "usr_01HQ8N", "--role", "owner"],
    () =>
      json(403, {
        error: { code: "cannot_change_owner_role", message: "cannot change the owner's role" },
      }),
  );
  assertEquals(forbidden.code, 2);
  assertEquals(forbidden.stdout, "", "an error must never reach stdout");
  assertStringIncludes(forbidden.stderr, "cannot change the owner's role");
});

Deno.test("team: a 404 not-yet-served route exits 2 like any other ApiError", async () => {
  // Every `team.*` route is `status: "planned"` — a server without T1.2.1
  // answers 404, and the CLI does not special-case that.
  const result = await w6w(
    ["team", "members"],
    () => json(404, { error: { code: "not_found", message: "no such route" } }),
  );
  assertEquals(result.code, 2);
  assertStringIncludes(result.stderr, "no such route");
});

Deno.test("team: a bad invocation is a usage error, exits 1, and makes no request", async () => {
  const cases: [string[], string][] = [
    [["team", "revoke-invite"], "needs an invite id"],
    [["team", "set-role"], "needs a member's user id"],
    [["team", "remove-member"], "needs a member's user id"],
    [["team", "members", "stray"], "takes no arguments"],
    [["team", "invites", "stray"], "takes no arguments"],
  ];
  for (const [argv, expected] of cases) {
    const result = await w6w(argv);
    assertEquals(result.code, 1, `\`${argv.join(" ")}\` exited ${result.code}`);
    assertStringIncludes(result.stderr, expected);
    assertEquals(result.calls.length, 0, "a usage error must not reach the server");
    assertEquals(result.stdout, "");
  }
});

// ---------------------------------------------------------------------------
// Registration.
// ---------------------------------------------------------------------------

Deno.test("every `w6w team` command in the help tree is registered, and no others", () => {
  const group = HELP_TREE.groups.find((candidate) => candidate.name === "team");
  assert(group !== undefined, "the generated help tree has no `team` group");
  const documented = group.commands.map((command) => command.path.join(" ")).sort();
  assertEquals(Object.keys(TEAM_COMMANDS).sort(), documented);
  for (const path of documented) assert(Object.hasOwn(COMMANDS, path), `\`${path}\` is not wired`);
  assertEquals(documented.length, 6);
});
