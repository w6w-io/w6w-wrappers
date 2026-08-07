/**
 * The help surface's contract.
 *
 * Three things are pinned here, in rising order of how expensive they are to get
 * wrong:
 *
 *  1. **Shape** — root help lists every group, group help lists its commands,
 *     command help names its parameters, and `w6w info` resolves to `me`.
 *  2. **Behaviour** — help and `--version` resolve with no token configured and no
 *     server reachable, and exit 0; a bare invocation prints root help; an unknown
 *     or incomplete command prints the relevant help to stderr and exits 1. Every
 *     case runs `runCli()` in-process against a recording writer, so "did not
 *     touch the network" is a property of the code path, not of a mock.
 *  3. **Freshness** — the checked-in generated module is compared **byte for byte**
 *     against a fresh render of the shared contract. A contract change that was
 *     not regenerated fails here rather than shipping stale help.
 *
 * Every path is resolved from this file's own location, never from the process
 * working directory, so the suite behaves the same however it is invoked.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { runCli, VERSION } from "../mod.ts";
import { HELP_TREE } from "../src/help.generated.ts";
import { renderCommandHelp, renderGroupHelp, renderRootHelp, resolve } from "../src/help.ts";
import {
  commandPathOf,
  formatModule,
  GENERATED_URL,
  loadContract,
  renderHelpModule,
} from "../scripts/gen-help.ts";
import type { Contract } from "../scripts/gen-help.ts";

const denoJsonUrl = new URL("../deno.json", import.meta.url);
const packageJsonUrl = new URL("../package.json", import.meta.url);
/** The shared version file, beside this repo among its two sibling wrapper repos. */
const sharedVersionUrl = new URL("../../VERSION", import.meta.url);

/** Records what a run wrote, so exit codes and streams can both be asserted. */
function recorder() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: { stdout: (text: string) => out.push(text), stderr: (text: string) => err.push(text) },
    get stdout(): string {
      return out.join("\n");
    },
    get stderr(): string {
      return err.join("\n");
    },
  };
}

function run(argv: string[]): { code: number; stdout: string; stderr: string } {
  const io = recorder();
  const code = runCli(argv, io.io);
  return { code, stdout: io.stdout, stderr: io.stderr };
}

async function readManifestVersion(url: URL): Promise<string> {
  const parsed = JSON.parse(await Deno.readTextFile(url)) as { version?: unknown };
  if (typeof parsed.version !== "string") {
    throw new Error(`${url.pathname} has no string "version" field`);
  }
  return parsed.version;
}

// ---------------------------------------------------------------------------
// Shape — the three levels really came from the contract.
// ---------------------------------------------------------------------------

Deno.test("root help lists every command group the contract declares", async () => {
  const contract = await loadContract();
  const help = renderRootHelp();
  const expected = new Set(
    contract.operations
      .map((operation) => commandPathOf(operation.naming.cli))
      .filter((path) => path.length === 2)
      .map((path) => path[0]),
  );
  assert(expected.size > 0, "the contract declares no grouped commands at all");
  for (const group of expected) {
    assertStringIncludes(help, `\n  ${group.padEnd(2)}`);
    assert(
      HELP_TREE.groups.some((candidate) => candidate.name === group),
      `command group \`${group}\` is missing from the generated tree`,
    );
  }
  // The two commands that sit at the root are listed alongside the groups.
  for (const command of HELP_TREE.commands) assertStringIncludes(help, `\n  ${command.name} `);
  // And the global flags, with their environment variables.
  assertStringIncludes(help, "--base-url <url>");
  assertStringIncludes(help, "(env: W6W_BASE_URL)");
  assertStringIncludes(help, "(env: W6W_TOKEN)");
  assertStringIncludes(help, "-v, --version");
});

Deno.test("group help lists that group's commands, and only those", async () => {
  const contract = await loadContract();
  for (const group of HELP_TREE.groups) {
    const help = renderGroupHelp(group);
    assertStringIncludes(help, `w6w ${group.name} — `);
    const expected = contract.operations
      .map((operation) => commandPathOf(operation.naming.cli))
      .filter((path) => path.length === 2 && path[0] === group.name)
      .map((path) => path[1]);
    assertEquals(group.commands.map((command) => command.name), expected);
    for (const name of expected) assertStringIncludes(help, `\n  ${name} `);
  }
  // The documents/vars asymmetry is real and the help says so rather than
  // papering over it with a flag the server ignores.
  const documents = HELP_TREE.groups.find((group) => group.name === "documents");
  const vars = HELP_TREE.groups.find((group) => group.name === "vars");
  assert(documents && vars);
  assertStringIncludes(renderGroupHelp(documents), "--project <id>");
  assert(!renderGroupHelp(vars).includes("--project"));
});

Deno.test("command help names every parameter the contract gives the command", async () => {
  const contract = await loadContract();
  for (const operation of contract.operations) {
    const path = commandPathOf(operation.naming.cli);
    const resolution = resolve(path);
    assertEquals(
      resolution.kind,
      "command",
      `\`w6w ${path.join(" ")}\` (operation \`${operation.name}\`) does not resolve to a command`,
    );
    if (resolution.kind !== "command") continue;
    const help = renderCommandHelp(resolution.command);
    for (const param of operation.params) {
      const entry = resolution.command.params.find((candidate) => candidate.name === param.name);
      assert(
        entry,
        `parameter \`${param.name}\` of \`${operation.name}\` is missing from its help`,
      );
      assertStringIncludes(help, entry.display);
      assert(entry.description.length > 0, `parameter \`${param.name}\` has no description`);
    }
    // Every command's help carries at least one runnable example.
    assertStringIncludes(help, "EXAMPLES");
    assert(resolution.command.examples.length > 0);
  }
});

Deno.test("root help lists the short command aliases", () => {
  const help = renderRootHelp();
  assertStringIncludes(help, "ALIASES");
  assertStringIncludes(help, "conn");
  assertStringIncludes(help, "same as `connections`");
  assertStringIncludes(help, "wf");
  assertStringIncludes(help, "same as `workflows`");
  assertStringIncludes(help, "docs");
  assertStringIncludes(help, "same as `documents`");
  assertStringIncludes(help, "ls");
  assertStringIncludes(help, "same as `list`, inside any group");
});

Deno.test("`w6w info` resolves to the `me` command", () => {
  const alias = resolve(["info"]);
  const canonical = resolve(["me"]);
  assert(alias.kind === "command" && canonical.kind === "command");
  assertEquals(alias.command.operation, "me");
  assertEquals(alias.command, canonical.command);
  // One command, one line: the alias is not a second COMMANDS entry.
  const rootHelp = renderRootHelp();
  assertEquals(rootHelp.split("\n").filter((line) => line.startsWith("  info ")).length, 0);
  assertStringIncludes(renderCommandHelp(alias.command), "w6w info");
});

// ---------------------------------------------------------------------------
// Behaviour — exit codes, streams, and the offline guarantee.
// ---------------------------------------------------------------------------

Deno.test("--help, -h and `help <command>` all resolve to stdout with exit 0", () => {
  for (const argv of [["--help"], ["-h"], ["help"]]) {
    const result = run(argv);
    assertEquals(result.code, 0, `\`w6w ${argv.join(" ")}\` should exit 0`);
    assertStringIncludes(result.stdout, "w6w — command-line client");
    assertEquals(result.stderr, "");
  }
  for (
    const argv of [
      ["documents", "--help"],
      ["help", "documents"],
      ["documents", "get", "--help"],
      ["help", "documents", "get"],
      ["workflows", "run", "-h"],
      ["info", "--help"],
    ]
  ) {
    const result = run(argv);
    assertEquals(result.code, 0, `\`w6w ${argv.join(" ")}\` should exit 0`);
    assert(result.stdout.length > 0, `\`w6w ${argv.join(" ")}\` printed nothing`);
    assertEquals(result.stderr, "");
  }
  assertStringIncludes(run(["help", "documents", "get"]).stdout, "w6w documents get — ");
  assertStringIncludes(run(["workflows", "run", "-h"]).stdout, "<id>");
});

Deno.test("a bare invocation prints root help on stdout and exits 0", () => {
  const result = run([]);
  assertEquals(result.code, 0);
  assertEquals(result.stdout, renderRootHelp());
  assertEquals(result.stderr, "");
});

Deno.test("--version prints the manifest version and exits 0", () => {
  for (const argv of [["--version"], ["-v"]]) {
    const result = run(argv);
    assertEquals(result.code, 0);
    assertEquals(result.stdout, VERSION);
    assertEquals(result.stderr, "");
  }
});

Deno.test("an unknown or incomplete command prints help to stderr and exits 1", () => {
  const unknown = run(["nosuchcommand"]);
  assertEquals(unknown.code, 1);
  assertEquals(unknown.stdout, "");
  assertStringIncludes(unknown.stderr, "unknown command: nosuchcommand");
  assertStringIncludes(unknown.stderr, "w6w — command-line client");

  // An unknown subcommand lands on its group's help, not on root help.
  const unknownSub = run(["documents", "frobnicate"]);
  assertEquals(unknownSub.code, 1);
  assertEquals(unknownSub.stdout, "");
  assertStringIncludes(unknownSub.stderr, "w6w documents — ");

  // A group is never runnable.
  const incomplete = run(["documents"]);
  assertEquals(incomplete.code, 1);
  assertEquals(incomplete.stdout, "");
  assertStringIncludes(incomplete.stderr, "needs a subcommand");
  assertStringIncludes(incomplete.stderr, "get-by-key");

  // A bad flag is a usage error too, and lands on the command's own help.
  const badFlag = run(["documents", "list", "--bogus"]);
  assertEquals(badFlag.code, 1);
  assertEquals(badFlag.stdout, "");
  assertStringIncludes(badFlag.stderr, "unknown flag: --bogus");
  assertStringIncludes(badFlag.stderr, "w6w documents list — ");

  // `help` for something that does not exist is also a usage error.
  const badHelp = run(["help", "nosuchcommand"]);
  assertEquals(badHelp.code, 1);
  assertStringIncludes(badHelp.stderr, "unknown command: nosuchcommand");
});

Deno.test("help never depends on a token, a base URL or a reachable server", () => {
  // `runCli` is handed nothing but an argv and a writer: there is no seam through
  // which a token or a server could be reached, and nothing on the help path
  // constructs a client. Exercising every level with a recording writer proves
  // the path completes with no environment and no I/O of any kind.
  const paths: string[][] = [[], ["--help"]];
  for (const command of HELP_TREE.commands) paths.push([...command.path, "--help"]);
  for (const group of HELP_TREE.groups) {
    paths.push([group.name, "--help"]);
    for (const command of group.commands) paths.push([...command.path, "--help"]);
  }
  for (const argv of paths) {
    const result = run(argv);
    assertEquals(result.code, 0, `\`w6w ${argv.join(" ")}\` should exit 0 offline`);
    assert(result.stdout.length > 0);
  }
});

// ---------------------------------------------------------------------------
// Freshness and version lockstep.
// ---------------------------------------------------------------------------

Deno.test("the checked-in generated help is byte-identical to a fresh render", async () => {
  const contract: Contract = await loadContract();
  const fresh = await formatModule(renderHelpModule(contract));
  const committed = await Deno.readTextFile(GENERATED_URL);
  assertEquals(
    committed,
    fresh,
    "src/help.generated.ts is stale: the shared contract changed without a regeneration. " +
      "Run `deno task gen:help` and commit the result.",
  );
});

Deno.test("every contract operation reaches a registered command", async () => {
  const contract = await loadContract();
  const missing: string[] = [];
  for (const operation of contract.operations) {
    // `status` records server readiness, not wrapper obligation: `planned`
    // operations are asserted exactly like the rest.
    const resolution = resolve(commandPathOf(operation.naming.cli));
    if (resolution.kind !== "command" || resolution.command.operation !== operation.name) {
      missing.push(`${operation.name} — expected \`${operation.naming.cli}\``);
    }
  }
  assertEquals(missing, [], `operations not reachable as commands: ${missing.join("; ")}`);
});

Deno.test("the CLI version matches both manifests and the shared VERSION", async () => {
  assertEquals(VERSION, await readManifestVersion(denoJsonUrl));
  assertEquals(VERSION, await readManifestVersion(packageJsonUrl));
  let shared: string;
  try {
    shared = (await Deno.readTextFile(sharedVersionUrl)).trim();
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      // Fail loudly naming the path, and never fall back to a copy vendored in
      // this repo — a stale pinned copy defeats the whole mechanism.
      throw new Error(
        `lockstep: the shared version file was not found at ${sharedVersionUrl.pathname}. ` +
          "It is expected beside this repo — `../VERSION` from the repo root, where the three " +
          "wrapper repos sit as siblings — because all three publish at one version.",
      );
    }
    throw err;
  }
  assertEquals(VERSION, shared);
});
