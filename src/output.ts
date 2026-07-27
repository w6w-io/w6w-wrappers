/**
 * The output renderer — one place that decides what a command's answer looks
 * like, and which stream it lands on.
 *
 * Three rules, and every command inherits all three by writing through this
 * module instead of touching the writer directly:
 *
 * 1. **`--json` prints the payload and nothing else.** No banner, no progress
 *    line, no "done" — the point of the flag is that the output goes into a pipe.
 *    Anything a human would have wanted to read is suppressed, not reworded.
 * 2. **Errors go to stderr. Always.** So `--json` output stays parseable even
 *    when the command failed, and so `w6w … > out.json` never quietly writes an
 *    error message into a file something else is going to read as data.
 * 3. **Colour is opt-out three ways** — `--no-color`, a `NO_COLOR` environment
 *    variable, and a stdout that is not a terminal — and it is off under `--json`
 *    unconditionally, because an escape sequence in a JSON document is a bug.
 *
 * @module
 */

import { type EnvReader, envValue, NO_ENV } from "./client.ts";
import { HELP_TREE } from "./help.generated.ts";
import type { CliIo } from "./runtime.ts";

/**
 * The conventional opt-out (https://no-color.org). Any non-blank value disables
 * colour; a blank one is treated as absent, exactly like every other environment
 * variable this CLI reads.
 */
export const ENV_NO_COLOR = "NO_COLOR";

/** Text decorations. Every one is the identity function when colour is off. */
export interface Styles {
  bold(text: string): string;
  dim(text: string): string;
  red(text: string): string;
  green(text: string): string;
  yellow(text: string): string;
}

/** How a command's output should be rendered. */
export interface OutputOptions {
  /** `--json`: print the payload as JSON and nothing else. */
  json?: boolean;
  /** `--no-color`: never emit escape sequences. */
  noColor?: boolean;
  /** Whether stdout is a terminal. Defaults to `false` — the safe assumption for a pipe. */
  isTty?: boolean;
  /** The environment seam, for `NO_COLOR`. Defaults to an empty environment. */
  env?: EnvReader;
}

/** What a command writes through. */
export interface Output {
  /** Whether `--json` is in force. */
  readonly json: boolean;
  /** Whether colour is in force. */
  readonly color: boolean;
  /** The decorations, already resolved to plain text when colour is off. */
  readonly styles: Styles;
  /**
   * The command's result: the payload under `--json`, the human rendering
   * otherwise. Both go to stdout.
   */
  emit(payload: unknown, render: (styles: Styles) => string): void;
  /** A line for a human — a hint, a heading, a count. Suppressed by `--json`. */
  note(text: string): void;
  /** A failure. Prefixed with the binary name, and always on stderr. */
  error(message: string): void;
}

const PLAIN: Styles = {
  bold: (text) => text,
  dim: (text) => text,
  red: (text) => text,
  green: (text) => text,
  yellow: (text) => text,
};

/** SGR wrapper. Reset is the full reset, so nested decorations cannot leak. */
function sgr(code: string): (text: string) => string {
  return (text: string) => `\x1b[${code}m${text}\x1b[0m`;
}

const COLOURED: Styles = {
  bold: sgr("1"),
  dim: sgr("2"),
  red: sgr("31"),
  green: sgr("32"),
  yellow: sgr("33"),
};

/**
 * Whether this invocation may emit colour.
 *
 * Pure, and exported, so the decision is testable without a terminal: it is
 * every escape-sequence bug's root cause and none of the inputs are things a
 * test can arrange for real.
 *
 * @param options - The flags, the terminal-ness of stdout, and the environment.
 * @returns `true` only when nothing at all objects.
 */
export function useColor(options: OutputOptions = {}): boolean {
  if (options.json) return false;
  if (options.noColor) return false;
  if (options.isTty !== true) return false;
  return envValue(options.env ?? NO_ENV, ENV_NO_COLOR) === undefined;
}

/**
 * Build the renderer for one invocation.
 *
 * @param io - Where to write. The only I/O this module performs.
 * @param options - The global flags, the terminal-ness of stdout, and the environment.
 * @returns The renderer every command in this invocation writes through.
 */
export function createOutput(io: CliIo, options: OutputOptions = {}): Output {
  const json = options.json === true;
  const color = useColor(options);
  const styles = color ? COLOURED : PLAIN;
  return {
    json,
    color,
    styles,
    emit(payload: unknown, render: (styles: Styles) => string): void {
      // Two spaces of indent: still one document, still `jq`-able, and readable
      // when a user forgets they redirected it.
      io.stdout(json ? JSON.stringify(payload ?? null, null, 2) : render(styles));
    },
    note(text: string): void {
      if (!json) io.stdout(text);
    },
    error(message: string): void {
      io.stderr(`${HELP_TREE.binary}: ${message}`);
    },
  };
}
