/**
 * `@w6w/cli` — the package barrel and the CLI's programmatic entry point.
 *
 * `runCli()` is the whole command line, minus the host: it is handed an argument
 * vector and somewhere to write, and it returns an exit code. It never reads the
 * real command line and never ends the process — `bin/w6w.ts` does both, through
 * `src/runtime.ts`. That split is what lets the entire surface, exit codes
 * included, be exercised in-process by the test suite.
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

import { parse } from "./src/args.ts";
import {
  renderCommandHelp,
  renderGroupHelp,
  renderHelp,
  renderRootHelp,
  resolve,
} from "./src/help.ts";
import { EXIT_SUCCESS, EXIT_USAGE, HELP_TREE } from "./src/help.generated.ts";
import type { CliIo } from "./src/runtime.ts";

export { parse } from "./src/args.ts";
export type { FlagSpec, GlobalOptions, Invocation, ParseOptions, ParseResult } from "./src/args.ts";
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
export {
  COMMAND_PATHS,
  EXIT_API_ERROR,
  EXIT_CODES,
  EXIT_RUN_FAILURE,
  EXIT_SUCCESS,
  EXIT_USAGE,
  GLOBAL_FLAGS,
  HELP_TREE,
} from "./src/help.generated.ts";
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
export const VERSION: string = "0.1.0";

/** `w6w help <command>` is accepted as an alias for `w6w <command> --help`. */
const HELP_COMMAND = "help";

/**
 * Runs a command line and returns its exit code.
 *
 * Help and `--version` are answered here, before anything else: they must resolve
 * with **no token configured and no server reachable**, so nothing on those paths
 * constructs a client or performs I/O beyond writing to `io`. The command
 * handlers that do reach the API are attached in later changes; until then a
 * resolved command says so plainly rather than pretending to succeed.
 */
export function runCli(argv: string[], io: CliIo): number {
  const result = parse(argv);

  if (!result.ok) {
    io.stderr(`${HELP_TREE.binary}: ${result.message}`);
    io.stderr("");
    io.stderr(renderHelp(resolve(result.command)));
    return EXIT_USAGE;
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
      return EXIT_USAGE;
    }
    io.stdout(renderHelp(resolution));
    return EXIT_SUCCESS;
  }

  if (globals.version) {
    io.stdout(VERSION);
    return EXIT_SUCCESS;
  }

  const resolution = resolve(command);

  switch (resolution.kind) {
    // A bare `w6w` prints root help and exits 0 — not an error, not a usage stub.
    case "root":
      io.stdout(renderRootHelp());
      return EXIT_SUCCESS;

    case "unknown":
      io.stderr(`${HELP_TREE.binary}: unknown command: ${command.join(" ")}`);
      io.stderr("");
      io.stderr(renderHelp(resolution));
      return EXIT_USAGE;

    // A group is never runnable. With --help that is a question, answered on
    // stdout; without it, it is an incomplete command, answered on stderr.
    case "group":
      if (globals.help) {
        io.stdout(renderGroupHelp(resolution.group));
        return EXIT_SUCCESS;
      }
      io.stderr(`${HELP_TREE.binary}: \`${resolution.group.name}\` needs a subcommand`);
      io.stderr("");
      io.stderr(renderGroupHelp(resolution.group));
      return EXIT_USAGE;

    case "command": {
      if (globals.help) {
        io.stdout(renderCommandHelp(resolution.command));
        return EXIT_SUCCESS;
      }
      // TODO(T2.2.2–T2.2.5): attach the SDK client and the command handlers.
      // Until they land there is nothing to run, and saying so is better than a
      // silent 0.
      const path = resolution.command.path.join(" ");
      io.stderr(
        `${HELP_TREE.binary}: \`${path}\` is not wired to the API in this build yet. ` +
          `Try \`${HELP_TREE.binary} ${path} --help\`.`,
      );
      return EXIT_USAGE;
    }
  }
}
