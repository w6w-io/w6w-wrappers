/**
 * The exit-code contract, asserted on **real process exit statuses**.
 *
 * A CLI's exit code is the only part of its answer a script reads, and it is the
 * part no in-process assertion can vouch for: a mapping function that returns
 * the right number and a host that ends the process with the wrong one look
 * identical from inside. So the table below spawns the CLI — through the same
 * `main()` and the same `systemRuntime().exit()` the binary uses, with a fake
 * server behind it (`fixtures/exit_probe.ts`) — and reads `$?`.
 *
 * | code | meaning | the trap |
 * |---|---|---|
 * | 0 | success | a *queued* run is one, even though the workflow has not finished |
 * | 1 | usage error | a configuration failure is one; nothing reached the server |
 * | 2 | API error | any status, including a rejected token and an unreachable host |
 * | 3 | run failure | a run that came back `failed` — **not** an API error |
 *
 * The last row is the one that has to be got right: a failed workflow and an
 * unreachable server demand opposite responses, and a script that cannot tell
 * them apart will retry the wrong one. It is also the one that must **not**
 * raise anywhere below the CLI — the probe prints the answer before mapping it,
 * so an implementation that raised would never produce that line.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { ApiError, ConfigError } from "@w6w/sdk";
import {
  EXIT_API_ERROR,
  EXIT_CODES,
  EXIT_RUN_FAILURE,
  EXIT_SUCCESS,
  EXIT_USAGE,
  exitCodeFor,
} from "../mod.ts";

/** A file URL as a filesystem path — `@std/path`'s `fromFileUrl`, without the import. */
function pathOf(url: URL): string {
  const path = decodeURIComponent(url.pathname);
  return /^\/[A-Za-z]:\//.test(path) ? path.slice(1) : path;
}

const PACKAGE_DIR = pathOf(new URL("../", import.meta.url));
const PROBE = pathOf(new URL("./fixtures/exit_probe.ts", import.meta.url));
const BINARY = pathOf(new URL("../bin/w6w.ts", import.meta.url));
const EXIT_SOURCE = new URL("../src/exit.ts", import.meta.url);

/** A configured server that answers whatever the scenario says. */
const CONFIGURED = { W6W_BASE_URL: "https://api.example.test", W6W_TOKEN: "t_probe" };

interface Ran {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Run a script in a child process and report what the shell would have seen.
 *
 * `clearEnv` is not tidiness: the environment is half of what this CLI resolves,
 * and a `W6W_TOKEN` that happened to be exported in the developer's shell would
 * make the unconfigured cases pass for the wrong reason.
 */
async function run(
  script: string,
  args: string[],
  env: Record<string, string> = {},
  permissions: string[] = ["--allow-env"],
): Promise<Ran> {
  const command = new Deno.Command(Deno.execPath(), {
    args: ["run", ...permissions, script, ...args],
    cwd: PACKAGE_DIR,
    env,
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
}

/** The CLI itself, as a user runs it. */
function w6w(args: string[], env: Record<string, string> = {}): Promise<Ran> {
  return run(BINARY, args, env);
}

/** The CLI with a fake server behind it. */
function probe(
  scenario: string,
  args: string[],
  env: Record<string, string> = CONFIGURED,
): Promise<Ran> {
  return run(PROBE, [scenario, ...args], env);
}

// ---------------------------------------------------------------------------
// 0 — success, including the paths that must work with nothing configured.
// ---------------------------------------------------------------------------

Deno.test("exit 0: help, --version and a bare invocation, with no configuration at all", async () => {
  for (const args of [["--help"], ["-h"], ["--version"], ["-v"], [], ["help", "documents"]]) {
    const result = await w6w(args);
    assertEquals(
      result.code,
      0,
      `\`w6w ${args.join(" ")}\` exited ${result.code}: ${result.stderr}`,
    );
    assert(result.stdout.length > 0, `\`w6w ${args.join(" ")}\` printed nothing`);
    assertEquals(result.stderr, "");
  }
});

Deno.test("exit 0: help and --version need no permissions and no environment", async () => {
  // The strongest statement of "help does no I/O": with zero Deno permissions
  // granted, any read, any environment access and any network call would abort
  // the process. A run that grants --allow-read cannot tell the difference.
  for (const args of [["--help"], ["--version"]]) {
    const result = await run(BINARY, args, {}, []);
    assertEquals(result.code, 0, `\`w6w ${args.join(" ")}\` needs permissions: ${result.stderr}`);
    assert(result.stdout.length > 0);
  }
});

Deno.test("exit 0: a command that succeeds", async () => {
  const result = await probe("ok", ["me"]);
  assertEquals(result.code, 0, result.stderr);
  assertStringIncludes(result.stdout, "answered:");
  assertEquals(result.stderr, "");
});

Deno.test("exit 0: a queued run is success, even though the workflow has not finished", async () => {
  // The trap. The server answers before the run does; the caller asked for it to
  // start, and it started. Anything but 0 here breaks every fire-and-forget job.
  const result = await probe("queued", ["workflows", "run", "wf_1"]);
  assertEquals(result.code, 0, result.stderr);
  assertStringIncludes(result.stdout, '"status":"queued"');

  // And with --wait, a run still going comes back the same way.
  const waited = await probe("queued", ["workflows", "run", "wf_1", "--wait"]);
  assertEquals(waited.code, 0, waited.stderr);
});

// ---------------------------------------------------------------------------
// 1 — usage errors, including every configuration failure.
// ---------------------------------------------------------------------------

Deno.test("exit 1: an unknown or incomplete command prints help to stderr", async () => {
  const unknown = await w6w(["nosuchcommand"]);
  assertEquals(unknown.code, 1);
  assertEquals(unknown.stdout, "", "help for a bad invocation must not go to stdout");
  assertStringIncludes(unknown.stderr, "unknown command: nosuchcommand");
  assertStringIncludes(unknown.stderr, "w6w — command-line client");

  const incomplete = await w6w(["documents"]);
  assertEquals(incomplete.code, 1);
  assertEquals(incomplete.stdout, "");
  assertStringIncludes(incomplete.stderr, "needs a subcommand");

  const badFlag = await w6w(["documents", "list", "--bogus"]);
  assertEquals(badFlag.code, 1);
  assertStringIncludes(badFlag.stderr, "unknown flag: --bogus");
});

Deno.test("exit 1: no usable base URL — a configuration failure, not an API failure", async () => {
  // The split that must not collapse: nothing reached the server here, so this
  // cannot be a 2. The message names both sources because either one would fix it.
  const unconfigured: Record<string, string>[] = [
    { W6W_TOKEN: "t_probe" },
    { W6W_BASE_URL: "", W6W_TOKEN: "t_probe" },
    { W6W_BASE_URL: "   ", W6W_TOKEN: "t_probe" },
  ];
  for (const env of unconfigured) {
    const result = await probe("ok", ["me"], env);
    assertEquals(result.code, 1, result.stderr);
    assertStringIncludes(result.stderr, "--base-url");
    assertStringIncludes(result.stderr, "W6W_BASE_URL");
    assert(!result.stdout.includes("answered:"), "a request was made without a base URL");
  }
});

Deno.test("exit 1: a base URL that is not absolute, and a token that cannot be sent", async () => {
  const relative = await probe("ok", ["me"], { W6W_BASE_URL: "/api", W6W_TOKEN: "t_probe" });
  assertEquals(relative.code, 1, relative.stderr);
  assertStringIncludes(relative.stderr, "--base-url");
  assert(!relative.stdout.includes("answered:"));

  // `\x00` is missing from this list because a NUL cannot be put into a child
  // process's environment at all — the operating system refuses it before the
  // CLI is reached. It is covered in-process, in `tests/client_flags_test.ts`.
  for (const token of ["t_probe\r", "t_probe\n", "t_probe\t"]) {
    const result = await probe("ok", ["me"], { ...CONFIGURED, W6W_TOKEN: token });
    assertEquals(result.code, 1, `${JSON.stringify(token)} exited ${result.code}`);
    assertStringIncludes(result.stderr, "--token");
    assertStringIncludes(result.stderr, "W6W_TOKEN");
    // Not a stack trace: a message about the token, on stderr, and no request.
    assert(!result.stderr.includes("TypeError"), result.stderr);
    assert(!result.stdout.includes("answered:"));
  }
});

// ---------------------------------------------------------------------------
// 2 — the server was reached and answered with a failure.
// ---------------------------------------------------------------------------

Deno.test("exit 2: every API failure, including auth and an unreachable host", async () => {
  const cases: [string, string][] = [
    ["unauthorized", "token rejected"],
    ["missing", "no such workflow"],
    ["upstream", "vendor said no"],
    ["broken", "it broke"],
    ["proxy", "502"],
    ["unreachable", "connection refused"],
  ];
  for (const [scenario, expected] of cases) {
    const result = await probe(scenario, ["me"]);
    assertEquals(result.code, 2, `\`${scenario}\` exited ${result.code}: ${result.stderr}`);
    assertStringIncludes(result.stderr, expected);
    assertEquals(result.stdout, "", "an error must never reach stdout");
  }
});

// ---------------------------------------------------------------------------
// 3 — the run itself failed. Data, not an error.
// ---------------------------------------------------------------------------

Deno.test("exit 3: --wait on a run that came back failed — and nothing raised", async () => {
  const result = await probe("failed", ["workflows", "run", "wf_1", "--wait"]);
  assertEquals(
    result.code,
    3,
    `expected the run-failure code, got ${result.code}: ${result.stderr}`,
  );
  // Printed *before* the mapping: an implementation that raised on a failed run
  // would never get here, so this line is the "did not raise" assertion.
  assertStringIncludes(result.stdout, "answered:");
  assertStringIncludes(result.stdout, '"status":"failed"');
  assertEquals(result.stderr, "");

  // Without --wait the same body would be a handle, not a verdict — the code is
  // about what the user asked to know, and it is never confused with an API error.
  const api = await probe("broken", ["workflows", "run", "wf_1", "--wait"]);
  assertEquals(api.code, 2);
});

// ---------------------------------------------------------------------------
// The mapping itself.
// ---------------------------------------------------------------------------

Deno.test("exitCodeFor maps each outcome to its contractual code", () => {
  assertEquals(exitCodeFor(undefined), EXIT_SUCCESS);
  assertEquals(exitCodeFor(null), EXIT_SUCCESS);
  assertEquals(exitCodeFor({ id: "doc_1" }), EXIT_SUCCESS);
  assertEquals(exitCodeFor([{ id: "doc_1" }]), EXIT_SUCCESS);
  assertEquals(exitCodeFor("done"), EXIT_SUCCESS);
  assertEquals(exitCodeFor({ runId: "run_1", status: "queued" }), EXIT_SUCCESS);
  assertEquals(exitCodeFor({ runId: "run_1", status: "running" }), EXIT_SUCCESS);
  assertEquals(exitCodeFor({ runId: "run_1", status: "succeeded" }), EXIT_SUCCESS);

  assertEquals(exitCodeFor(new ConfigError("no base URL")), EXIT_USAGE);
  assertEquals(exitCodeFor(new Error("a bug")), EXIT_USAGE);
  assertEquals(exitCodeFor(new TypeError("also a bug")), EXIT_USAGE);

  for (const status of [0, 400, 401, 404, 409, 424, 500, 502]) {
    assertEquals(exitCodeFor(new ApiError(status, "code", "message")), EXIT_API_ERROR);
  }

  assertEquals(exitCodeFor({ runId: "run_1", status: "failed" }), EXIT_RUN_FAILURE);
});

Deno.test("an ApiError from a second copy of the SDK is still an API error", () => {
  // An installed CLI resolves `@w6w/sdk` through a package manager, and a host
  // with two copies of it on disk raises an error that fails `instanceof`
  // against this one. Falling back to the name keeps a server failure out of the
  // usage bucket — where a script would read it as "my command line was wrong".
  const foreign = new Error("token rejected");
  foreign.name = "ApiError";
  assertEquals(exitCodeFor(foreign), EXIT_API_ERROR);
});

Deno.test("the four codes are the contract's, and there are no others", async () => {
  assertEquals(
    EXIT_CODES.map((entry) => entry.code),
    [EXIT_SUCCESS, EXIT_USAGE, EXIT_API_ERROR, EXIT_RUN_FAILURE],
  );
  assertEquals([EXIT_SUCCESS, EXIT_USAGE, EXIT_API_ERROR, EXIT_RUN_FAILURE], [0, 1, 2, 3]);

  // And the mapper contains no other number at all. A whole-file scan rather
  // than an inspection of the returned values: a fifth code added later would be
  // returned by a branch no existing test calls, and would be invisible here.
  const source = await Deno.readTextFile(EXIT_SOURCE);
  const literals = new Set(source.match(/\b\d+\b/g) ?? []);
  assertEquals(
    [...literals].filter((literal) => !["0", "1", "2", "3"].includes(literal)),
    [],
    "src/exit.ts mentions a number that is not one of the four contractual codes",
  );
  for (const code of ["0", "1", "2", "3"]) {
    assert(literals.has(code), `src/exit.ts never mentions the code ${code}`);
  }
});
