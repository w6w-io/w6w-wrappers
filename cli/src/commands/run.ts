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
 * **`--app <id>` is a second, CLI-only way to address a connection** — used in
 * place of the positional URN, never alongside it. It resolves to a `conn_…`
 * id by matching `connections.list()`'s `appId`, so `w6w run --app sendgrid
 * --action send_email` needs no id looked up first. It is not in
 * `endpoints.json`: the resolution happens entirely client-side, before the
 * request is built, so `run`'s wire shape is untouched and no other wrapper
 * needs an equivalent. See `resolveAppUrn` below.
 *
 * @module
 */

import type { CommandContext, CommandHandler, CommandRegistry } from "../../mod.ts";
import { isActionRun, isFunctionRun, isWorkflowRun, type RunEnvelope } from "@w6w/sdk";
import type { ConnectionSummary } from "@w6w/sdk";
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

/**
 * The several-connections error for `--app`: every candidate, and the exact
 * command to run against each — `action` and `--payload` preserved verbatim,
 * since retyping the whole invocation just to add a URN is the friction
 * `--app` exists to remove in the first place.
 */
function tooManyConnectionsMessage(
  context: CommandContext,
  appId: string,
  matches: ConnectionSummary[],
): string {
  const action = textFlag(context, "action");
  const payloadText = textFlag(context, "payload");
  const suggest = (id: string) => {
    const parts = [`w6w run ${id}`];
    if (action !== undefined) parts.push(`--action ${action}`);
    if (payloadText !== undefined) parts.push(`--payload '${payloadText}'`);
    return parts.join(" ");
  };
  return [
    `Multiple connections found for app \`${appId}\` — a connection id is required to pick one:`,
    "",
    ...matches.map((connection) => `  ${connection.id}  ${connection.displayName}`),
    "",
    "Try, e.g.:",
    ...matches.map((connection) => `  ${suggest(connection.id)}`),
  ].join("\n");
}

/**
 * `--app <id>` resolves to a connection's URN by matching `appId`, so
 * `w6w run --app sendgrid --action send_email` needs no `conn_…` typed or
 * looked up first.
 *
 * One match is unambiguous and used outright. Zero or several is a usage error
 * rather than a guess — the same rule `payload()` above follows for
 * `--payload` — and the several-match error is deliberately expensive to
 * produce (a full `connections.list()` render, not just a count), because it
 * is the one error message in this command a user is expected to copy from.
 */
async function resolveAppUrn(context: CommandContext, appId: string): Promise<string> {
  const connections = await context.client().connections.list();
  const matches = connections.filter((connection) => connection.appId === appId);

  if (matches.length === 1) return matches[0].id;
  if (matches.length === 0) {
    throw usageError(
      context,
      `No connection found for app \`${appId}\`. See \`w6w connections list\` for what is connected.`,
    );
  }
  throw usageError(context, tooManyConnectionsMessage(context, appId, matches));
}

const run: CommandHandler = async (context) => {
  const appId = textFlag(context, "app");
  if (appId !== undefined && context.invocation.positionals.length > 0) {
    throw usageError(
      context,
      "`w6w run` takes a URN or `--app <id>`, not both — drop whichever one you didn't mean.",
    );
  }
  const urn = appId !== undefined ? await resolveAppUrn(context, appId) : argument(
    context,
    0,
    "a URN — conn_…, wf_…, fn_… or ep_… (see: `w6w connections list`, `w6w workflows list`), " +
      "or use `--app <id>` to address a connection by its app instead",
  );
  noExtraArguments(context, appId !== undefined ? 0 : 1);
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
