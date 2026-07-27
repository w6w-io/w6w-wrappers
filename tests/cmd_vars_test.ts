/**
 * `w6w vars …`, driven through the dispatcher against a fake transport.
 *
 * Same shape as `tests/cmd_documents_test.ts` — the real `main()`, the real
 * registry, the real SDK, with the environment and `fetch` substituted — and
 * three rules of its own on top:
 *
 * - **No `?project=`, ever.** Variables are scoped by tenant and subject, the
 *   `vars` table has no project column, and no `vars` route reads the parameter.
 *   Passing `--project` is a usage error rather than a no-op, because a flag
 *   that is quietly ignored teaches a scoping model that does not exist.
 * - **Omit versus null (D2).** `--description x` sends `{"description":"x"}`;
 *   no flags at all sends `{}`; `--value null` sends `{"value":null}`. Three
 *   different requests meaning three different things, asserted on the wire
 *   body, which is the only place the difference is visible.
 * - **`--value` is encoded, never validated.** The type policy is the server's
 *   (`400 invalid_type` / `400 invalid_value`); the CLI only decides how the text
 *   a shell hands it becomes JSON.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import type { FetchLike } from "@w6w/sdk";
import { HELP_TREE, main } from "../mod.ts";
import { COMMANDS, VAR_COMMANDS } from "../src/commands/index.ts";
import { encodeValue } from "../src/commands/vars.ts";
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

/** A variable, shaped as the server sends it. */
const VAR = {
  id: "var_01HQ8N",
  name: "greeting",
  type: "string",
  value: "hello",
  description: "Salutation used by the welcome workflow",
  createdAt: "2026-07-27T09:00:00.000Z",
  updatedAt: "2026-07-27T10:00:00.000Z",
};

/** The singular envelope key is `var` — a reserved word, so never destructured. */
const ONE_VAR = { var: VAR };

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

Deno.test("vars list: one GET, a readable table, and --json prints the payload alone", async () => {
  const human = await w6w(["vars", "list"], () => json(200, { vars: [VAR] }));

  assertEquals(human.code, 0, human.stderr);
  assertEquals(human.calls.length, 1, "a list is one request, never a list plus a lookup");
  assertEquals(human.calls[0].method, "GET");
  assertEquals(human.calls[0].url, `${BASE}/api/vars`);
  assertEquals(human.calls[0].authorization, "Bearer t_cli");
  assertStringIncludes(human.stdout, "NAME");
  assertStringIncludes(human.stdout, "greeting");
  assertStringIncludes(human.stdout, "var_01HQ8N");
  assertEquals(human.stderr, "");

  const machine = await w6w(["vars", "list", "--json"], () => json(200, { vars: [VAR] }));
  assertEquals(machine.code, 0, machine.stderr);
  assertEquals(JSON.parse(machine.stdout), [VAR]);

  const empty = await w6w(["vars", "list"], () => json(200, { vars: [] }));
  assertEquals(empty.code, 0, empty.stderr);
  assertStringIncludes(empty.stdout, "No variables.");
});

Deno.test("vars get and get-by-name: id- and name-addressed reads, both encoded", async () => {
  const byId = await w6w(["vars", "get", "var_01HQ8N"], () => json(200, ONE_VAR));
  assertEquals(byId.code, 0, byId.stderr);
  assertEquals(byId.calls[0].method, "GET");
  assertEquals(byId.calls[0].url, `${BASE}/api/vars/var_01HQ8N`);
  assertStringIncludes(byId.stdout, "greeting");
  assertStringIncludes(byId.stdout, '"hello"');

  // The name goes to the dedicated route — never a list-then-scan, which would
  // be O(everything) and would race with anyone else writing.
  const byName = await w6w(["vars", "get-by-name", "greeting"], () => json(200, ONE_VAR));
  assertEquals(byName.code, 0, byName.stderr);
  assertEquals(byName.calls.length, 1);
  assertEquals(byName.calls[0].url, `${BASE}/api/vars/by-name/greeting`);

  // Encoding, not validation: the name rule is the server's, and a name it
  // rejects comes back as `400 invalid_name` from the one place that owns it.
  const odd = await w6w(["vars", "get-by-name", "a b/c"], () => json(200, ONE_VAR));
  assertEquals(odd.calls[0].url, `${BASE}/api/vars/by-name/a%20b%2Fc`);
});

// ---------------------------------------------------------------------------
// Writes.
// ---------------------------------------------------------------------------

Deno.test("vars create: the name is the positional, and --value is encoded by --type", async () => {
  const result = await w6w(
    ["vars", "create", "greeting", "--type", "string", "--value", "hello"],
    () => json(201, ONE_VAR),
  );
  assertEquals(result.code, 0, result.stderr);
  assertEquals(result.calls[0].method, "POST");
  assertEquals(result.calls[0].url, `${BASE}/api/vars`);
  // `description` was not given, so it is not on the wire; `name` is in the body
  // because a create is addressed by name and not by a path segment.
  assertEquals(result.calls[0].body, { name: "greeting", type: "string", value: "hello" });
  assertStringIncludes(result.stdout, "Created");

  // The typed values, on the wire, in the type the server will check them as.
  const typed: [string, string, unknown][] = [
    ["number", "42", 42],
    ["boolean", "true", true],
    ["json", '{"a":[1,2]}', { a: [1, 2] }],
    // A `string` value is the text verbatim, even when the text looks like JSON:
    // `--type string --value 42` is the two-character string, not the number.
    ["string", "42", "42"],
  ];
  for (const [type, text, value] of typed) {
    const call = await w6w(
      ["vars", "create", "v", "--type", type, "--value", text],
      () => json(201, ONE_VAR),
    );
    assertEquals(call.code, 0, `--type ${type}: ${call.stderr}`);
    assertEquals(call.calls[0].body, { name: "v", type, value });
  }

  // Nothing is rejected locally: a value that does not match its type is sent,
  // and the server answers with the code that owns the rule.
  const mismatch = await w6w(
    ["vars", "create", "v", "--type", "number", "--value", "forty-two"],
    () => json(400, { error: { code: "invalid_value", message: "not a number" } }),
  );
  assertEquals(mismatch.calls[0].body, { name: "v", type: "number", value: "forty-two" });
  assertEquals(mismatch.code, 2);
  assertStringIncludes(mismatch.stderr, "not a number");
});

Deno.test("vars update: addressed by id — omit, set and explicit null are three requests (D2)", async () => {
  // (a) A field the user named, and only that field. `type` and `value` are
  //     ABSENT from the body, not null: the variable keeps both.
  const one = await w6w(
    ["vars", "update", "var_01HQ8N", "--description", "Salutation"],
    () => json(200, ONE_VAR),
  );
  assertEquals(one.code, 0, one.stderr);
  assertEquals(one.calls[0].method, "PATCH");
  assertEquals(one.calls[0].url, `${BASE}/api/vars/var_01HQ8N`);
  assertEquals(one.calls[0].body, { description: "Salutation" });

  // (b) No flags at all: an empty patch, changing nothing. The control case —
  //     without it, an implementation that sent nulls for the missing fields
  //     would still pass (a).
  const none = await w6w(["vars", "update", "var_01HQ8N"], () => json(200, ONE_VAR));
  assertEquals(none.code, 0, none.stderr);
  assertEquals(none.calls[0].body, {});

  // (c) An explicit null, which is a different intent from (b) and must be
  //     expressible: the user is setting the value TO null, not leaving it.
  const nulled = await w6w(
    ["vars", "update", "var_01HQ8N", "--value", "null"],
    () => json(200, ONE_VAR),
  );
  assertEquals(nulled.code, 0, nulled.stderr);
  assertEquals(nulled.calls[0].body, { value: null });
  // And the JSON `null` is on the wire as a null, not as the string "null".
  assertEquals(Object.hasOwn(nulled.calls[0].body as object, "value"), true);

  // A value sent without a type is validated against the variable's existing
  // type, server-side — so the CLI restates neither.
  const retyped = await w6w(
    ["vars", "update", "var_01HQ8N", "--type", "number", "--value", "7"],
    () => json(200, ONE_VAR),
  );
  assertEquals(retyped.calls[0].body, { type: "number", value: 7 });
});

Deno.test("vars delete: addressed by id, and nothing at all on stdout", async () => {
  const result = await w6w(["vars", "delete", "var_01HQ8N"], () => json(200, { ok: true }));
  assertEquals(result.code, 0, result.stderr);
  assertEquals(result.calls[0].method, "DELETE");
  assertEquals(result.calls[0].url, `${BASE}/api/vars/var_01HQ8N`);
  assertEquals(result.calls[0].body, undefined);
  assertStringIncludes(result.stdout, "Deleted var_01HQ8N.");

  const machine = await w6w(
    ["vars", "delete", "var_01HQ8N", "--json"],
    () => json(200, { ok: true }),
  );
  assertEquals(machine.code, 0, machine.stderr);
  assertEquals(machine.stdout, "");
});

// ---------------------------------------------------------------------------
// The project asymmetry.
// ---------------------------------------------------------------------------

Deno.test("--project is refused by every vars command, and never reaches the server", async () => {
  // The parser rejects the flag before dispatch, because `--project` is not one
  // of a `vars` command's declared flags: exit 1, no request, and the command's
  // own help — which lists no --project — printed beneath it.
  for (
    const argv of [
      ["vars", "list", "--project", "prj_1"],
      ["vars", "get", "var_01HQ8N", "--project", "prj_1"],
      ["vars", "delete", "var_01HQ8N", "--project=prj_1"],
      // The case that used to name the WRONG flag: a command with declared flags
      // of its own needs two parse passes, and reporting the first pass's message
      // answered `unknown flag: --type` — a flag `vars create` both declares and
      // requires. The second pass ran knowing more, so its complaint is the one
      // the user can act on (`mod.ts:parseInvocation`).
      ["vars", "create", "greeting", "--type", "string", "--value", "hello", "--project", "prj_1"],
      ["vars", "update", "var_01HQ8N", "--value", "hello", "--project", "prj_1"],
    ]
  ) {
    const result = await w6w(argv);
    assertEquals(result.code, 1, `\`${argv.join(" ")}\` exited ${result.code}`);
    assertEquals(result.calls.length, 0, "a refused flag must not reach the server");
    assertStringIncludes(result.stderr, "unknown flag: --project");
    assert(
      !result.stderr.includes("unknown flag: --type"),
      `\`${argv.join(" ")}\` blamed a valid flag: ${result.stderr}`,
    );
  }

  // And where the flag survives parsing — escaped past `--`, or if it were ever
  // added to the `vars` operations by mistake — the group's own guard explains
  // WHY, which the parser's generic message cannot (BLK-2).
  const escaped = await w6w(["vars", "list", "--", "--project", "prj_1"]);
  assertEquals(escaped.code, 1);
  assertEquals(escaped.calls.length, 0);
  assertStringIncludes(escaped.stderr, "variables are not project-scoped");
  assertStringIncludes(escaped.stderr, "w6w documents");

  // The positive half of the asymmetry: nothing this group sends carries a
  // project, whatever the invocation looked like.
  const listed = await w6w(["vars", "list"], () => json(200, { vars: [] }));
  assert(!listed.calls[0].url.includes("project"), listed.calls[0].url);
});

// ---------------------------------------------------------------------------
// The value encoding, on its own.
// ---------------------------------------------------------------------------

Deno.test("encodeValue: text in, the JSON the server type-checks out", () => {
  // With `--type string` the text IS the value — no parsing, however JSON-ish.
  assertEquals(encodeValue("hello", "string"), "hello");
  assertEquals(encodeValue("42", "string"), "42");
  assertEquals(encodeValue("null", "string"), "null");
  assertEquals(encodeValue('{"a":1}', "string"), '{"a":1}');

  // Otherwise: JSON if it parses as JSON, the text itself if it does not.
  assertEquals(encodeValue("42", "number"), 42);
  assertEquals(encodeValue("true", "boolean"), true);
  assertEquals(encodeValue("false", "boolean"), false);
  assertEquals(encodeValue('{"a":[1,2]}', "json"), { a: [1, 2] });
  assertEquals(encodeValue("null", undefined), null);
  assertEquals(encodeValue("forty-two", "number"), "forty-two");
  assertEquals(encodeValue("", undefined), "");
  // An unknown type is not rejected here either — `400 invalid_type` is the
  // server's answer, and a local copy of the enum would go stale.
  assertEquals(encodeValue("1", "duration"), 1);
});

// ---------------------------------------------------------------------------
// Failure.
// ---------------------------------------------------------------------------

Deno.test("an API error exits 2, and a bad invocation exits 1 without a request", async () => {
  const missing = await w6w(
    ["vars", "get", "var_nope"],
    () => json(404, { error: { code: "unknown_var", message: "no such variable" } }),
  );
  assertEquals(missing.code, 2);
  assertEquals(missing.stdout, "", "an error must never reach stdout");
  assertStringIncludes(missing.stderr, "no such variable");

  // A 2xx body missing the singular `var` key is `bad_response` (D3), which is
  // an API error too — distinct code, same exit.
  const malformed = await w6w(["vars", "get", "var_01HQ8N"], () => json(200, { variable: VAR }));
  assertEquals(malformed.code, 2);
  assertStringIncludes(malformed.stderr, `no "var" in the response body`);

  const cases: [string[], string][] = [
    [["vars", "get"], "needs a variable id"],
    [["vars", "get-by-name"], "needs a variable name"],
    [["vars", "create", "greeting"], "--type <t>"],
    [["vars", "create", "greeting", "--type", "string"], "--value <v>"],
    [["vars", "update"], "needs the variable id"],
    [["vars", "delete"], "needs the variable id"],
    [["vars", "list", "stray"], "takes no arguments"],
  ];
  for (const [argv, expected] of cases) {
    const result = await w6w(argv);
    assertEquals(result.code, 1, `\`${argv.join(" ")}\` exited ${result.code}`);
    assertStringIncludes(result.stderr, expected);
    assertEquals(result.calls.length, 0, "a usage error must not reach the server");
  }
});

// ---------------------------------------------------------------------------
// Registration.
// ---------------------------------------------------------------------------

Deno.test("every `w6w vars` command in the help tree is registered, and no others", () => {
  const group = HELP_TREE.groups.find((candidate) => candidate.name === "vars");
  assert(group !== undefined, "the generated help tree has no `vars` group");
  const documented = group.commands.map((command) => command.path.join(" ")).sort();
  assertEquals(Object.keys(VAR_COMMANDS).sort(), documented);
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

Deno.test("a refused --project is exit 1 in the real process, both spellings", async () => {
  const binary = pathOf(new URL("../bin/w6w.ts", import.meta.url));
  const spawn = async (args: string[]) => {
    const command = new Deno.Command(Deno.execPath(), {
      args: ["run", "--allow-env", binary, ...args],
      cwd: pathOf(new URL("../", import.meta.url)),
      // Cleared: a `W6W_TOKEN` exported in a developer's shell would otherwise
      // let one of these reach a network, and the point is that neither does.
      env: {},
      clearEnv: true,
      stdout: "piped",
      stderr: "piped",
    });
    const result = await command.output();
    const decoder = new TextDecoder();
    return {
      code: result.code,
      stdout: decoder.decode(result.stdout),
      stderr: decoder.decode(result.stderr),
    };
  };

  const parsed = await spawn(["vars", "list", "--project", "prj_1"]);
  assertEquals(parsed.code, 1, parsed.stderr);
  assertStringIncludes(parsed.stderr, "--project");
  assertEquals(parsed.stdout, "", "help for a bad invocation must not go to stdout");

  const escaped = await spawn(["vars", "list", "--", "--project", "prj_1"]);
  assertEquals(escaped.code, 1, escaped.stderr);
  assertStringIncludes(escaped.stderr, "variables are not project-scoped");
  assertEquals(escaped.stdout, "");
});
