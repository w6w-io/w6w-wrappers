/**
 * `w6w workflows …` — list definitions, start runs (D4), and edit the
 * definitions themselves.
 *
 * Seven commands. `list` exists so a caller can find a `wf_…` id to pass to
 * `w6w run` or to this group's own `run`; `run` is the typed path with
 * `--wait` and `--input`, kept alongside the unified `w6w run` because
 * `?wait=`, `variables`, `trigger` and `input` have no slot in that
 * operation's three-field shape. `get`, `create`, `update`, `archive` and
 * `delete` are the definition lifecycle.
 *
 * **A definition arrives as `--definition <json>`, not `--file <path>`.** This
 * lane reads no files: `--payload`, `--input` and `--content` are all
 * command-line strings already, the CLI runs with no `--allow-read`, and
 * `--definition "$(cat wf.json)"` is one shell idiom rather than a new
 * permission and a new class of error (missing file, unreadable file, file that
 * is not JSON) for every command that writes.
 *
 * **`create` and `update` are one route.** The server has a single upsert; what
 * separates the two commands is that `create` mints the required id and
 * `update` pins the one you addressed. Consequently `update` is a FULL
 * REPLACEMENT — `w6w workflows get <id> --json` is where the definition to edit
 * comes from.
 *
 * @module
 */

import type { CommandContext, CommandHandler, CommandRegistry } from "../../mod.ts";
import type {
  WorkflowDefinition,
  WorkflowDetail,
  WorkflowRunResult,
  WorkflowSaveResult,
  WorkflowSummary,
} from "@w6w/sdk";
import type { Styles } from "../output.ts";
import { argument, noExtraArguments, requiredFlag, table, textFlag, usageError } from "./shared.ts";
import { exitCodeFor } from "../exit.ts";

/**
 * `--definition <json>` as the object the write routes take.
 *
 * Mirrors `input()` below and `src/commands/run.ts`'s `payload()`: the contract
 * declares `definition` as `type: "object"`, so a value that fails to parse — or
 * parses to something that is not a plain object — is a usage error, never a
 * silent guess. An array is rejected explicitly: `JSON.parse("[]")` is an object
 * to `typeof`, and forwarding one would reach the server as a body its
 * validator answers with a message about a missing `id`, which is a confusing
 * way to be told "that is a list".
 */
function definition(context: CommandContext): WorkflowDefinition {
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
  return parsed as WorkflowDefinition;
}

/**
 * The `--project` scope for `list`, or nothing at all.
 *
 * Nothing is the important case — an omitted flag is how the caller asks the
 * server for every project the credential can see, matching
 * `src/commands/documents.ts`'s `scope()`.
 */
function scope(context: CommandContext): { project?: string } {
  const project = textFlag(context, "project");
  return project === undefined ? {} : { project };
}

/** One workflow, as a table row. */
function row(workflow: WorkflowSummary): string[] {
  return [workflow.id, workflow.name, workflow.status, String(workflow.runCount)];
}

/** The listing: one line per workflow, or a line saying there are none. */
function renderList(workflows: WorkflowSummary[], styles: Styles): string {
  if (workflows.length === 0) return styles.dim("No workflows.");
  return table(["ID", "NAME", "STATUS", "RUNS"], workflows.map(row), styles);
}

/**
 * `--input <json>` as the object delivered to the run's entry trigger node.
 *
 * Mirrors `src/commands/run.ts`'s `payload()`: `endpoints.json` declares
 * `input` as `type: "object"`, so a value that fails to parse — or parses to
 * something that is not a plain object — is a usage error, never a silent
 * guess. Not the same slot as `variables` (which this command has no flag for
 * yet): `input` is delivered to the entry trigger node's own recorded output,
 * read downstream as `steps.<triggerId>.output.<key>` — the shape a
 * trigger's declared fields actually arrive in.
 */
function input(context: CommandContext): Record<string, unknown> | undefined {
  const text = textFlag(context, "input");
  if (text === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw usageError(context, "`--input` must be valid JSON.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw usageError(context, "`--input` must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

/**
 * A run result. `terminal` and `httpStatus` are this SDK's own derived
 * fields, not part of the wire body — they are not restated here, and stay
 * in the `--json` payload, which is the raw object handed to
 * `context.out.emit`.
 */
function renderRun(run: WorkflowRunResult, styles: Styles): string {
  const heading = `${styles.bold(run.runId)} — ${run.status}`;
  if (run.status !== "failed" || run.error === undefined) return heading;
  return `${heading}\n${JSON.stringify(run.error, null, 2)}`;
}

/** One workflow definition in full — the JSON is what the reader came for. */
function renderDetail(detail: WorkflowDetail, styles: Styles): string {
  const id = typeof detail.workflow.id === "string" ? detail.workflow.id : "";
  const heading = `${styles.bold(id)} ${styles.dim(`updated ${detail.updatedAt}`)}`;
  return [heading, "", JSON.stringify(detail.workflow, null, 2)].join("\n");
}

/** The confirmation for a write: what changed, and how to address it next time. */
function renderSave(verb: string, saved: WorkflowSaveResult, styles: Styles): string {
  const line = `${verb} ${styles.bold(saved.workflow.name)} ${
    styles.dim(`(${saved.workflow.id})`)
  }`;
  // Only when it happened: a `scheduled: false` line on every save would train
  // the reader to skip the one that matters.
  return saved.scheduled ? `${line}\n${styles.dim("Schedule applied.")}` : line;
}

const list: CommandHandler = async (context) => {
  noExtraArguments(context, 0);
  const workflows = await context.client().workflows.list(scope(context));
  context.out.emit(workflows, (styles) => renderList(workflows, styles));
};

/**
 * `w6w workflows run <id> [--wait] [--input <json>]` — enqueue a run,
 * optionally waiting for a terminal state.
 *
 * **A failed run is data, not a thrown error (D3/D4)**: the SDK returns it
 * rather than raising, so this handler is the one place that turns a
 * `status: "failed"` result into the CLI's own exit code 3, via the shared
 * `exitCodeFor` every command falls into the same way (`src/exit.ts`). A
 * queued or successful run returns `undefined` from `exitCodeFor`'s callers
 * elsewhere as success — here it is explicit because this is the one command
 * whose success path can carry a run-level failure.
 */
const run: CommandHandler = async (context) => {
  const id = argument(context, 0, "a workflow id (see: `w6w workflows list`)");
  noExtraArguments(context, 1);
  const wait = context.invocation.options.wait === true;
  const result = await context.client().workflows.run(id, { wait, input: input(context) });
  context.out.emit(result, (styles) => renderRun(result, styles));
  return exitCodeFor(result);
};

const get: CommandHandler = async (context) => {
  const id = argument(context, 0, "a workflow id (see: `w6w workflows list`)");
  noExtraArguments(context, 1);
  const detail = await context.client().workflows.get(id);
  context.out.emit(detail, (styles) => renderDetail(detail, styles));
};

const create: CommandHandler = async (context) => {
  noExtraArguments(context, 0);
  const saved = await context.client().workflows.create(definition(context), scope(context));
  context.out.emit(saved, (styles) => renderSave("Created", saved, styles));
};

/**
 * `w6w workflows update <id> --definition <json>` — a full replacement,
 * addressed by the server-issued id.
 *
 * `--if-unmodified-since <ts>` is the optimistic-concurrency precondition, and
 * it is passed through only when the caller supplied one: an absent flag is
 * last-write-wins, and turning that into an empty header would be a
 * `400 invalid_precondition` naming something the caller never asked for.
 */
const update: CommandHandler = async (context) => {
  const id = argument(context, 0, "a workflow id (see: `w6w workflows list`)");
  noExtraArguments(context, 1);
  const saved = await context.client().workflows.update(id, definition(context), {
    ...scope(context),
    ifUnmodifiedSince: textFlag(context, "if-unmodified-since"),
  });
  context.out.emit(saved, (styles) => renderSave("Updated", saved, styles));
};

const archive: CommandHandler = async (context) => {
  const id = argument(context, 0, "a workflow id (see: `w6w workflows list`)");
  noExtraArguments(context, 1);
  const workflow = await context.client().workflows.archive(id);
  context.out.emit(workflow, (styles) => styles.dim(`Archived ${id}.`));
};

/**
 * `w6w workflows delete <id>` — the delete, which the server gates on the
 * workflow already being archived.
 *
 * No confirmation prompt and no automatic archive-then-delete. This lane is
 * non-interactive by construction, and a CLI that quietly completed the second
 * half of a destructive two-step is how a workflow someone only meant to
 * inspect gets deleted. A `409 workflow_not_archived` reaches the caller as an
 * `ApiError` naming the step they still have to take.
 */
const remove: CommandHandler = async (context) => {
  const id = argument(context, 0, "a workflow id (see: `w6w workflows list`)");
  noExtraArguments(context, 1);
  await context.client().workflows.delete(id);
  // `null` rather than the server's `{ok: true}`: the SDK unwraps a delete to
  // nothing, and `--json` must not invent a body the wrapper does not have.
  context.out.emit(null, (styles) => styles.dim(`Deleted ${id}.`));
};

export const WORKFLOW_COMMANDS: CommandRegistry = {
  "workflows list": list,
  "workflows run": run,
  "workflows get": get,
  "workflows create": create,
  "workflows update": update,
  "workflows archive": archive,
  "workflows delete": remove,
};
