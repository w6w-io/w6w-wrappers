/**
 * `w6w me`/`info`, `w6w connections list`, `w6w workflows …` and `w6w run`,
 * driven through the dispatcher against a fake transport — the same style as
 * `cmd_documents_test.ts` / `cmd_vars_test.ts`, sized to these four groups'
 * one-or-two-command shape rather than split across four near-empty files.
 *
 * What is being pinned, beyond "it works":
 *
 * - **D5.** `w6w me`'s `--json` payload is the wire's `versions` map,
 *   untouched; only the human-readable render substitutes `dev` for `0.0.0`
 *   or an empty string.
 * - **`w6w info` reaches the same handler as `w6w me`** — the alias
 *   resolves to one canonical command, not a second registration.
 * - **A failed `--wait` run is data, not an exception (D3/D4)**, and this is
 *   the one command in this build whose exit code depends on the response
 *   body rather than only on whether the SDK raised.
 * - **`w6w run` renders all three known `kind`s and the open fourth one**,
 *   and `--payload` is a usage error (exit 1) when it is not a JSON object —
 *   never a guess, because `run`'s payload has no string fallback the way
 *   `vars`' `--value` does.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import type { FetchLike } from "@w6w/sdk";
import { HELP_TREE, main } from "../mod.ts";
import {
  COMMANDS,
  CONNECTION_COMMANDS,
  FUNCTION_COMMANDS,
  ME_COMMANDS,
  NAMED_RUN_COMMANDS,
  RUN_COMMANDS,
  WORKFLOW_COMMANDS,
} from "../src/commands/index.ts";
import type { EnvReader } from "../mod.ts";

// ---------------------------------------------------------------------------
// Fakes — identical shape to cmd_documents_test.ts.
// ---------------------------------------------------------------------------

const BASE = "https://api.example.test";
const CONFIGURED: Record<string, string> = { W6W_BASE_URL: BASE, W6W_TOKEN: "t_cli" };
const ENV: EnvReader = (name) => CONFIGURED[name];

interface Recorded {
  url: string;
  method: string;
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

async function w6w(argv: string[], reply: Reply = () => json(200, {})): Promise<Ran> {
  const calls: Recorded[] = [];
  const stdout: string[] = [];
  const stderr: string[] = [];
  const fetch: FetchLike = (url, init) => {
    const call: Recorded = {
      url,
      method: init?.method ?? "GET",
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
// `w6w me` / `w6w info`.
// ---------------------------------------------------------------------------

const IDENTITY = { tenant: "t_acme", subject: "alice", account: "acct_1", role: "member" };

Deno.test("me: one GET to /auth/me, and info reaches the same handler", async () => {
  const result = await w6w(["me"], () => json(200, IDENTITY));
  assertEquals(result.code, 0, result.stderr);
  assertEquals(result.calls.length, 1);
  assertEquals(result.calls[0].method, "GET");
  assertEquals(result.calls[0].url, `${BASE}/auth/me`);
  assertStringIncludes(result.stdout, "t_acme");
  assertStringIncludes(result.stdout, "alice");

  const alias = await w6w(["info"], () => json(200, IDENTITY));
  assertEquals(alias.code, 0, alias.stderr);
  assertEquals(alias.calls[0].url, `${BASE}/auth/me`, "info must hit the same route as me");
});

Deno.test("me: D5 — 0.0.0 and empty versions render as `dev`, but --json carries them verbatim", async () => {
  const withVersions = {
    ...IDENTITY,
    versions: { wrapper: "0.0.0", server: "1a2b3c4", empty: "" },
  };

  const human = await w6w(["me"], () => json(200, withVersions));
  assertEquals(human.code, 0, human.stderr);
  assertStringIncludes(human.stdout, "wrapper: dev");
  assertStringIncludes(human.stdout, "empty: dev");
  assertStringIncludes(human.stdout, "server: 1a2b3c4");
  assert(!human.stdout.includes("0.0.0"), "the rendered banner must never show a literal 0.0.0");

  const machine = await w6w(["me", "--json"], () => json(200, withVersions));
  assertEquals(
    JSON.parse(machine.stdout).versions.wrapper,
    "0.0.0",
    "the JSON payload is unaltered",
  );
});

Deno.test("me: a server that sends no versions block still shows the wrapper's own version", async () => {
  // The SDK's own merge is `{ wrapper: VERSION, ...body.versions }` — the
  // wrapper's version is a DEFAULT contributed unconditionally, not something
  // added only when the server also sent something. So `versions` is never
  // truly empty from a real client, and the render must show it.
  const result = await w6w(["me"], () => json(200, IDENTITY));
  assertEquals(result.code, 0, result.stderr);
  assertStringIncludes(result.stdout, "versions:");
  assertStringIncludes(result.stdout, "wrapper:");
});

// ---------------------------------------------------------------------------
// `w6w connections list`.
// ---------------------------------------------------------------------------

const CONNECTION = {
  id: "conn_01HQ8N",
  appId: "sendgrid",
  authKey: "apiKey",
  owner: "alice",
  displayName: "Marketing SendGrid",
  state: "connected",
  profile: {},
  lastTestOk: true,
  lastTestedAt: "2026-07-27T09:00:00.000Z",
  createdAt: "2026-07-01T09:00:00.000Z",
  updatedAt: "2026-07-27T09:00:00.000Z",
};

Deno.test("connections list: one GET, a readable table, and --json prints the payload alone", async () => {
  const human = await w6w(["connections", "list"], () => json(200, { connections: [CONNECTION] }));
  assertEquals(human.code, 0, human.stderr);
  assertEquals(human.calls.length, 1);
  assertEquals(human.calls[0].url, `${BASE}/connections`);
  assertStringIncludes(human.stdout, "sendgrid");
  assertStringIncludes(human.stdout, "conn_01HQ8N");

  const machine = await w6w(
    ["connections", "list", "--json"],
    () => json(200, { connections: [CONNECTION] }),
  );
  assertEquals(JSON.parse(machine.stdout), [CONNECTION]);

  const empty = await w6w(["connections", "list"], () => json(200, { connections: [] }));
  assertStringIncludes(empty.stdout, "No connections.");
});

Deno.test("`conn ls`/`conn list` reach the same route as `connections list`", async () => {
  for (const argv of [["conn", "list"], ["connections", "ls"], ["conn", "ls"]]) {
    const result = await w6w(argv, () => json(200, { connections: [CONNECTION] }));
    assertEquals(result.code, 0, result.stderr);
    assertEquals(result.calls[0].url, `${BASE}/connections`);
  }
});

// ---------------------------------------------------------------------------
// `w6w workflows list` / `w6w workflows run`.
// ---------------------------------------------------------------------------

const WORKFLOW = {
  id: "wf_01HQ8N",
  name: "welcome-email",
  displayName: "Welcome email",
  description: "",
  status: "active",
  tags: [],
  runCount: 3,
  updatedAt: "2026-07-27T09:00:00.000Z",
};

Deno.test("workflows list: --project reaches the query string, and only when given", async () => {
  const scoped = await w6w(
    ["workflows", "list", "--project", "prj_1"],
    () => json(200, { workflows: [WORKFLOW] }),
  );
  assertEquals(scoped.code, 0, scoped.stderr);
  assertStringIncludes(scoped.calls[0].url, "project=prj_1");

  const unscoped = await w6w(["workflows", "list"], () => json(200, { workflows: [WORKFLOW] }));
  assert(
    !unscoped.calls[0].url.includes("project="),
    "an omitted --project must send no ?project= at all",
  );
  assertStringIncludes(unscoped.stdout, "welcome-email");
});

Deno.test("`wf ls`/`wf list` reach the same route as `workflows list`", async () => {
  for (const argv of [["wf", "list"], ["workflows", "ls"], ["wf", "ls"]]) {
    const result = await w6w(argv, () => json(200, { workflows: [WORKFLOW] }));
    assertEquals(result.code, 0, result.stderr);
    assertStringIncludes(result.calls[0].url, `${BASE}/workflows`);
  }
});

Deno.test("workflows run: a queued run is exit 0, and --wait is sent only when asked", async () => {
  const noWait = await w6w(["workflows", "run", "wf_01HQ8N"], (call) => {
    assert(!call.url.includes("wait="), "no --wait must send no ?wait= at all");
    return json(202, { runId: "run_1", status: "queued" });
  });
  assertEquals(noWait.code, 0, noWait.stderr);
  assertStringIncludes(noWait.stdout, "run_1");
  assertStringIncludes(noWait.stdout, "queued");

  const waited = await w6w(["workflows", "run", "wf_01HQ8N", "--wait"], (call) => {
    assertStringIncludes(call.url, "wait=true");
    return json(200, { runId: "run_1", status: "succeeded", output: { ok: true }, steps: {} });
  });
  assertEquals(waited.code, 0, waited.stderr);
});

Deno.test("workflows run: a failed run with --wait is exit 3, and nothing raised (D3/D4)", async () => {
  const result = await w6w(
    ["workflows", "run", "wf_01HQ8N", "--wait"],
    () => json(200, { runId: "run_1", status: "failed", error: { message: "boom" }, steps: {} }),
  );
  assertEquals(result.code, 3, result.stderr);
  assertStringIncludes(result.stdout, "run_1");
  assertStringIncludes(result.stdout, "failed");
  assertStringIncludes(result.stdout, "boom");
  assertEquals(
    result.stderr,
    "",
    "a run-level failure is not printed to stderr — it is not a thrown error",
  );
});

Deno.test("workflows run: --input reaches the request body, distinct from variables", async () => {
  const result = await w6w(
    ["workflows", "run", "wf_01HQ8N", "--input", '{"email":"a@example.com"}'],
    (call) => {
      assertEquals(call.body, { input: { email: "a@example.com" } });
      return json(202, { runId: "run_1", status: "queued" });
    },
  );
  assertEquals(result.code, 0, result.stderr);
  assertEquals(result.calls.length, 1);
});

Deno.test("workflows run: no --input sends no `input` key at all", async () => {
  const result = await w6w(["workflows", "run", "wf_01HQ8N"], (call) => {
    assertEquals(call.body, {});
    return json(202, { runId: "run_1", status: "queued" });
  });
  assertEquals(result.code, 0, result.stderr);
});

Deno.test(
  "workflows run: --input that is not valid JSON, or not an object, is a usage error — never a guess",
  async () => {
    const badJson = await w6w(["workflows", "run", "wf_01HQ8N", "--input", "{not json"]);
    assertEquals(badJson.code, 1, badJson.stderr);
    assertStringIncludes(badJson.stderr, "must be valid JSON");
    assertEquals(badJson.calls.length, 0, "an invalid --input must never reach the wire");

    const array = await w6w(["workflows", "run", "wf_01HQ8N", "--input", "[1,2]"]);
    assertEquals(array.code, 1, array.stderr);
    assertStringIncludes(array.stderr, "must be a JSON object");
    assertEquals(array.calls.length, 0, "a non-object --input must never reach the wire");
  },
);

// ---------------------------------------------------------------------------
// `w6w run <urn>` — the unified dispatcher.
// ---------------------------------------------------------------------------

Deno.test("run: the action arm — urn, action and payload all reach the body", async () => {
  const result = await w6w(
    ["run", "conn_01HQ8N", "--action", "message-post", "--payload", '{"text":"hi"}'],
    (call) => {
      assertEquals(call.body, {
        urn: "conn_01HQ8N",
        action: "message-post",
        payload: { text: "hi" },
      });
      return json(200, { kind: "action", value: { ok: true } });
    },
  );
  assertEquals(result.code, 0, result.stderr);
  assertEquals(result.calls[0].url, `${BASE}/run`);
  assertStringIncludes(result.stdout, "action");
});

Deno.test("run: the function arm", async () => {
  const result = await w6w(
    ["run", "fn_greet"],
    () => json(200, { kind: "function", output: { greeting: "hi" } }),
  );
  assertEquals(result.code, 0, result.stderr);
  assertStringIncludes(result.stdout, "function");
  assertStringIncludes(result.stdout, "greeting");
});

Deno.test("run: the workflow arm is exit 0 — it never waits and never fails synchronously (D4)", async () => {
  const result = await w6w(
    ["run", "wf_01HQ8N"],
    () => json(202, { kind: "workflow", runId: "run_1", status: "queued" }),
  );
  assertEquals(result.code, 0, result.stderr);
  assertStringIncludes(result.stdout, "workflow");
  assertStringIncludes(result.stdout, "run_1");
  assertStringIncludes(result.stdout, "workflows run run_1 --wait");
});

Deno.test("run: an unknown kind is shown, not raised", async () => {
  const result = await w6w(
    ["run", "ep_hook"],
    () => json(200, { kind: "batch", jobId: "job_1" }),
  );
  assertEquals(result.code, 0, result.stderr);
  assertStringIncludes(result.stdout, "batch");
  assertStringIncludes(result.stdout, "not recognized by this build");
  assertStringIncludes(result.stdout, "job_1");
});

Deno.test("run: --payload that is not valid JSON, or not an object, is a usage error — never a guess", async () => {
  const badJson = await w6w(["run", "wf_1", "--payload", "{not json"]);
  assertEquals(badJson.code, 1, badJson.stderr);
  assertStringIncludes(badJson.stderr, "must be valid JSON");
  assertEquals(badJson.calls.length, 0, "an invalid --payload must never reach the wire");

  const notObject = await w6w(["run", "wf_1", "--payload", '"just a string"']);
  assertEquals(notObject.code, 1, notObject.stderr);
  assertStringIncludes(notObject.stderr, "must be a JSON object");

  const array = await w6w(["run", "wf_1", "--payload", "[1,2,3]"]);
  assertEquals(array.code, 1, array.stderr);
  assertEquals(array.calls.length, 0);
});

// ---------------------------------------------------------------------------
// `w6w run --app <id>` — addressing a connection by app instead of by URN.
// ---------------------------------------------------------------------------

const SECOND_CONNECTION = {
  ...CONNECTION,
  id: "conn_01HQ9Z",
  displayName: "Transactional SendGrid",
};

Deno.test("run --app: a single matching connection is resolved and run outright", async () => {
  const result = await w6w(
    ["run", "--action", "send_email", "--app", "sendgrid"],
    (call) => {
      if (call.url.endsWith("/connections")) return json(200, { connections: [CONNECTION] });
      assertEquals((call.body as { urn: string }).urn, "conn_01HQ8N");
      assertEquals((call.body as { action: string }).action, "send_email");
      return json(200, { kind: "action", value: { ok: true } });
    },
  );
  assertEquals(result.code, 0, result.stderr);
  assertEquals(result.calls.length, 2, "a connections lookup, then the run itself");
  assertEquals(result.calls[0].url, `${BASE}/connections`);
  assertEquals(result.calls[1].url, `${BASE}/run`);
});

Deno.test("run --app: no matching connection is a usage error naming the app", async () => {
  const result = await w6w(
    ["run", "--action", "send_email", "--app", "unknownapp"],
    () => json(200, { connections: [CONNECTION] }),
  );
  assertEquals(result.code, 1);
  assertEquals(result.calls.length, 1, "never reaches /run without a resolved urn");
  assertStringIncludes(result.stderr, "No connection found for app `unknownapp`");
  assertStringIncludes(result.stderr, "w6w connections list");
});

Deno.test("run --app: several matching connections is a usage error listing each, with a ready-to-run suggestion", async () => {
  const result = await w6w(
    ["run", "--action", "send_email", "--app", "sendgrid", "--payload", '{"to":"a@b.com"}'],
    () => json(200, { connections: [CONNECTION, SECOND_CONNECTION] }),
  );
  assertEquals(result.code, 1);
  assertEquals(result.calls.length, 1, "never reaches /run when the app is ambiguous");
  assertStringIncludes(result.stderr, "Multiple connections found for app `sendgrid`");
  assertStringIncludes(result.stderr, "conn_01HQ8N");
  assertStringIncludes(result.stderr, "Marketing SendGrid");
  assertStringIncludes(result.stderr, "conn_01HQ9Z");
  assertStringIncludes(result.stderr, "Transactional SendGrid");
  // The suggested command is complete and runnable, action and payload intact.
  assertStringIncludes(
    result.stderr,
    `w6w run conn_01HQ8N --action send_email --payload '{"to":"a@b.com"}'`,
  );
  assertStringIncludes(
    result.stderr,
    `w6w run conn_01HQ9Z --action send_email --payload '{"to":"a@b.com"}'`,
  );
});

Deno.test("run --app: a URN and --app together is a usage error, and no request is made", async () => {
  const result = await w6w(["run", "conn_01HQ8N", "--app", "sendgrid"]);
  assertEquals(result.code, 1);
  assertEquals(result.calls.length, 0);
  assertStringIncludes(result.stderr, "takes a URN or `--app <id>`, not both");
});

// ---------------------------------------------------------------------------
// Registration — the help tree and the registry must name the same commands.
// ---------------------------------------------------------------------------

Deno.test("every root-level command (me, run) in the help tree is registered", () => {
  const documented = HELP_TREE.commands.map((command) => command.path.join(" ")).sort();
  assertEquals(documented, ["me", "run"]);
  for (const path of documented) assert(Object.hasOwn(COMMANDS, path), `\`${path}\` is not wired`);
  assertEquals(Object.keys(ME_COMMANDS), ["me"]);
  assertEquals(Object.keys(RUN_COMMANDS), ["run"]);
});

Deno.test("every `w6w connections` / `w6w workflows` / `w6w functions` command in the help tree is registered, and no others", () => {
  // `functions` is assembled from TWO registries, and that is the point of
  // listing it here: `functions run` lives in `named-run.ts` beside its twin
  // `endpoints run`, while the rest of the group lives in `functions.ts`. A
  // reader of the help tree sees one group either way, so the check is against
  // the union — which is also what would catch a command landing in neither.
  const functionsGroup = {
    ...FUNCTION_COMMANDS,
    "functions run": NAMED_RUN_COMMANDS["functions run"],
  };
  for (
    const [groupName, registry] of [
      ["connections", CONNECTION_COMMANDS],
      ["workflows", WORKFLOW_COMMANDS],
      ["functions", functionsGroup],
    ] as const
  ) {
    const group = HELP_TREE.groups.find((candidate) => candidate.name === groupName);
    assert(group !== undefined, `the generated help tree has no \`${groupName}\` group`);
    const documented = group.commands.map((command) => command.path.join(" ")).sort();
    assertEquals(Object.keys(registry).sort(), documented);
    for (const path of documented) {
      assert(Object.hasOwn(COMMANDS, path), `\`${path}\` is not wired`);
    }
  }
  assertEquals(Object.keys(CONNECTION_COMMANDS).length, 1);
  // Seven and five: the two run commands (`workflows run`, `functions run`)
  // plus the definition lifecycle each domain now carries. `functions` counts
  // five here because its `run` is registered elsewhere — see above.
  assertEquals(Object.keys(WORKFLOW_COMMANDS).length, 7);
  assertEquals(Object.keys(FUNCTION_COMMANDS).length, 5);
});
