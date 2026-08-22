/**
 * `w6w functions …` — the Function definition lifecycle at the command line.
 *
 * Five commands, **one SDK call each**. `functions run` is deliberately NOT
 * here: it lives in `src/commands/named-run.ts` beside `endpoints run`, because
 * the two share their whole shape (a name, a JSON input, an unwrapped output)
 * and splitting them by domain would put one of a matched pair in each file.
 * The registry is keyed by command path, so a caller sees one `w6w functions`
 * group either way.
 *
 * This group mirrors `w6w workflows` op for op, minus two things the server
 * does not have on this domain:
 *
 * - **No `--project`.** `GET /functions` reads no `?project=` at all, so a flag
 *   here would be one the server ignores — the same reason `w6w vars` refuses
 *   it while `w6w documents` takes it.
 * - **No archive step.** A Function deletes in one call.
 *
 * `create` and `update` are the same upsert route: `create` mints the required
 * `fn_…` id, `update` pins the one you addressed, and `update` is therefore a
 * FULL REPLACEMENT — `w6w functions get <id> --json` is where the definition to
 * edit comes from.
 *
 * @module
 */

import type { CommandContext, CommandHandler, CommandRegistry } from "../../mod.ts";
import type { FunctionDefinition, FunctionDetail, FunctionSummary } from "@w6w/sdk";
import type { Styles } from "../output.ts";
import { argument, noExtraArguments, requiredFlag, table, usageError } from "./shared.ts";

/**
 * `--definition <json>` as the object the write routes take.
 *
 * The same rule `w6w workflows` applies, and deliberately a second copy rather
 * than a shared helper: the two groups' definitions are different documents
 * with different validators, and a shared parser is a seam for one domain's
 * rules to start describing the other's errors.
 */
function definition(context: CommandContext): FunctionDefinition {
  const text = requiredFlag(context, "definition", "--definition <json>");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw usageError(context, "`--definition` must be valid JSON.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw usageError(context, "`--definition` must be a JSON object.");
  }
  return parsed as FunctionDefinition;
}

/** One Function, as a table row. */
function row(fn: FunctionSummary): string[] {
  // `valid` is rendered as a word rather than a boolean: this column answers
  // "can I run this?", and `false` in a table of ids reads like a missing value.
  return [fn.id, fn.key, fn.valid ? "runnable" : "draft", fn.updatedAt];
}

/** The listing: one line per Function, or a line saying there are none. */
function renderList(fns: FunctionSummary[], styles: Styles): string {
  if (fns.length === 0) return styles.dim("No functions.");
  return table(["ID", "KEY", "STATE", "UPDATED"], fns.map(row), styles);
}

/** One Function in full — the JSON is what the reader came for. */
function renderDetail(detail: FunctionDetail, styles: Styles): string {
  const key = typeof detail.function.key === "string" ? detail.function.key : "";
  const state = detail.valid ? "runnable" : "draft";
  return [
    `${styles.bold(key)} ${styles.dim(`(${state})`)}`,
    "",
    JSON.stringify(detail.function, null, 2),
  ].join("\n");
}

/** The confirmation for a write: what changed, and how to address it next time. */
function renderSave(verb: string, saved: { id: string; key: string }, styles: Styles): string {
  return `${verb} ${styles.bold(saved.key)} ${styles.dim(`(${saved.id})`)}`;
}

const list: CommandHandler = async (context) => {
  noExtraArguments(context, 0);
  const fns = await context.client().functions.list();
  context.out.emit(fns, (styles) => renderList(fns, styles));
};

const get: CommandHandler = async (context) => {
  const id = argument(context, 0, "a function id or key (see: `w6w functions list`)");
  noExtraArguments(context, 1);
  const detail = await context.client().functions.get(id);
  context.out.emit(detail, (styles) => renderDetail(detail, styles));
};

const create: CommandHandler = async (context) => {
  noExtraArguments(context, 0);
  const saved = await context.client().functions.create(definition(context));
  context.out.emit(saved, (styles) => renderSave("Created", saved, styles));
};

const update: CommandHandler = async (context) => {
  const id = argument(context, 0, "a function id or key (see: `w6w functions list`)");
  noExtraArguments(context, 1);
  const saved = await context.client().functions.update(id, definition(context));
  context.out.emit(saved, (styles) => renderSave("Updated", saved, styles));
};

/**
 * `w6w functions delete <id>` — one call, no confirmation prompt.
 *
 * Nothing checks for callers first, here or server-side: a Function may be
 * referenced by an Endpoint, a Workflow step, or another Function's `impl`, and
 * those references break at call time rather than at delete time. This lane is
 * non-interactive by construction, so it does not ask — it reports, and the
 * caller decides before typing it.
 */
const remove: CommandHandler = async (context) => {
  const id = argument(context, 0, "a function id or key (see: `w6w functions list`)");
  noExtraArguments(context, 1);
  await context.client().functions.delete(id);
  // `null` rather than the server's `{ok: true}`: the SDK unwraps a delete to
  // nothing, and `--json` must not invent a body the wrapper does not have.
  context.out.emit(null, (styles) => styles.dim(`Deleted ${id}.`));
};

export const FUNCTION_COMMANDS: CommandRegistry = {
  "functions list": list,
  "functions get": get,
  "functions create": create,
  "functions update": update,
  "functions delete": remove,
};
