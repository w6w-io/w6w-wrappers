/**
 * `w6w documents …`, driven through the dispatcher against a fake transport.
 *
 * Every case below runs the **real** command line — `main()`, the real registry,
 * the real SDK — with two things substituted: the environment (a plain object)
 * and `fetch` (a function that records the request and answers from a script).
 * No live server is involved anywhere, which is the rule for every wrapper's
 * suite (`docs/implementation.md` §9); a document CRUD test that needed one
 * would be a test nobody could run on a laptop.
 *
 * What is being pinned, beyond "it works":
 *
 * - **Addressing.** Create takes the key, update and delete take the id, and the
 *   key-addressed read goes to the `by-key` route rather than to a list-and-scan.
 * - **The project scope reaches the query string**, and its absence sends no
 *   `?project=` at all — an omitted parameter is how the server is asked for the
 *   account's default project.
 * - **Omit versus set (D2).** A flag that was not typed does not appear in the
 *   patch body. This is asserted on the **wire body**, because that is the only
 *   place the difference between "leave it alone" and "blank it out" exists.
 * - **The exit codes**, including as real process statuses: a mapping function
 *   that returns 2 and a binary that exits 0 look identical from inside.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import type { FetchLike } from "@w6w/sdk";
import { createOutput, HELP_TREE, main } from "../mod.ts";
import { COMMANDS, DOCUMENT_COMMANDS } from "../src/commands/index.ts";
import type { EnvReader } from "../mod.ts";

// ---------------------------------------------------------------------------
// Fakes.
// ---------------------------------------------------------------------------

const BASE = "https://api.example.test";
const CONFIGURED: Record<string, string> = { W6W_BASE_URL: BASE, W6W_TOKEN: "t_cli" };
const ENV: EnvReader = (name) => CONFIGURED[name];

/** One request the CLI made, in the terms the assertions are written in. */
interface Recorded {
  url: string;
  method: string;
  authorization: string | null;
  /** The parsed JSON body, or `undefined` for a bodiless request. */
  body: unknown;
}

/** What a request is answered with. */
type Reply = (call: Recorded) => Response;

/** A JSON response, the way the server sends one. */
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

/** A document, shaped as the server sends it. */
const DOC = {
  id: "doc_01HQ8N",
  key: "onboarding-email",
  content: "Welcome aboard!",
  format: "markdown",
  description: "Sent on signup",
  createdAt: "2026-07-27T09:00:00.000Z",
  updatedAt: "2026-07-27T10:00:00.000Z",
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

Deno.test("documents list: one GET, a readable table, and --json prints the payload alone", async () => {
  const human = await w6w(["documents", "list"], () => json(200, { documents: [DOC] }));

  assertEquals(human.code, 0, human.stderr);
  assertEquals(human.calls.length, 1, "a list is one request, never a list plus a lookup");
  assertEquals(human.calls[0].method, "GET");
  assertEquals(human.calls[0].url, `${BASE}/api/documents`);
  assertEquals(human.calls[0].authorization, "Bearer t_cli");
  assertStringIncludes(human.stdout, "KEY");
  assertStringIncludes(human.stdout, "onboarding-email");
  assertStringIncludes(human.stdout, "doc_01HQ8N");
  assertEquals(human.stderr, "");

  const machine = await w6w(["documents", "list", "--json"], () => json(200, { documents: [DOC] }));
  assertEquals(machine.code, 0, machine.stderr);
  // The payload and nothing else: no heading, no count, no "done" — the point of
  // the flag is that the output goes into a pipe.
  assertEquals(JSON.parse(machine.stdout), [DOC]);

  const empty = await w6w(["documents", "list"], () => json(200, { documents: [] }));
  assertEquals(empty.code, 0, empty.stderr);
  assertStringIncludes(empty.stdout, "No documents.");
});

Deno.test("documents get: addressed by the server-issued id, and the content is shown", async () => {
  const result = await w6w(["documents", "get", "doc_01HQ8N"], () => json(200, { document: DOC }));

  assertEquals(result.code, 0, result.stderr);
  assertEquals(result.calls.length, 1);
  assertEquals(result.calls[0].method, "GET");
  assertEquals(result.calls[0].url, `${BASE}/api/documents/doc_01HQ8N`);
  assertStringIncludes(result.stdout, "onboarding-email");
  assertStringIncludes(result.stdout, "Welcome aboard!");
});

Deno.test("documents get-by-key: the key is encoded and never rejected, and `..` (D1)", async () => {
  // A key with a slash in it is a key the server accepts, so it must reach the
  // `by-key` route as one segment — not as two, which would be a different route.
  const slashed = await w6w(["documents", "get-by-key", "a/b"], () => json(200, { document: DOC }));
  assertEquals(slashed.code, 0, slashed.stderr);
  assertEquals(slashed.calls[0].url, `${BASE}/api/documents/by-key/a%2Fb`);
  assert(!slashed.calls[0].url.includes("by-key/a/b"));

  // D1, this lane's half. `.` is unreserved, so percent-encoding cannot help:
  // the WHATWG URL parser behind `fetch` removes dot segments while building the
  // request, and `…/by-key/..` becomes the LIST route. That happens inside the
  // runtime's transport, so an injected `fetch` — which is handed the string the
  // SDK built — cannot observe it. `new URL` is that same parser, so this is the
  // divergence itself, asserted rather than described.
  assertEquals(new URL(`${BASE}/api/documents/by-key/..`).pathname, "/api/documents/");
  assertEquals(
    new URL(`${BASE}/api/documents/by-key/${encodeURIComponent("..")}`).pathname,
    "/api/documents/",
  );
  // Python's `urllib` sends the same path literally, so the two lanes reach
  // different routes for one key. Neither wrapper works around it; the server's
  // `by-key` route (T4.4.1) is where it is resolved.

  // And nothing here refuses the key: a wrapper that rejected `".."` would make
  // a document a user legitimately created permanently unreadable.
  const dots = await w6w(["documents", "get-by-key", ".."], () => json(200, { documents: [DOC] }));
  assertEquals(dots.calls.length, 1, "the key was sent, not rejected");
  assertEquals(dots.calls[0].url, `${BASE}/api/documents/by-key/..`);
  // What the user sees when that request lands on the list route: a loud
  // failure, not every document silently returned as if it were one.
  assertEquals(dots.code, 2);
  assertStringIncludes(dots.stderr, `no "document" in the response body`);
});

// ---------------------------------------------------------------------------
// Writes.
// ---------------------------------------------------------------------------

Deno.test("documents create: the key is the positional, the body is the documented fields", async () => {
  const result = await w6w(
    [
      "documents",
      "create",
      "onboarding-email",
      "--content",
      "Welcome aboard!",
      "--format",
      "markdown",
    ],
    () => json(201, { document: DOC }),
  );

  assertEquals(result.code, 0, result.stderr);
  assertEquals(result.calls.length, 1);
  assertEquals(result.calls[0].method, "POST");
  assertEquals(result.calls[0].url, `${BASE}/api/documents`);
  // `description` was not given, so it is not on the wire — and `key` is in the
  // body, because a create is addressed by key and not by a path segment.
  assertEquals(result.calls[0].body, {
    key: "onboarding-email",
    content: "Welcome aboard!",
    format: "markdown",
  });
  assertStringIncludes(result.stdout, "Created");
  assertStringIncludes(result.stdout, "onboarding-email");
});

Deno.test("documents update: addressed by id, and only the typed flags reach the wire (D2)", async () => {
  const one = await w6w(
    ["documents", "update", "doc_01HQ8N", "--content", "Welcome back!"],
    () => json(200, { document: DOC }),
  );
  assertEquals(one.code, 0, one.stderr);
  assertEquals(one.calls[0].method, "PATCH");
  assertEquals(one.calls[0].url, `${BASE}/api/documents/doc_01HQ8N`);
  // The assertion that matters: `format` and `description` are ABSENT, not null.
  // A patch that sent them as null would blank two fields the user never named.
  assertEquals(one.calls[0].body, { content: "Welcome back!" });

  // An empty patch is a legal request meaning "change nothing" — and it is the
  // control case for the one above: the same command with no flags sends `{}`.
  const none = await w6w(["documents", "update", "doc_01HQ8N"], () => json(200, { document: DOC }));
  assertEquals(none.code, 0, none.stderr);
  assertEquals(none.calls[0].body, {});

  // An explicitly empty description is a flag the user typed: it clears the
  // field, and must not be mistaken for an absent one by a truthiness test.
  const cleared = await w6w(
    ["documents", "update", "doc_01HQ8N", "--description", ""],
    () => json(200, { document: DOC }),
  );
  assertEquals(cleared.calls[0].body, { description: "" });
});

Deno.test("documents delete: addressed by id, and nothing at all on stdout", async () => {
  const result = await w6w(["documents", "delete", "doc_01HQ8N"], () => json(200, { ok: true }));
  assertEquals(result.code, 0, result.stderr);
  assertEquals(result.calls[0].method, "DELETE");
  assertEquals(result.calls[0].url, `${BASE}/api/documents/doc_01HQ8N`);
  assertEquals(result.calls[0].body, undefined);
  assertStringIncludes(result.stdout, "Deleted doc_01HQ8N.");

  // Under --json there is no payload, because the contract says the `{ok:true}`
  // unwraps to nothing: the machine-readable answer is the exit code.
  const machine = await w6w(
    ["documents", "delete", "doc_01HQ8N", "--json"],
    () => json(200, { ok: true }),
  );
  assertEquals(machine.code, 0, machine.stderr);
  assertEquals(machine.stdout, "");
});

// ---------------------------------------------------------------------------
// The project scope.
// ---------------------------------------------------------------------------

Deno.test("--project reaches the query string on every documents command, and only when given", async () => {
  const scoped: [string[], string][] = [
    [["documents", "list", "--project", "prj_1"], `${BASE}/api/documents?project=prj_1`],
    [
      ["documents", "get", "doc_01HQ8N", "--project", "prj_1"],
      `${BASE}/api/documents/doc_01HQ8N?project=prj_1`,
    ],
    [
      ["documents", "get-by-key", "onboarding-email", "--project", "prj_1"],
      `${BASE}/api/documents/by-key/onboarding-email?project=prj_1`,
    ],
    [
      ["documents", "create", "k", "--content", "c", "--project", "prj_1"],
      `${BASE}/api/documents?project=prj_1`,
    ],
    [
      ["documents", "update", "doc_01HQ8N", "--project", "prj_1"],
      `${BASE}/api/documents/doc_01HQ8N?project=prj_1`,
    ],
    [
      ["documents", "delete", "doc_01HQ8N", "--project", "prj_1"],
      `${BASE}/api/documents/doc_01HQ8N?project=prj_1`,
    ],
  ];
  for (const [argv, url] of scoped) {
    const result = await w6w(argv, () => json(200, { documents: [DOC], document: DOC, ok: true }));
    assertEquals(result.code, 0, `\`${argv.join(" ")}\`: ${result.stderr}`);
    assertEquals(result.calls[0].url, url);
  }

  // Omitted, no `?project=` is sent at all — that absence is how the server is
  // asked to resolve the account's default project. An empty parameter would be
  // a different request.
  const unscoped = await w6w(["documents", "list"], () => json(200, { documents: [] }));
  assert(!unscoped.calls[0].url.includes("project"), unscoped.calls[0].url);
});

// ---------------------------------------------------------------------------
// Failure.
// ---------------------------------------------------------------------------

Deno.test("an API error exits 2, on stderr, with stdout left clean", async () => {
  const missing = await w6w(
    ["documents", "get", "doc_nope"],
    () => json(404, { error: { code: "unknown_document", message: "no such document" } }),
  );
  assertEquals(missing.code, 2);
  assertEquals(missing.stdout, "", "an error must never reach stdout");
  assertStringIncludes(missing.stderr, "no such document");

  // The `409` a duplicate key produces reaches the user with the server's own
  // message rather than being swallowed into something generic.
  const duplicate = await w6w(
    ["documents", "create", "onboarding-email", "--content", "x"],
    () => json(409, { error: { code: "document_exists", message: "key already taken" } }),
  );
  assertEquals(duplicate.code, 2);
  assertStringIncludes(duplicate.stderr, "key already taken");
});

Deno.test("a 2xx body missing its envelope key is bad_response, and exits 2 (D3)", async () => {
  // Distinct from `"error"` — nothing failed at the HTTP level. Deferring it by
  // returning undefined would turn a server regression into a crash somewhere in
  // the caller's own code, minutes later, pointing at nothing.
  const result = await w6w(["documents", "list"], () => json(200, { totallyDifferent: [] }));
  assertEquals(result.code, 2);
  assertStringIncludes(result.stderr, `no "documents" in the response body`);
  assertEquals(result.stdout, "");
});

Deno.test("a bad invocation is a usage error, exits 1, and makes no request", async () => {
  const cases: [string[], string][] = [
    [["documents", "get"], "needs a document id"],
    [["documents", "get-by-key"], "needs a document key"],
    [["documents", "create", "k"], "--content <text>"],
    [["documents", "update"], "needs the document id"],
    [["documents", "delete"], "needs the document id"],
    [["documents", "get", "doc_1", "doc_2"], "extra one: `doc_2`"],
    [["documents", "list", "stray"], "takes no arguments"],
  ];
  for (const [argv, expected] of cases) {
    const result = await w6w(argv);
    assertEquals(result.code, 1, `\`${argv.join(" ")}\` exited ${result.code}`);
    assertStringIncludes(result.stderr, expected);
    assertEquals(result.calls.length, 0, "a usage error must not reach the server");
    assertEquals(result.stdout, "");
  }
});

Deno.test("a bad flag is named accurately, even beside the command's own valid flags", async () => {
  // Two parse passes are needed — a command's own flags are unknown until its
  // path has been read out of the same argv — and the failure reported must be
  // the SECOND pass's: it ran knowing more flags, so it got further and its
  // complaint is about the flag that is actually wrong. Reporting the first
  // pass's message named `--content` here: a flag this command declares and
  // requires, sending the user to fix the one thing that was right.
  const result = await w6w(["documents", "create", "k", "--content", "c", "--bogus"]);
  assertEquals(result.code, 1);
  assertStringIncludes(result.stderr, "unknown flag: --bogus");
  assert(!result.stderr.includes("unknown flag: --content"), result.stderr);
  assertEquals(result.calls.length, 0);
});

Deno.test("a void result can never put the literal `undefined` on stdout under --json", async () => {
  // The two `delete` commands are the first operations in this CLI that return
  // nothing, which arms a latent hazard in the renderer: `JSON.stringify(
  // undefined)` is `undefined` — the six-character word, not JSON — and a
  // consumer piping `--json` into `jq` would get a parse error instead of a
  // value. Two independent guards keep it unreachable, and both are asserted.

  // (a) A delete does not emit at all. The server's `{ok:true}` unwraps to
  //     nothing, so a delete's whole machine-readable answer is its exit code.
  const deleted = await w6w(
    ["documents", "delete", "doc_01HQ8N", "--json"],
    () => json(200, { ok: true }),
  );
  assertEquals(deleted.code, 0, deleted.stderr);
  assertEquals(deleted.stdout, "");
  assert(!deleted.stdout.includes("undefined"), "a void payload reached stdout");

  // (b) And if any command ever did emit a void payload, the renderer coerces it
  //     to `null` (`payload ?? null`, src/output.ts) so the output still parses.
  //     Asserted through the real renderer rather than by reading the source: a
  //     guard that is only visible in a diff is one a refactor can drop.
  const lines: string[] = [];
  const out = createOutput({ stdout: (text) => lines.push(text), stderr: () => {} }, {
    json: true,
  });
  out.emit(undefined, () => "the human rendering, which --json suppresses");
  assertEquals(lines, ["null"]);
  assertEquals(JSON.parse(lines[0]), null);
});

// ---------------------------------------------------------------------------
// Registration.
// ---------------------------------------------------------------------------

Deno.test("every `w6w documents` command in the help tree is registered, and no others", () => {
  const group = HELP_TREE.groups.find((candidate) => candidate.name === "documents");
  assert(group !== undefined, "the generated help tree has no `documents` group");
  const documented = group.commands.map((command) => command.path.join(" ")).sort();
  assertEquals(Object.keys(DOCUMENT_COMMANDS).sort(), documented);
  // And the union the dispatcher walks carries them under the same keys — the
  // spellings are `endpoints.json`'s `naming.cli`, character for character.
  for (const path of documented) assert(Object.hasOwn(COMMANDS, path), `\`${path}\` is not wired`);
  assertEquals(documented.length, 6);
});

// ---------------------------------------------------------------------------
// The exit codes, as the shell sees them.
// ---------------------------------------------------------------------------

/** A file URL as a filesystem path — `@std/path`'s `fromFileUrl`, without the import. */
function pathOf(url: URL): string {
  const path = decodeURIComponent(url.pathname);
  return /^\/[A-Za-z]:\//.test(path) ? path.slice(1) : path;
}

Deno.test("the exit codes are the process's own, not a mapper's return value", async () => {
  const binary = pathOf(new URL("../bin/w6w.ts", import.meta.url));
  const spawn = async (args: string[], env: Record<string, string>, permissions: string[]) => {
    const command = new Deno.Command(Deno.execPath(), {
      args: ["run", ...permissions, binary, ...args],
      cwd: pathOf(new URL("../", import.meta.url)),
      env,
      clearEnv: true,
      stdout: "piped",
      stderr: "piped",
    });
    const result = await command.output();
    return { code: result.code, stderr: new TextDecoder().decode(result.stderr) };
  };

  // 1 — a missing argument, decided entirely inside this package.
  const usage = await spawn(["documents", "get"], {}, ["--allow-env"]);
  assertEquals(usage.code, 1, usage.stderr);
  assertStringIncludes(usage.stderr, "needs a document id");

  // 2 — a real `ApiError`, raised by the SDK's transport against a port nothing
  // is listening on. No server is started: a refused connection is precisely the
  // `network_error` case, and it proves the whole chain — handler to `main()` to
  // `runtime.exit()` — rather than the mapping alone.
  const unreachable = await spawn(
    ["documents", "list"],
    { W6W_BASE_URL: "http://127.0.0.1:1", W6W_TOKEN: "t_cli" },
    ["--allow-env", "--allow-net"],
  );
  assertEquals(unreachable.code, 2, unreachable.stderr);
  assertStringIncludes(unreachable.stderr, "Could not reach the w6w server");
});
