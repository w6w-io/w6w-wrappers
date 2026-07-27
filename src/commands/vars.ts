/**
 * `w6w vars …` — typed variables at the command line.
 *
 * Six commands, **one SDK call each**, addressed the way the server addresses
 * them: **create by `name`, read by id or by name, update and delete by id**
 * (`docs/implementation.md` §7). Nothing here composes two requests or resolves
 * a name by listing and scanning — `get-by-name` targets the real
 * `GET /vars/by-name/{name}` route, which is `status: "planned"` and answers
 * `404` until it lands (T4.4.1, fenced by BLK-1). That is the correct failure
 * and it is not worked around.
 *
 * **There is no `--project` on any command in this group, and this module
 * refuses one rather than ignoring it.** Variables are scoped by tenant and
 * subject only: the `vars` table has no project column and no `vars` route reads
 * the query parameter, while every `documents` route does. The asymmetry is
 * real, so the CLI states it — accepting a flag the server ignores would teach a
 * user a scoping model that does not exist, and they would find out when two
 * projects turned out to share one variable.
 *
 * @module
 */

import type { CommandContext, CommandHandler, CommandRegistry } from "../../mod.ts";
import type { Var, VarPatch, VarType } from "@w6w/sdk";
import type { Styles } from "../output.ts";
import {
  argument,
  noExtraArguments,
  preview,
  requiredFlag,
  table,
  textFlag,
  usageError,
} from "./shared.ts";

/** The flag this group does not have, in both spellings a user can type it. */
const PROJECT_FLAG = "--project";

/**
 * Refuse `--project`, with the reason.
 *
 * Which paths reach this, precisely, because a guard nobody can trigger is
 * decoration:
 *
 * - `w6w vars list --project prj_1` does **not** reach it. `--project` is not
 *   among a `vars` command's declared flags, so the parser rejects it as an
 *   unknown flag before any handler runs — a usage error, exit `1`, with the
 *   command's own help beneath it. Correct code, generic message; making that
 *   message say *why* needs a note on the operation in `endpoints.json` (which
 *   is where all help text comes from) or a "refused flag" concept in the
 *   dispatcher, and both live outside this node's files — see BLK-2.
 * - `w6w vars list -- --project prj_1` **does** reach it, as a positional. So
 *   does any invocation in which the flag survives parsing, which is what makes
 *   this a guard rather than a comment: if `--project` is ever added to the
 *   `vars` operations by mistake, this is what fails instead of the server
 *   quietly ignoring it.
 *
 * Called first in every handler, ahead of the argument-count check, so the
 * specific explanation wins over "takes no arguments".
 */
function refuseProject(context: CommandContext): void {
  const flagged = Object.hasOwn(context.invocation.options, "project") ||
    context.invocation.positionals.some(
      (token) => token === PROJECT_FLAG || token.startsWith(`${PROJECT_FLAG}=`),
    );
  if (!flagged) return;
  throw usageError(
    context,
    `\`w6w vars\` commands take no ${PROJECT_FLAG}: variables are not project-scoped. ` +
      "They are scoped to your tenant and subject, and every project you can reach sees " +
      "the same ones. Documents are the project-scoped asset — see `w6w documents --help`.",
  );
}

/**
 * Encode a `--value` string into the JSON value the server will type-check.
 *
 * A command line carries text and the API carries JSON, so something has to
 * bridge the two. The rule is one sentence, and it is **encoding, never
 * validation** — nothing here rejects a value, and the type policy stays where
 * it belongs, in the server (`400 invalid_type` / `400 invalid_value`):
 *
 * > With `--type string` the text is the value, verbatim. Otherwise the text is
 * > read as JSON if it parses as JSON, and is the string itself if it does not.
 *
 * So `--type string --value hello` stores `"hello"`, `--type number --value 42`
 * stores `42`, `--type json --value '{"a":1}'` stores the object — and
 * `--type number --value forty-two` sends `"forty-two"`, which comes back as the
 * server's `400 invalid_value` rather than as a client-side complaint that would
 * go stale the day the server's rule changes.
 *
 * On `w6w vars update` the type is usually not restated, and then the fallback
 * arm is the whole rule — which is also what makes an **explicit null**
 * expressible: `--value null` sends `{"value":null}`, distinct from omitting the
 * flag and sending `{}` (D2).
 *
 * @param text - The `--value` flag, as typed.
 * @param type - The `--type` flag, when the invocation carried one.
 * @returns The value to put in the request body.
 */
export function encodeValue(text: string, type: string | undefined): unknown {
  if (type === "string") return text;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** One variable, as a table row. */
function row(variable: Var): string[] {
  return [variable.id, variable.name, variable.type, preview(variable.value)];
}

/** The listing: one line per variable, or a line saying there are none. */
function renderList(vars: Var[], styles: Styles): string {
  if (vars.length === 0) return styles.dim("No variables.");
  return table(["ID", "NAME", "TYPE", "VALUE"], vars.map(row), styles);
}

/** One variable in full. The value is pretty-printed JSON: it may be a document. */
function renderVar(variable: Var, styles: Styles): string {
  const heading = `${styles.bold(variable.name)} ${styles.dim(`(${variable.id})`)}`;
  const meta = styles.dim(`${variable.type} · updated ${variable.updatedAt}`);
  const description = variable.description.length > 0 ? [variable.description] : [];
  return [heading, meta, ...description, "", JSON.stringify(variable.value, null, 2)].join("\n");
}

/** The confirmation for a write: what changed, and how to address it next time. */
function renderWrite(verb: string, variable: Var, styles: Styles): string {
  return `${verb} ${styles.bold(variable.name)} ${styles.dim(`(${variable.id})`)}`;
}

const list: CommandHandler = async (context) => {
  refuseProject(context);
  noExtraArguments(context, 0);
  const vars = await context.client().vars.list();
  context.out.emit(vars, (styles) => renderList(vars, styles));
};

const get: CommandHandler = async (context) => {
  refuseProject(context);
  const id = argument(context, 0, "a variable id (see: `w6w vars list`)");
  noExtraArguments(context, 1);
  const variable = await context.client().vars.get(id);
  context.out.emit(variable, (styles) => renderVar(variable, styles));
};

/**
 * `w6w vars get-by-name <name>` — the name-addressed read.
 *
 * The name is handed to the SDK untouched and percent-encoded at interpolation.
 * **No name is rejected here**: `^[a-z_][a-z0-9_]*$` is the server's rule to
 * enforce, and a copy of it in the CLI would refuse locally whatever the server
 * started accepting next. The same dot-segment caveat as
 * `w6w documents get-by-key` applies to this lane (D1) — see
 * `src/commands/documents.ts` — though the server's own name rule admits no dot
 * at all, so no name it accepts can reach it.
 */
const getByName: CommandHandler = async (context) => {
  refuseProject(context);
  const name = argument(context, 0, "a variable name (the name it was created under)");
  noExtraArguments(context, 1);
  const variable = await context.client().vars.getByName(name);
  context.out.emit(variable, (styles) => renderVar(variable, styles));
};

const create: CommandHandler = async (context) => {
  refuseProject(context);
  const name = argument(context, 0, "a variable name to create (matching `^[a-z_][a-z0-9_]*$`)");
  noExtraArguments(context, 1);
  const type = requiredFlag(context, "type", "--type <t>");
  const variable = await context.client().vars.create({
    name,
    // Cast, not checked: the four types are the server's enum, which answers
    // `400 invalid_type` for anything else. A copy of it here would go stale.
    type: type as VarType,
    value: encodeValue(requiredFlag(context, "value", "--value <v>"), type),
    description: textFlag(context, "description"),
  });
  context.out.emit(variable, (styles) => renderWrite("Created", variable, styles));
};

/**
 * `w6w vars update <id>` — a patch, addressed by the server-issued id.
 *
 * **Only flags the user typed reach the wire (D2).** `w6w vars update var_1
 * --description "…"` sends `{"description":"…"}` and leaves the value alone;
 * `w6w vars update var_1` alone sends `{}`; and `--value null` sends
 * `{"value":null}`, which is a different request meaning a different thing. The
 * three are distinguishable because the patch is assembled field by field from
 * flags that were **present**, never from values that happened to be truthy.
 */
const update: CommandHandler = async (context) => {
  refuseProject(context);
  const id = argument(context, 0, "the variable id to update (see: `w6w vars list`)");
  noExtraArguments(context, 1);

  const patch: VarPatch = {};
  const type = textFlag(context, "type");
  if (type !== undefined) patch.type = type as VarType;
  const value = textFlag(context, "value");
  if (value !== undefined) patch.value = encodeValue(value, type);
  const description = textFlag(context, "description");
  if (description !== undefined) patch.description = description;

  const variable = await context.client().vars.update(id, patch);
  context.out.emit(variable, (styles) => renderWrite("Updated", variable, styles));
};

/**
 * `w6w vars delete <id>` — and **nothing on stdout**.
 *
 * As with documents: the server's `{ok:true}` unwraps to nothing at all, so the
 * machine-readable answer is the exit code and the human's confirmation goes
 * through `note()`, which `--json` suppresses.
 */
const remove: CommandHandler = async (context) => {
  refuseProject(context);
  const id = argument(context, 0, "the variable id to delete (see: `w6w vars list`)");
  noExtraArguments(context, 1);
  await context.client().vars.delete(id);
  context.out.note(`Deleted ${id}.`);
};

/**
 * The six `w6w vars` commands, keyed by the canonical command path.
 *
 * The keys are the generated help tree's `path` values joined by a space, which
 * are `endpoints.json`'s `naming.cli` spellings — `tests/cmd_vars_test.ts`
 * asserts the two sets are the same, so a command cannot be registered under a
 * name the help does not document, or documented under a name nothing runs.
 */
export const VAR_COMMANDS: CommandRegistry = {
  "vars list": list,
  "vars get": get,
  "vars get-by-name": getByName,
  "vars create": create,
  "vars update": update,
  "vars delete": remove,
};
