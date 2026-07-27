/**
 * `w6w run <urn> [--action <a>] [--payload <json>]` — run anything a URN
 * addresses: a connection action, a function, an endpoint or a workflow
 * (D16).
 *
 * One command, one SDK call, no envelope key to unwrap — `client.run()`
 * already returns the kind-tagged `RunEnvelope` verbatim. This command's only
 * job is turning `--payload` from a command-line string into the JSON object
 * the operation's body takes, and rendering whichever arm came back.
 *
 * **A `kind` this build has never heard of is shown, not rejected** —
 * `docs/implementation.md` §5, mirrored here rather than re-litigated: the
 * server may grow a fourth arm before the wrappers do, on the one operation
 * whose entire job is dispatch, and a client that raised on it would turn a
 * forward-compatible server change into a hard breakage. `isActionRun` /
 * `isFunctionRun` / `isWorkflowRun` narrow the three known arms; anything
 * else falls to a plain `kind: …` line plus the raw JSON, exactly as the SDK
 * handed it back.
 *
 * @module
 */

import type { CommandContext, CommandHandler, CommandRegistry } from "../../mod.ts";
import { isActionRun, isFunctionRun, isWorkflowRun, type RunEnvelope } from "@w6w/sdk";
import type { Styles } from "../output.ts";
import { argument, noExtraArguments, textFlag, usageError } from "./shared.ts";

/**
 * `--payload <json>` as the object the operation's body takes.
 *
 * Unlike `w6w vars`' `--value` (which falls back to a bare string when it does
 * not parse as JSON, because a var's value legitimately can be one), `run`'s
 * payload is declared `type: "object"` in `endpoints.json` — there is no
 * string arm to fall back to, so a value that fails to parse is a usage
 * error, not a guess.
 */
function payload(context: CommandContext): Record<string, unknown> | undefined {
  const text = textFlag(context, "payload");
  if (text === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw usageError(context, "`--payload` must be valid JSON.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw usageError(context, "`--payload` must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

/** The result, discriminated by kind — the three known arms, then the open one. */
function renderResult(env: RunEnvelope, styles: Styles): string {
  if (isActionRun(env)) {
    return `${styles.bold("action")}\n${JSON.stringify(env.value, null, 2)}`;
  }
  if (isFunctionRun(env)) {
    return `${styles.bold("function")}\n${JSON.stringify(env.output, null, 2)}`;
  }
  if (isWorkflowRun(env)) {
    return `${styles.bold("workflow")} — ${env.runId} (${env.status})\n` +
      styles.dim("use `w6w workflows run " + env.runId + " --wait` to follow it");
  }
  // The open fourth arm: a kind this build does not know. Shown, not raised.
  return `${styles.dim(`kind: ${env.kind} (not recognized by this build)`)}\n` +
    JSON.stringify(env, null, 2);
}

const run: CommandHandler = async (context) => {
  const urn = argument(
    context,
    0,
    "a URN — conn_…, wf_…, fn_… or ep_… (see: `w6w connections list`, `w6w workflows list`)",
  );
  noExtraArguments(context, 1);
  const result = await context.client().run({
    urn,
    action: textFlag(context, "action"),
    payload: payload(context),
  });
  context.out.emit(result, (styles) => renderResult(result, styles));
};

export const RUN_COMMANDS: CommandRegistry = {
  "run": run,
};
