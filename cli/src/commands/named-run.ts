/**
 * `w6w functions run <name>` and `w6w endpoints run <name>` — run the thing you
 * named, rather than the id the host issued.
 *
 * The sibling of `w6w workflows run <id>`: the NAME IS THE FIRST POSITIONAL
 * ARGUMENT in all three, so the group reads alike. It may be the resource's key
 * (`send-email`) or its `fn_…` / `ep_…` id — the server takes either in one
 * path slot, because an id carries a kind prefix and therefore an underscore
 * while a key is a kebab-slug that forbids one. Nothing has to be tagged, so
 * this group has no `--by-key` flag and no prefix to teach.
 *
 * `w6w run <urn>` stays: it is the right tool when the caller is *dispatching*
 * something whose kind it does not know. These two are for when it does.
 *
 * @module
 */

import type { CommandContext, CommandHandler, CommandRegistry } from "../../mod.ts";
import type { Styles } from "../output.ts";
import { argument, noExtraArguments, textFlag, usageError } from "./shared.ts";

/**
 * `--payload <json>` as the resource's input object.
 *
 * A verbatim copy of `src/commands/run.ts`'s parser, and deliberately so: the
 * contract declares this parameter as `type: "object"` for every runnable kind,
 * so a value that fails to parse — or parses to something that is not a plain
 * object — is a usage error and never a silent guess. Three commands must not
 * disagree about what `--payload` accepts.
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

/**
 * A Function's output, rendered for a terminal.
 *
 * The output is an OPAQUE pass-through — it may be an object, a string, a
 * number, or `null` for an action that returns nothing — so this stringifies
 * whatever arrived rather than reaching for fields it cannot promise. The
 * `--json` lane emits the value itself, untouched.
 */
function renderOutput(output: unknown, styles: Styles): string {
  if (output === null || output === undefined) return styles.dim("(no output)");
  if (typeof output === "string") return output;
  return JSON.stringify(output, null, 2);
}

/** An Endpoint's envelope: the arm that answered, then its payload. */
function renderEnvelope(envelope: Record<string, unknown>, styles: Styles): string {
  const kind = String(envelope.kind);
  // The workflow arm is asynchronous — the useful line is the run handle, not
  // a result the caller does not have yet.
  if (kind === "workflow") {
    return `${styles.bold(String(envelope.runId))} — ${String(envelope.status)}`;
  }
  const value = kind === "action" ? envelope.value : envelope.output;
  return `${styles.dim(kind)}\n${renderOutput(value, styles)}`;
}

/**
 * `w6w functions run <name> [--payload <json>]` — run one Function.
 *
 * Emits the Function's OUTPUT, not an envelope: the kind is settled by the
 * command itself, so a discriminant would be a field the reader skips.
 */
const runFunction: CommandHandler = async (context) => {
  const name = argument(context, 0, "a function key or id (see: `w6w functions list`)");
  noExtraArguments(context, 1);
  const output = await context.client().functions.run(name, { payload: payload(context) });
  context.out.emit(output, (styles) => renderOutput(output, styles));
};

/**
 * `w6w endpoints run <name> [--payload <json>]` — run one Endpoint.
 *
 * Emits the kind-discriminated envelope, because an Endpoint dispatches to an
 * app action, a Function or a Workflow and only the response says which.
 */
const runEndpoint: CommandHandler = async (context) => {
  const name = argument(context, 0, "an endpoint key or id");
  noExtraArguments(context, 1);
  const envelope = await context.client().endpoints.run(name, { payload: payload(context) });
  context.out.emit(
    envelope,
    (styles) => renderEnvelope(envelope as unknown as Record<string, unknown>, styles),
  );
};

export const NAMED_RUN_COMMANDS: CommandRegistry = {
  "functions run": runFunction,
  "endpoints run": runEndpoint,
};
