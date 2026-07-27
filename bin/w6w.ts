#!/usr/bin/env -S deno run -A
/**
 * The `w6w` binary.
 *
 * The only module that touches the real command line and the real process exit,
 * and it does both through `src/runtime.ts` — so the entire CLI above it stays a
 * pure function of `(argv, io)` and can be tested in-process.
 *
 * Under Deno this file runs directly — `deno run -A bin/w6w.ts …`, or through the
 * shebang above. For npm it is compiled to `dist/bin/w6w.js`, which is what
 * `package.json`'s `bin` entry points at.
 *
 * Help and `--version` need no permissions beyond writing to stdout, which is why
 * `deno run --allow-read --allow-env bin/w6w.ts --help` works with no token set
 * and no server reachable.
 */

import { runCli } from "../mod.ts";
import { systemRuntime } from "../src/runtime.ts";

const runtime = systemRuntime();
runtime.exit(runCli(runtime.args, runtime));
