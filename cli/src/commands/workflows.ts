/**
 * `w6w workflows …` — list definitions and start runs (D4).
 *
 * Two commands. `list` exists so a caller can find a `wf_…` id to pass to
 * `w6w run` or to this group's own `run`; `run` is the typed path with
 * `--wait`, kept alongside the unified `w6w run` because `?wait=`, variables
 * and trigger have no slot in that operation's three-field shape.
 *
 * @module
 */

import type { CommandContext, CommandHandler, CommandRegistry } from "../../mod.ts";
import type { WorkflowRunResult, WorkflowSummary } from "@w6w/sdk";
import type { Styles } from "../output.ts";
import { argument, noExtraArguments, table, textFlag } from "./shared.ts";
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
 * `w6w workflows run <id> [--wait]` — enqueue a run, optionally waiting for a
 * terminal state.
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
  const result = await context.client().workflows.run(id, wait ? { wait } : {});
  context.out.emit(result, (styles) => renderRun(result, styles));
  return exitCodeFor(result);
};

export const WORKFLOW_COMMANDS: CommandRegistry = {
  "workflows list": list,
  "workflows run": run,
};
