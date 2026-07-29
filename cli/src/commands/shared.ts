/**
 * The vocabulary every command handler shares: reading its own arguments,
 * failing as a usage error, and rendering.
 *
 * It exists because the alternative is worse in both directions. Copying these
 * accessors into each command group gives four spellings of "was this flag
 * given?" — and that question is exactly the one D2 turns on, where a wrong
 * answer silently rewrites a field the user never mentioned. Putting them in
 * `./index.ts` instead would make the registry — the file every command group
 * appends itself to — also the file every group edits, which is how a merge
 * point becomes a merge conflict.
 *
 * Two rules hold everywhere below:
 *
 * 1. **A usage error is thrown, never printed.** `main()` reports it on stderr
 *    once and maps it through `src/exit.ts` to exit `1`; a handler that wrote
 *    its own message would be a second error path to keep in sync.
 * 2. **Presence is `!== undefined`, never truthiness.** `--description ""` is a
 *    flag the user supplied, and it means "clear the description" — a `if
 *    (value)` test would drop it on the floor.
 *
 * @module
 */

import type { CommandContext } from "../../mod.ts";
import { HELP_TREE } from "../help.generated.ts";
import type { Styles } from "../output.ts";

/** `w6w documents get` — the command as the user typed it, for a message. */
function spelling(context: CommandContext): string {
  return `${HELP_TREE.binary} ${context.command.path.join(" ")}`;
}

/**
 * A bad invocation, phrased for the person who typed it.
 *
 * The usage line is the contract's own `naming.cli` spelling rather than a
 * restatement of it, so the thing a user is told to type cannot drift from the
 * thing the surface contract declares.
 *
 * It is a plain `Error` on purpose: `src/exit.ts` maps every non-`ApiError`
 * throw to the usage code, because anything that is not an `ApiError` never
 * reached the server. A bespoke class would add a name to the stack trace and
 * change nothing about the exit code.
 *
 * @param context - The command being run.
 * @param problem - What was wrong, as a sentence.
 * @returns The error to throw.
 */
export function usageError(context: CommandContext, problem: string): Error {
  return new Error(`${problem}\n\nUsage: ${context.command.naming}`);
}

/**
 * One positional argument, required.
 *
 * An **empty** argument counts as missing. That is an argument-presence rule and
 * not a value policy: the server accepts no empty key, name or id, so refusing
 * `""` here makes nothing unreachable — unlike a key such as `".."`, which is
 * legitimately creatable and is therefore never rejected client-side (see
 * `documents get-by-key`).
 *
 * @param context - The command being run.
 * @param index - Position of the argument, after the command path.
 * @param what - What is expected, e.g. ``"a document id (see: `w6w documents list`)"``.
 * @returns The argument.
 * @throws {Error} A usage error when it is absent or empty.
 */
export function argument(context: CommandContext, index: number, what: string): string {
  const value = context.invocation.positionals[index];
  if (value === undefined || value.length === 0) {
    throw usageError(context, `\`${spelling(context)}\` needs ${what}.`);
  }
  return value;
}

/**
 * Reject arguments the command does not take.
 *
 * Silence here is how a typo becomes a surprise: `w6w documents get doc_1 doc_2`
 * would fetch the first id and ignore the second, and `w6w vars list --project`
 * escaped past `--` would list everything as though the scope had been applied.
 *
 * @param context - The command being run.
 * @param expected - How many positional arguments the command takes.
 * @throws {Error} A usage error naming the first extra argument.
 */
export function noExtraArguments(context: CommandContext, expected: number): void {
  const extra = context.invocation.positionals.slice(expected);
  if (extra.length === 0) return;
  throw usageError(
    context,
    `\`${spelling(context)}\` takes ${
      expected === 0 ? "no arguments" : `${expected} argument(s)`
    }` +
      `, and got an extra one: \`${extra[0]}\`.`,
  );
}

/**
 * One flag's value, or `undefined` where the flag was not given.
 *
 * The distinction is the whole of D2: an absent flag must leave the server's
 * field alone, and only a flag the user actually typed may change it. Callers
 * therefore test `!== undefined` and never truthiness.
 *
 * @param context - The command being run.
 * @param name - The flag's camelCased key, e.g. `"project"`, `"description"`.
 * @returns The value as typed, or `undefined`.
 */
export function textFlag(context: CommandContext, name: string): string | undefined {
  const value = context.invocation.options[name];
  return typeof value === "string" ? value : undefined;
}

/**
 * One flag's value, required.
 *
 * @param context - The command being run.
 * @param name - The flag's camelCased key.
 * @param display - How the flag is spelled in help, e.g. `"--content <text>"`.
 * @returns The value as typed.
 * @throws {Error} A usage error when the flag is absent.
 */
export function requiredFlag(context: CommandContext, name: string, display: string): string {
  const value = textFlag(context, name);
  if (value === undefined) {
    throw usageError(context, `\`${spelling(context)}\` needs \`${display}\`.`);
  }
  return value;
}

/**
 * Render rows as aligned columns under a dimmed header.
 *
 * The last column is never padded, so a value that runs long widens nothing and
 * a copied line carries no trailing whitespace.
 *
 * @param header - Column titles.
 * @param rows - The rows, each the same length as `header`.
 * @param styles - The invocation's decorations; plain text when colour is off.
 * @returns The table, newline-separated.
 */
export function table(header: string[], rows: string[][], styles: Styles): string {
  const widths = header.map((title, column) =>
    Math.max(title.length, ...rows.map((row) => row[column].length))
  );
  const line = (cells: string[]) =>
    cells
      .map((cell, column) => (column === cells.length - 1 ? cell : cell.padEnd(widths[column])))
      .join("  ");
  return [styles.dim(line(header)), ...rows.map(line)].join("\n");
}

/**
 * A one-line preview of an opaque value, for a table cell.
 *
 * JSON rather than the value's own text: a variable's value may be a string, a
 * number, a boolean or a whole document, and `hello` versus `"hello"` is the
 * difference between a `string` variable and a `json` one holding a string.
 *
 * @param value - The value, straight off the wire.
 * @param width - Maximum characters before an ellipsis.
 * @returns The preview.
 */
export function preview(value: unknown, width = 40): string {
  const text = JSON.stringify(value) ?? String(value);
  return text.length <= width ? text : `${text.slice(0, width - 1)}…`;
}
