/**
 * `@w6w/cli` — the package barrel and the CLI's programmatic entry point.
 *
 * {@linkcode main} is the whole command line, minus the host: it is handed an
 * argument vector and somewhere to write, and it returns an exit code. It never
 * reads the real command line and never ends the process — `bin/w6w.ts` does
 * both, through `src/runtime.ts`. That split is what lets the entire surface,
 * exit codes included, be exercised in-process by the test suite, against an
 * injected environment and an injected transport, with no live server anywhere.
 *
 * {@linkcode runCli} is its synchronous half: help, `--version` and usage
 * errors, which by contract resolve with no token configured and no server
 * reachable. Running a command needs the API and therefore needs `await`, so it
 * lives on `main` alone.
 *
 * The exit codes are the shared surface contract's, generated into
 * `src/help.generated.ts` rather than restated here:
 *
 * | code | meaning |
 * |---|---|
 * | 0 | success, including help and a queued/running workflow |
 * | 1 | usage error |
 * | 2 | API error (4xx/5xx, including auth failure) |
 * | 3 | run failure (`--wait` returned status `failed`) |
 *
 * @module
 */

import { GLOBAL_FLAG_SPECS, parse } from "./src/args.ts";
import type { FlagSpec, Invocation } from "./src/args.ts";
import { createClient, NO_ENV } from "./src/client.ts";
import type { EnvReader } from "./src/client.ts";
import { createOutput } from "./src/output.ts";
import type { Output } from "./src/output.ts";
import { EXIT_SUCCESS, EXIT_USAGE, exitCodeFor } from "./src/exit.ts";
import {
  renderCommandHelp,
  renderGroupHelp,
  renderHelp,
  renderRootHelp,
  resolve,
} from "./src/help.ts";
import { HELP_TREE } from "./src/help.generated.ts";
import type { HelpCommand } from "./src/help.generated.ts";
import type { CliIo } from "./src/runtime.ts";
import type { FetchLike, W6wClient } from "@w6w/sdk";

export { parse } from "./src/args.ts";
export type { FlagSpec, GlobalOptions, Invocation, ParseOptions, ParseResult } from "./src/args.ts";
export { createClient, ENV_BASE_URL, ENV_TOKEN, envValue, NO_ENV } from "./src/client.ts";
export type { ClientOptions, EnvReader } from "./src/client.ts";
export { createOutput, ENV_NO_COLOR, useColor } from "./src/output.ts";
export type { Output, OutputOptions, Styles } from "./src/output.ts";
export {
  EXIT_API_ERROR,
  EXIT_RUN_FAILURE,
  EXIT_SUCCESS,
  EXIT_USAGE,
  exitCodeFor,
} from "./src/exit.ts";
export {
  renderCommandHelp,
  renderGroupHelp,
  renderHelp,
  renderRootHelp,
  resolve,
} from "./src/help.ts";
export type { Resolution } from "./src/help.ts";
export { systemRuntime } from "./src/runtime.ts";
export type { CliIo, CliRuntime } from "./src/runtime.ts";
// The four exit codes are re-exported from `src/exit.ts` above, alongside the
// mapping that produces them — one import for anything to do with an exit code.
export { COMMAND_PATHS, EXIT_CODES, GLOBAL_FLAGS, HELP_TREE } from "./src/help.generated.ts";
export type {
  HelpCommand,
  HelpExitCode,
  HelpGlobalFlag,
  HelpGroup,
  HelpParam,
  HelpTree,
} from "./src/help.generated.ts";

/**
 * The published version of this package.
 *
 * The same string as `deno.json`'s and `package.json`'s `version` and the shared
 * `VERSION` file beside this repo — the single version all three w6w wrappers
 * publish under. `tests/help_test.ts` fails if any of those disagree, so it cannot
 * drift silently. `--version` prints exactly this.
 *
 * The explicit `: string` annotation is required, not decorative: JSR publishes
 * this file as TypeScript source and rejects inferred public types.
 */
export const VERSION: string = "0.2.0";

/** `w6w help <command>` is accepted as an alias for `w6w <command> --help`. */
const HELP_COMMAND = "help";

/**
 * What a command handler is handed: the invocation, somewhere to write, and a
 * way to reach the API.
 *
 * The client is a **function**, not a field, and that is the point: it is
 * constructed on first call and never before, so a command that answers without
 * the API — and every help path — needs no token and no reachable server.
 * Calling it twice returns the same client.
 */
export interface CommandContext {
  /** The command this invocation resolved to, straight out of the help tree. */
  readonly command: HelpCommand;
  /** The parsed command line: positional arguments, global flags, command flags. */
  readonly invocation: Invocation;
  /** The renderer. Every byte a command writes goes through it. */
  readonly out: Output;
  /**
   * The API client, built on first use from the global flags and the
   * environment.
   *
   * @throws {ConfigError} When the base URL or token is missing or unusable.
   */
  client(): W6wClient;
}

/**
 * One command's implementation.
 *
 * Return nothing for the ordinary success case; return a code only where the
 * exit-code contract has something to say that "it worked" does not — which is
 * `--wait` on a run that failed. Get it from {@linkcode exitCodeFor}; never
 * write the number.
 *
 * A handler does not catch its own API errors: {@linkcode main} maps a thrown
 * error to an exit code and reports it on stderr, once, for every command.
 */
export type CommandHandler = (context: CommandContext) => number | void | Promise<number | void>;

/**
 * The registry the dispatcher walks, keyed by canonical command path —
 * `"me"`, `"documents list"`. Aliases resolve to the canonical path before the
 * lookup, so `w6w info` finds `"me"`.
 */
export type CommandRegistry = Record<string, CommandHandler>;

/** Everything the CLI needs from its host, all of it injectable. */
export interface CliOptions {
  /** The environment seam. Defaults to an empty environment. */
  env?: EnvReader;
  /** Transport override, handed to the SDK. The test suite's seam. */
  fetch?: FetchLike;
  /** Whether stdout is a terminal, for the colour decision. Defaults to `false`. */
  isTty?: boolean;
  /** The commands that are wired up. Defaults to none. */
  commands?: CommandRegistry;
}

/** A command the router could not answer by itself, ready to dispatch. */
interface RunRoute {
  kind: "run";
  command: HelpCommand;
  invocation: Invocation;
}

/** Where routing landed: an answer already written, or a command to run. */
type Routed = { kind: "done"; code: number } | RunRoute;

/**
 * The flags a command declares for itself, lifted out of the generated help
 * tree so the parser and the help text cannot disagree about them.
 *
 * The flag's spelling is the first token of its help display (`--var
 * <key=value>` → `--var`, which is not always its contract parameter name), and
 * a display with nothing after that token is a boolean. Flags that shadow a
 * global one are dropped: `--json` is already parsed for every command.
 */
function commandFlagSpecs(command: HelpCommand): FlagSpec[] {
  const globals = new Set(GLOBAL_FLAG_SPECS.map((spec) => spec.name));
  const specs: FlagSpec[] = [];
  for (const param of command.params) {
    if (param.kind !== "flag") continue;
    const [name, ...rest] = param.display.split(" ");
    if (globals.has(name)) continue;
    specs.push({ name, alias: null, type: rest.length > 0 ? "string" : "boolean" });
  }
  return specs;
}

/**
 * Parses an argument vector, giving a resolved command's own flags a second
 * chance.
 *
 * The first pass knows only the global flags, because which command's flags
 * apply is not known until the command path has been read out of the same
 * argument vector. So `w6w documents list --project p_1` fails that pass on an
 * unknown flag — and the failure still carries the command the user was aiming
 * at, which is exactly what is needed to re-parse with that command's flags
 * added.
 *
 * **When the second pass fails too, its message is the one reported**, not the
 * first pass's. The second pass ran with strictly more flags known, so it got
 * further and its complaint is about the flag that is actually wrong; the first
 * pass's complaint is about the first flag it had not been told about yet, which
 * by then is usually a perfectly valid one. Reporting the first message names
 * the wrong flag: `w6w vars create g --type string --value hello --project p`
 * would answer `unknown flag: --type` — a flag that command declares and
 * requires — sending the user to fix the one thing that was right.
 */
function parseInvocation(argv: string[]) {
  const first = parse(argv);
  if (first.ok) return first;
  const resolution = resolve(first.command);
  if (resolution.kind !== "command") return first;
  const specs = commandFlagSpecs(resolution.command);
  if (specs.length === 0) return first;
  return parse(argv, { flags: specs });
}

/**
 * Answers everything that can be answered without the API, and reports
 * everything else as a command to run.
 *
 * Help and `--version` are answered here, before anything else: they must
 * resolve with **no token configured and no server reachable**, so nothing on
 * those paths constructs a client or performs I/O beyond writing to `io`.
 */
function route(argv: string[], io: CliIo): Routed {
  const done = (code: number): Routed => ({ kind: "done", code });
  const result = parseInvocation(argv);

  if (!result.ok) {
    io.stderr(`${HELP_TREE.binary}: ${result.message}`);
    io.stderr("");
    io.stderr(renderHelp(resolve(result.command)));
    return done(EXIT_USAGE);
  }

  const { command, positionals, globals } = result.invocation;

  // `w6w help <command>` — the same three levels, reached by the other spelling.
  if (command[0] === HELP_COMMAND) {
    const target = [...command.slice(1), ...positionals];
    const resolution = resolve(target);
    if (resolution.kind === "unknown") {
      io.stderr(`${HELP_TREE.binary}: unknown command: ${target.join(" ")}`);
      io.stderr("");
      io.stderr(renderHelp(resolution));
      return done(EXIT_USAGE);
    }
    io.stdout(renderHelp(resolution));
    return done(EXIT_SUCCESS);
  }

  if (globals.version) {
    io.stdout(VERSION);
    return done(EXIT_SUCCESS);
  }

  const resolution = resolve(command);

  switch (resolution.kind) {
    // A bare `w6w` prints root help and exits 0 — not an error, not a usage stub.
    case "root":
      io.stdout(renderRootHelp());
      return done(EXIT_SUCCESS);

    case "unknown":
      io.stderr(`${HELP_TREE.binary}: unknown command: ${command.join(" ")}`);
      io.stderr("");
      io.stderr(renderHelp(resolution));
      return done(EXIT_USAGE);

    // A group is never runnable. With --help that is a question, answered on
    // stdout; without it, it is an incomplete command, answered on stderr.
    case "group":
      if (globals.help) {
        io.stdout(renderGroupHelp(resolution.group));
        return done(EXIT_SUCCESS);
      }
      io.stderr(`${HELP_TREE.binary}: \`${resolution.group.name}\` needs a subcommand`);
      io.stderr("");
      io.stderr(renderGroupHelp(resolution.group));
      return done(EXIT_USAGE);

    case "command":
      if (globals.help) {
        io.stdout(renderCommandHelp(resolution.command));
        return done(EXIT_SUCCESS);
      }
      return { kind: "run", command: resolution.command, invocation: result.invocation };
  }
}

/**
 * Runs one command and turns whatever happens into an exit code.
 *
 * Every command's error handling is here rather than in the command: an error
 * is reported once, on stderr, and mapped once, through `src/exit.ts`. A
 * handler that wants a code other than success returns it; a handler that
 * throws gets the mapping for what it threw.
 */
async function dispatch(routed: RunRoute, io: CliIo, options: CliOptions): Promise<number> {
  const { globals } = routed.invocation;
  const out = createOutput(io, {
    json: globals.json,
    noColor: globals.noColor,
    isTty: options.isTty,
    env: options.env,
  });

  const key = routed.command.path.join(" ");
  const handler = options.commands?.[key];
  if (!handler) {
    out.error(
      `\`${key}\` is not available in this build. ` +
        `Try \`${HELP_TREE.binary} ${key} --help\`.`,
    );
    return EXIT_USAGE;
  }

  // Built on demand and remembered: a command that never asks for the API never
  // needs a token, and one that asks twice gets one client, not two.
  let client: W6wClient | null = null;
  const context: CommandContext = {
    command: routed.command,
    invocation: routed.invocation,
    out,
    client: () => {
      if (client === null) {
        client = createClient(globals, options.env ?? NO_ENV, { fetch: options.fetch });
      }
      return client;
    },
  };

  try {
    return (await handler(context)) ?? EXIT_SUCCESS;
  } catch (error) {
    // Normalised at the boundary rather than inside the mapping: `throw "boom"`
    // is legal JavaScript, and a mapping asked to classify a bare string has no
    // way to tell it from a returned payload — which would make a crash exit 0.
    const failure = error instanceof Error ? error : new Error(String(error));
    out.error(failure.message);
    return exitCodeFor(failure);
  }
}

/**
 * Runs a command line and returns its exit code. The whole CLI.
 *
 * @param argv - The argument vector, with the runtime's own prefix already dropped.
 * @param io - Where to write. Nothing else is written anywhere.
 * @param options - The environment, the transport, the terminal, the commands.
 * @returns The exit code, one of the four the contract declares.
 */
export async function main(argv: string[], io: CliIo, options: CliOptions = {}): Promise<number> {
  const routed = route(argv, io);
  if (routed.kind === "done") return routed.code;
  return await dispatch(routed, io, options);
}

/**
 * The synchronous half of the command line: help, `--version`, and usage errors.
 *
 * Kept because those are exactly the paths that must work with **no token
 * configured and no server reachable**, and a function that cannot reach the API
 * is the strongest possible statement of that. A runnable command is not run
 * here — running one is asynchronous by nature — and comes back as a usage error
 * pointing at its help. Use {@linkcode main}, which is what the binary calls.
 */
export function runCli(argv: string[], io: CliIo): number {
  const routed = route(argv, io);
  if (routed.kind === "done") return routed.code;
  const path = routed.command.path.join(" ");
  io.stderr(
    `${HELP_TREE.binary}: \`${path}\` needs the API, which this entry point does not reach. ` +
      `Try \`${HELP_TREE.binary} ${path} --help\`.`,
  );
  return EXIT_USAGE;
}
