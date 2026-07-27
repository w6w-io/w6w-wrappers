#!/usr/bin/env -S deno run -A
/**
 * The `w6w` binary.
 *
 * The only module that touches the real command line and the real process exit,
 * and it does both through `src/runtime.ts` — so the entire CLI above it stays a
 * pure function of `(argv, io, options)` and can be tested in-process.
 *
 * Its job is wiring, and only wiring: read the host's arguments and environment,
 * decide whether stdout is a terminal, hand the command registry to `main()`, and
 * exit with the code it returns. Nothing here decides anything a test cannot.
 *
 * Under Deno this file runs directly — `deno run -A bin/w6w.ts …`, or through the
 * shebang above. For npm it is compiled to `dist/bin/w6w.js`, which is what
 * `package.json`'s `bin` entry points at.
 *
 * Help and `--version` need no permissions beyond writing to stdout, which is why
 * `deno run --allow-read --allow-env bin/w6w.ts --help` works with no token set
 * and no server reachable: nothing on those paths constructs a client.
 */

import { main } from "../mod.ts";
import type { CommandRegistry } from "../mod.ts";
import { systemRuntime } from "../src/runtime.ts";

/**
 * The commands this build can run.
 *
 * Empty here on purpose: the entry point owns the wiring, and each command group
 * registers itself into this map as it is implemented. A command in the help tree
 * with no entry here answers with a usage error saying so, which is a better
 * answer than a silent success.
 */
const commands: CommandRegistry = {};

/**
 * Whether stdout is a terminal — the third of the three ways colour turns itself
 * off (the other two being `--no-color` and `NO_COLOR`).
 *
 * A capability probe rather than a runtime assumption, the same shape
 * `src/runtime.ts` uses, so this file compiles for the npm build (where no Deno
 * types exist) and runs unchanged under Deno, Node and Bun. Anything it cannot
 * establish counts as "not a terminal": a pipe is the case where colour actively
 * corrupts the output, so it is the safe default to assume.
 */
function stdoutIsTerminal(): boolean {
  const host = globalThis as unknown as {
    Deno?: { stdout?: { isTerminal?: () => boolean } };
    process?: { stdout?: { isTTY?: boolean } };
  };
  const deno = host.Deno?.stdout;
  if (deno?.isTerminal) return deno.isTerminal();
  return host.process?.stdout?.isTTY === true;
}

const runtime = systemRuntime();
const code = await main(runtime.args, runtime, {
  env: runtime.env,
  isTty: stdoutIsTerminal(),
  commands,
});
runtime.exit(code);
