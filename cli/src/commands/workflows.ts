/**
 * `w6w workflows …` — list definitions and start runs (D4).
 *
 * Two commands. `list` exists so a caller can find a `wf_…` id to pass to
 * `w6w run` or to this group's own `run`; `run` is the typed path with
 * `--wait` and `--input`, kept alongside the unified `w6w run` because
 * `?wait=`, `variables`, `trigger` and `input` have no slot in that
 * operation's three-field shape.
 *
 * @module
 */

import type { CommandContext, CommandHandler, CommandRegistry } from "../../mod.ts";
import type { WorkflowRunResult, WorkflowSummary } from "@w6w/sdk";
import type { Styles } from "../output.ts";
import { argument, noExtraArguments, table, textFlag, usageError } from "./shared.ts";
import { exitCodeFor } from "../exit.ts";

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

export const WORKFLOW_COMMANDS: CommandRegistry = {
  "workflows list": list,
  "workflows run": run,
};
