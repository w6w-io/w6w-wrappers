/**
 * The argument parser.
 *
 * There is no CLI framework anywhere in this workspace, and this package takes no
 * runtime dependency to get one. `parse()` is a **pure function**: it is handed an
 * argument vector and returns a structured result. It never reads the real
 * command line, never reads the environment, never writes output and never exits
 * — that is `src/runtime.ts`'s job, and keeping the two apart is what makes every
 * invocation in this file testable in-process, in any runtime.
 *
 * It also never throws on bad input. A wrong invocation is an ordinary outcome
 * for a CLI, so a usage error comes back as a value (`{ ok: false }`) carrying the
 * command path the user was aiming at, which is how the caller knows *which* help
 * to print (root, group or command) before exiting 1.
 *
 * Flag names, aliases and the set of valid command paths all come from the
 * generated module rather than being restated here, so the parser cannot drift
 * from the surface contract the help text is built from.
 *
 * @module
 */

import { COMMAND_PATHS, GLOBAL_FLAGS } from "./help.generated.ts";

/** A flag the parser will accept. */
export interface FlagSpec {
  /** The long name, with its leading dashes, e.g. `--base-url`. */
  name: string;
  /** The short alias, with its leading dash, e.g. `-h`. */
  alias: string | null;
  /** `boolean` flags take no value; `string` flags take one. */
  type: string;
}

/** The six global flags, exactly as the surface contract declares them. */
export const GLOBAL_FLAG_SPECS: FlagSpec[] = GLOBAL_FLAGS.map((flag) => ({
  name: flag.name,
  alias: flag.alias,
  type: flag.type,
}));

/** The global flags, resolved. */
export interface GlobalOptions {
  /** `--base-url`; falls back to `W6W_BASE_URL` later, in the client. */
  baseUrl?: string;
  /** `--token`; falls back to `W6W_TOKEN` later, in the client. */
  token?: string;
  json: boolean;
  noColor: boolean;
  version: boolean;
  help: boolean;
}

/** A successfully parsed command line. */
export interface Invocation {
  /** The command path, e.g. `["documents", "create"]`. Empty for a bare `w6w`. */
  command: string[];
  /** Everything left over after the command path, in order. */
  positionals: string[];
  globals: GlobalOptions;
  /** Non-global flags, keyed by camelCased name. Empty unless `flags` was passed. */
  options: Record<string, string | boolean>;
}

/** What `parse()` returns: a parsed command line, or a usage error to report. */
export type ParseResult =
  | { ok: true; invocation: Invocation }
  | { ok: false; message: string; command: string[] };

/** Optional extras, so a command group can add its own flags without a rewrite. */
export interface ParseOptions {
  /** Command-specific flags, on top of the six global ones. */
  flags?: readonly FlagSpec[];
  /** The command paths that exist. Defaults to the generated contract's. */
  commands?: readonly (readonly string[])[];
}

/** `--base-url` → `baseUrl`. */
function optionKey(flagName: string): string {
  return flagName.replace(/^--/, "").replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

/**
 * Splits the leftover operands into a command path and its positional arguments.
 *
 * Longest match wins, against the command paths the contract declares — which is
 * what tells `w6w run conn_01H…` (a root command plus a positional) apart from
 * `w6w documents get` (a two-token command path). An operand that matches nothing
 * is still returned as a one-token command, so the caller can report it as an
 * unknown command rather than as a stray argument.
 */
function splitCommand(
  operands: string[],
  commands: readonly (readonly string[])[],
): { command: string[]; positionals: string[] } {
  if (operands.length === 0) return { command: [], positionals: [] };
  if (operands.length >= 2) {
    const twoTokenMatch = commands.some((path) =>
      path.length === 2 && path[0] === operands[0] && path[1] === operands[1]
    );
    if (twoTokenMatch) {
      return { command: operands.slice(0, 2), positionals: operands.slice(2) };
    }
  }
  return { command: operands.slice(0, 1), positionals: operands.slice(1) };
}

/**
 * Parses an argument vector.
 *
 * Accepted forms: `--flag`, `--flag value`, `--flag=value`, a short alias
 * (`-h`, `-v`), and `--` to end flag parsing. A repeated flag keeps the last
 * value. An unknown flag, a missing value, or a value handed to a boolean flag
 * are all reported as usage errors.
 */
export function parse(argv: string[], options: ParseOptions = {}): ParseResult {
  const specs: FlagSpec[] = [...GLOBAL_FLAG_SPECS, ...(options.flags ?? [])];
  const commands = options.commands ?? COMMAND_PATHS;
  const byName = new Map(specs.map((spec) => [spec.name, spec]));
  const byAlias = new Map(
    specs.filter((spec) => spec.alias).map((spec) => [spec.alias as string, spec]),
  );

  const values: Record<string, string | boolean> = {};
  const operands: string[] = [];
  const fail = (message: string): ParseResult => ({
    ok: false,
    message,
    command: splitCommand(operands, commands).command,
  });

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];

    if (token === "--") {
      operands.push(...argv.slice(i + 1));
      break;
    }

    if (!token.startsWith("-") || token === "-") {
      operands.push(token);
      continue;
    }

    const equals = token.indexOf("=");
    const rawName = equals === -1 ? token : token.slice(0, equals);
    const inlineValue = equals === -1 ? null : token.slice(equals + 1);
    const spec = rawName.startsWith("--") ? byName.get(rawName) : byAlias.get(rawName);

    if (!spec) return fail(`unknown flag: ${rawName}`);

    if (spec.type === "boolean") {
      if (inlineValue !== null) return fail(`flag ${spec.name} takes no value`);
      values[optionKey(spec.name)] = true;
      continue;
    }

    if (inlineValue !== null) {
      values[optionKey(spec.name)] = inlineValue;
      continue;
    }
    const next = argv[i + 1];
    if (next === undefined || (next.startsWith("-") && next !== "-")) {
      return fail(`flag ${spec.name} requires a value`);
    }
    values[optionKey(spec.name)] = next;
    i++;
  }

  const { command, positionals } = splitCommand(operands, commands);
  const globalKeys = new Set(GLOBAL_FLAG_SPECS.map((spec) => optionKey(spec.name)));
  const extras: Record<string, string | boolean> = {};
  for (const [key, value] of Object.entries(values)) {
    if (!globalKeys.has(key)) extras[key] = value;
  }

  return {
    ok: true,
    invocation: {
      command,
      positionals,
      globals: {
        baseUrl: typeof values.baseUrl === "string" ? values.baseUrl : undefined,
        token: typeof values.token === "string" ? values.token : undefined,
        json: values.json === true,
        noColor: values.noColor === true,
        version: values.version === true,
        help: values.help === true,
      },
      options: extras,
    },
  };
}
