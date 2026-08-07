/**
 * The argument parser's contract.
 *
 * `parse()` is a pure function, so every case here is an ordinary in-process call:
 * no subprocess, no environment, no server. That is the point of keeping the real
 * argv, env and exit in `src/runtime.ts` — the parsing rules can be pinned
 * exhaustively without spawning anything.
 */

import { assert, assertEquals } from "@std/assert";
import { GLOBAL_FLAG_SPECS, parse } from "../src/args.ts";
import type { Invocation } from "../src/args.ts";

/** Unwraps a parse that is expected to succeed, failing loudly when it does not. */
function ok(argv: string[]): Invocation {
  const result = parse(argv);
  if (!result.ok) {
    throw new Error(`expected a successful parse of ${argv.join(" ")}: ${result.message}`);
  }
  return result.invocation;
}

Deno.test("the six global flags come from the surface contract, with their aliases", () => {
  assertEquals(
    GLOBAL_FLAG_SPECS.map((spec) => spec.name).sort(),
    ["--base-url", "--help", "--json", "--no-color", "--token", "--version"],
  );
  const aliases = Object.fromEntries(GLOBAL_FLAG_SPECS.map((spec) => [spec.name, spec.alias]));
  assertEquals(aliases["--version"], "-v");
  assertEquals(aliases["--help"], "-h");
  assertEquals(aliases["--json"], null);
});

Deno.test("every global flag parses by its long name", () => {
  const parsed = ok([
    "--base-url",
    "https://api.example.com",
    "--token",
    "tok_123",
    "--json",
    "--no-color",
    "--version",
    "--help",
  ]);
  assertEquals(parsed.globals, {
    baseUrl: "https://api.example.com",
    token: "tok_123",
    json: true,
    noColor: true,
    version: true,
    help: true,
  });
});

Deno.test("the short aliases -v and -h parse to the same flags", () => {
  assertEquals(ok(["-v"]).globals.version, true);
  assertEquals(ok(["-h"]).globals.help, true);
  assertEquals(ok(["-h"]).globals.version, false);
});

Deno.test("a value flag accepts both `--flag=value` and `--flag value`", () => {
  assertEquals(ok(["--token=tok_123"]).globals.token, "tok_123");
  assertEquals(ok(["--token", "tok_123"]).globals.token, "tok_123");
  // An `=` inside the value survives — only the first `=` separates.
  assertEquals(
    ok(["--base-url=https://x.example.com/?a=b"]).globals.baseUrl,
    "https://x.example.com/?a=b",
  );
});

Deno.test("the command path is separated from the positional arguments", () => {
  const twoTokens = ok(["documents", "get", "doc_01HQ8N"]);
  assertEquals(twoTokens.command, ["documents", "get"]);
  assertEquals(twoTokens.positionals, ["doc_01HQ8N"]);

  // A root-level command takes its argument as a positional, not as a second
  // command token — which is the case a fixed depth would get wrong.
  const rootLevel = ok(["run", "conn_01HQ8N"]);
  assertEquals(rootLevel.command, ["run"]);
  assertEquals(rootLevel.positionals, ["conn_01HQ8N"]);

  // A group with no subcommand is a one-token command path, not a positional.
  assertEquals(ok(["documents"]).command, ["documents"]);
  assertEquals(ok(["documents"]).positionals, []);
});

Deno.test("flags may appear before, among and after the command path", () => {
  const parsed = ok([
    "--json",
    "documents",
    "--token",
    "tok_123",
    "get",
    "doc_01HQ8N",
    "--no-color",
  ]);
  assertEquals(parsed.command, ["documents", "get"]);
  assertEquals(parsed.positionals, ["doc_01HQ8N"]);
  assertEquals(parsed.globals.json, true);
  assertEquals(parsed.globals.noColor, true);
  assertEquals(parsed.globals.token, "tok_123");
});

Deno.test("`--` ends flag parsing", () => {
  const parsed = ok(["documents", "get", "--", "--not-a-flag"]);
  assertEquals(parsed.command, ["documents", "get"]);
  assertEquals(parsed.positionals, ["--not-a-flag"]);
});

Deno.test("an unknown flag is a usage error, not an exception", () => {
  const result = parse(["documents", "list", "--bogus"]);
  assert(!result.ok);
  assertEquals(result.message, "unknown flag: --bogus");
  // The command path travels with the error, so the caller can print the help
  // for the command the user was actually aiming at.
  assertEquals(result.command, ["documents", "list"]);

  const shortForm = parse(["-z"]);
  assert(!shortForm.ok);
  assertEquals(shortForm.message, "unknown flag: -z");
});

Deno.test("a missing value and a value on a boolean flag are usage errors", () => {
  const missing = parse(["--token"]);
  assert(!missing.ok);
  assertEquals(missing.message, "flag --token requires a value");

  const followedByFlag = parse(["--token", "--json"]);
  assert(!followedByFlag.ok);
  assertEquals(followedByFlag.message, "flag --token requires a value");

  const valued = parse(["--json=yes"]);
  assert(!valued.ok);
  assertEquals(valued.message, "flag --json takes no value");
});

Deno.test("an empty argv parses to no command at all — the caller prints root help", () => {
  const parsed = ok([]);
  assertEquals(parsed.command, []);
  assertEquals(parsed.positionals, []);
  assertEquals(parsed.globals, {
    baseUrl: undefined,
    token: undefined,
    json: false,
    noColor: false,
    version: false,
    help: false,
  });
});

// ---------------------------------------------------------------------------
// Short spellings — `conn`/`wf`/`docs` for a group, `ls` for `list`.
// ---------------------------------------------------------------------------

Deno.test("group aliases resolve to the same command path as the full spelling", () => {
  assertEquals(ok(["conn", "list"]).command, ["connections", "list"]);
  assertEquals(ok(["wf", "list"]).command, ["workflows", "list"]);
  assertEquals(ok(["docs", "list"]).command, ["documents", "list"]);
  // A bare group alias resolves to the same one-token group path too.
  assertEquals(ok(["conn"]).command, ["connections"]);
});

Deno.test("`ls` aliases `list` inside any group, alone or combined with a group alias", () => {
  assertEquals(ok(["documents", "ls"]).command, ["documents", "list"]);
  assertEquals(ok(["vars", "ls"]).command, ["vars", "list"]);
  assertEquals(ok(["conn", "ls"]).command, ["connections", "list"]);
  assertEquals(ok(["wf", "ls"]).command, ["workflows", "list"]);
  assertEquals(ok(["docs", "ls"]).command, ["documents", "list"]);
});

Deno.test("`ls` is left alone outside a group, where it is a positional, not a subcommand", () => {
  // `run` has no subcommands, so its argument is untouched by the `list` alias.
  const rootLevel = ok(["run", "ls"]);
  assertEquals(rootLevel.command, ["run"]);
  assertEquals(rootLevel.positionals, ["ls"]);

  // Only the subcommand slot (index 1) is a candidate — a document key of
  // `ls` at index 2 is never touched.
  const key = ok(["documents", "create", "ls"]);
  assertEquals(key.command, ["documents", "create"]);
  assertEquals(key.positionals, ["ls"]);
});

Deno.test("an alias-prefixed invocation that fails still resolves its command for the error message", () => {
  const result = parse(["conn", "list", "--bogus"]);
  assert(!result.ok);
  assertEquals(result.command, ["connections", "list"]);
});

Deno.test("command-specific flags can be added without touching the parser", () => {
  const parsed = parse(["workflows", "run", "wf_1", "--wait"], {
    flags: [{ name: "--wait", alias: null, type: "boolean" }],
  });
  assert(parsed.ok);
  assertEquals(parsed.invocation.command, ["workflows", "run"]);
  assertEquals(parsed.invocation.positionals, ["wf_1"]);
  assertEquals(parsed.invocation.options, { wait: true });
  // Global flags stay out of `options`, so a command never sees them twice.
  assertEquals(parsed.invocation.globals.json, false);

  // The same flag without the spec is still a usage error.
  const undeclared = parse(["workflows", "run", "wf_1", "--wait"]);
  assert(!undeclared.ok);
});
