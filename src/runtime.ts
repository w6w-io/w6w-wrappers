/**
 * The runtime adapter — the **only** module in this package that touches a host
 * runtime's globals.
 *
 * The CLI is authored as runtime-neutral TypeScript: it is developed and tested
 * with Deno and published to npm to run under Node, so `Deno.args`, `Deno.env`,
 * `Deno.exit`, `process.argv`, `process.env` and `process.exit` are confined to
 * this file. Everything else in `src/` uses Web-standard globals only, which is
 * what makes the parser and the help renderer testable in any runtime and
 * portable to both.
 *
 * Access is a **capability probe**, not a runtime assumption — the same shape
 * `docs/implementation.md` §2 pins for the SDK's env module — so this file
 * compiles under `tsc` for the npm build (where no Deno types exist) and runs
 * unchanged under Deno, Node and Bun.
 *
 * @module
 */

/** The bits of Deno this CLI uses. Structural, so no Deno types are required. */
interface DenoLike {
  args: string[];
  env: { get(name: string): string | undefined };
  exit(code: number): never;
}

/** The bits of Node's `process` this CLI uses. */
interface ProcessLike {
  argv: string[];
  env: Record<string, string | undefined>;
  exit(code: number): never;
}

interface HostGlobals {
  Deno?: DenoLike;
  process?: ProcessLike;
}

const host = globalThis as unknown as HostGlobals;

/** Somewhere for a command to write. Everything the CLI prints goes through this. */
export interface CliIo {
  /** Writes a line to standard output. */
  stdout(text: string): void;
  /** Writes a line to standard error. */
  stderr(text: string): void;
}

/** The full host surface the binary entry point needs. */
export interface CliRuntime extends CliIo {
  /** The command-line arguments, with the runtime's own prefix already dropped. */
  readonly args: string[];
  /** Reads an environment variable, or `undefined` where the host has no env. */
  env(name: string): string | undefined;
  /** Ends the process with the given exit code. */
  exit(code: number): never;
}

/** The real host runtime. Called once, by `bin/w6w.ts`. */
export function systemRuntime(): CliRuntime {
  return {
    args: readArgs(),
    env: readEnv,
    stdout: (text: string) => console.log(text),
    stderr: (text: string) => console.error(text),
    exit: exitProcess,
  };
}

function readArgs(): string[] {
  const deno = host.Deno;
  if (deno) return [...deno.args];
  const node = host.process;
  if (node) return node.argv.slice(2);
  return [];
}

function readEnv(name: string): string | undefined {
  const deno = host.Deno;
  if (deno) return deno.env.get(name) ?? undefined;
  const node = host.process;
  if (node) return node.env[name] ?? undefined;
  return undefined;
}

function exitProcess(code: number): never {
  const deno = host.Deno;
  if (deno) deno.exit(code);
  const node = host.process;
  if (node) node.exit(code);
  throw new Error(`w6w: no host runtime to exit from (wanted exit code ${code})`);
}
