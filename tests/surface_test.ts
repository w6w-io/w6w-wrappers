/**
 * The published surface, pinned by importing it.
 *
 * Two things nothing else in this suite can see:
 *
 * 1. **What `mod.ts` actually exports.** Every other test file imports from
 *    `../src/*`, so deleting every export line from the barrel leaves the whole
 *    gate set green while a published consumer sees `VERSION` and nothing else
 *    (measured by the T2.1.2 evaluator's mutation matrix). `mod.ts` is the
 *    declared union-merge point every operation node appends to, which makes it
 *    the single most likely place for a bad merge to silently amputate the
 *    public API. This file imports the barrel and names each export.
 * 2. **What the exported types actually ARE.** The suite's typed fixtures pin
 *    which fields exist and how they are spelled — a dropped or renamed field
 *    fails `deno check`. They pin nothing about the field's *type*: eight
 *    type-precision mutants (`ConnectionState` → `string`, `lastTestOk` losing
 *    `| null`, `versions` made required, …) survived both `deno check` and the
 *    whole suite, and four more (`RunStatus` → `string`, `steps` made optional,
 *    `payload` → `unknown`, `kind` → `string`) survived on the run types. The
 *    pins below fail to compile under each of those mutations.
 *
 * Everything is imported from `../mod.ts` rather than `../src/*`, so the type
 * export lines are pinned by the same mechanism as the runtime ones.
 *
 * `@ts-expect-error` is the load-bearing spelling: it is an error when the line
 * below it *stops* being an error, so widening a union to `string` fails
 * `deno task check` rather than passing unnoticed.
 */

import { assertEquals } from "@std/assert";
import * as barrel from "../mod.ts";
import {
  type ActionRunEnvelope,
  type ConnectionState,
  type ConnectionSummary,
  type Doc,
  type DocFormat,
  type FunctionRunEnvelope,
  isTerminalRunStatus,
  type Me,
  type RunEnvelope,
  type RunInput,
  type RunResult,
  type RunStatus,
  type UnknownRunEnvelope,
  type Var,
  type VarType,
  type WorkflowRunEnvelope,
  type WorkflowRunOptions,
  type WorkflowStatus,
  type WorkflowSummary,
} from "../mod.ts";

/**
 * Every runtime export of the barrel, with what it must be.
 *
 * Adding an operation means adding its export line to `mod.ts` **and** its name
 * here, in the same change — that is the point, not friction: an export that no
 * test names is an export a merge can drop without anything going red.
 */
const PUBLIC_SURFACE: Record<string, "function" | "string"> = {
  // T2.1.1 — the version, in lockstep across all three wrappers.
  VERSION: "string",
  // T2.1.2 — transport core.
  W6wClient: "function",
  ApiError: "function",
  ConfigError: "function",
  BASE_PATH: "string",
  joinBaseUrl: "function",
  path: "function",
  // T2.1.3 — assets.
  DocumentsApi: "function",
  VarsApi: "function",
  // T2.1.4 — identity and discovery.
  fetchMe: "function",
  ConnectionsApi: "function",
  WorkflowsApi: "function",
  // T2.1.5 — execution.
  runUrn: "function",
  isActionRun: "function",
  isFunctionRun: "function",
  isWorkflowRun: "function",
  isTerminalRunStatus: "function",
};

Deno.test("the barrel exports the whole public surface, by name", () => {
  for (const [name, kind] of Object.entries(PUBLIC_SURFACE)) {
    assertEquals(
      typeof (barrel as Record<string, unknown>)[name],
      kind,
      `mod.ts no longer exports ${name}`,
    );
  }
  // Exact set equality, not merely "the expected ones are present": an export
  // added without a line here is as invisible to this suite as one deleted.
  assertEquals(
    Object.keys(barrel).sort(),
    Object.keys(PUBLIC_SURFACE).sort(),
  );
});

Deno.test("the barrel's classes and guards are reachable and usable, not just present", () => {
  // Named exports can survive as `undefined` shaped holes in a bad merge; these
  // lines fail if the binding is not the thing it claims to be.
  const client = new barrel.W6wClient({ baseUrl: "https://api.example.com", token: "t" });
  assertEquals(typeof client.documents.list, "function");
  assertEquals(typeof client.vars.list, "function");
  assertEquals(typeof client.connections.list, "function");
  assertEquals(typeof client.workflows.run, "function");
  assertEquals(typeof client.me, "function");
  assertEquals(typeof client.run, "function");
  assertEquals(barrel.joinBaseUrl("https://x.example.com"), "https://x.example.com/api");
  assertEquals(barrel.path`/documents/${"a/b"}`, "/documents/a%2Fb");
  assertEquals(new barrel.ApiError(404, "unknown_document", "No such.").status, 404);
  assertEquals(barrel.isActionRun({ kind: "action", value: 1 }), true);
});

// ── Union membership: every member, and nothing but the members ──────────────

Deno.test("the wire unions carry exactly their pinned members", () => {
  // The tables are the pin: dropping a member makes the array fail to compile,
  // and `@ts-expect-error` makes widening the union to `string` fail too.
  const formats: DocFormat[] = ["text", "markdown", "yaml", "html", "json"];
  const varTypes: VarType[] = ["string", "number", "boolean", "json"];
  const states: ConnectionState[] = [
    "pending",
    "connected",
    "needs_refresh",
    "broken",
    "revoked",
  ];
  const workflowStatuses: WorkflowStatus[] = ["draft", "active"];
  const runStatuses: RunStatus[] = ["queued", "running", "succeeded", "failed", "canceled"];

  assertEquals(formats.length, 5);
  assertEquals(varTypes.length, 4);
  assertEquals(states.length, 5);
  assertEquals(workflowStatuses.length, 2);
  // …and the members are the ones the terminal rule is written against, so this
  // is a behavioural assertion and not only a type-level one.
  assertEquals(runStatuses.filter(isTerminalRunStatus), ["succeeded", "failed", "canceled"]);
});

// @ts-expect-error — "pdf" is not a DocFormat; widening the union to `string` unpins the format hint.
const _notAFormat: DocFormat = "pdf";
// @ts-expect-error — "date" is not a VarType.
const _notAVarType: VarType = "date";
// @ts-expect-error — "expired" is not a ConnectionState.
const _notAState: ConnectionState = "expired";
// @ts-expect-error — "archived" is not a WorkflowStatus.
const _notAWorkflowStatus: WorkflowStatus = "archived";
// @ts-expect-error — "expired" is not a RunStatus; this is the one a widened alias would unpin.
const _notARunStatus: RunStatus = "expired";
// @ts-expect-error — `kind` is the literal "action", not any string.
const _notAnActionKind: ActionRunEnvelope = { kind: "nope", value: 1 };
// @ts-expect-error — `kind` is the literal "function".
const _notAFunctionKind: FunctionRunEnvelope = { kind: "nope", output: 1 };
// @ts-expect-error — `kind` is the literal "workflow".
const _notAWorkflowKind: WorkflowRunEnvelope = { kind: "nope", runId: "r", status: "queued" };

// ── Optionality and nullability ──────────────────────────────────────────────

const CONNECTION: ConnectionSummary = {
  id: "conn_1",
  appId: "sendgrid",
  authKey: "api_key",
  owner: "user_01HQ",
  displayName: "Marketing sender",
  state: "connected",
  profile: { email: "ops@example.com" },
  lastTestOk: true,
  lastTestedAt: "2026-07-20T09:00:00.000Z",
  createdAt: "2026-07-01T12:00:00.000Z",
  updatedAt: "2026-07-20T09:00:00.000Z",
};

/** Never tested: both fields are `null` until a first test runs. */
const _untested: ConnectionSummary = { ...CONNECTION, lastTestOk: null, lastTestedAt: null };

/** An older server sends no `versions` block at all — the field is optional. */
const _noVersions: Me = { tenant: "t", subject: "s", account: "a", role: "r" };

/** `steps` is required on the wire type: `{}` when the server sent none. */
const _run: RunResult = { runId: "run_1", status: "queued", steps: {} };
// @ts-expect-error — `steps` is required; making it optional would unpin the "{} not absent" rule.
const _runWithoutSteps: RunResult = { runId: "run_1", status: "queued" };

// ── Value types, not just field names ────────────────────────────────────────

/** `versions` values are strings; widening them to `unknown` breaks this read. */
function _readWrapperVersion(me: Me): string | undefined {
  return me.versions?.wrapper;
}

/** `profile` is a string-keyed object of opaque values, not `unknown`. */
function _readProfile(connection: ConnectionSummary): Record<string, unknown> {
  return connection.profile;
}

/** `tags` are strings, not `unknown[]`. */
function _readTags(workflow: WorkflowSummary): string[] {
  return workflow.tags;
}

/** `payload` is a string-keyed object; `unknown` would lose the shape. */
function _readPayload(input: RunInput): Record<string, unknown> | undefined {
  return input.payload;
}

/** `content` and `value` keep their pinned types: text, and deliberately opaque. */
function _readAssets(doc: Doc, variable: Var): [string, unknown] {
  return [doc.content, variable.value];
}

// ── The two directions a union can be wrong ──────────────────────────────────

/**
 * `trigger` must stay an OPEN string.
 *
 * This is the inverse of every pin above, and the one with real consequences:
 * `endpoints.json` declares `trigger` as `type: "string"` with `closedEnum:
 * false` and a `$comment` saying the five known values are documentation and
 * never a constraint. Narrowing it to that enum survives every other gate — and
 * would make this client reject a sixth value a newer server accepts, with no
 * server bug anywhere. This line stops compiling the moment someone closes it.
 */
const _futureTrigger: WorkflowRunOptions = { trigger: "a_future_server_value" };
const _knownTriggers: WorkflowRunOptions[] = [
  { trigger: "manual" },
  { trigger: "schedule" },
  { trigger: "webhook" },
  { trigger: "event" },
  { trigger: "replay" },
];

/**
 * `RunEnvelope` must stay OPEN.
 *
 * The fourth arm is what makes "a `kind` this release has never heard of is
 * handed back verbatim" typeable at all; closing the union makes the pinned
 * behaviour un-expressible (proved independently by compiling both spellings).
 * This assignment is legal only while the open arm is there.
 */
const _unknownArm: RunEnvelope = { kind: "quantum", note: "a kind from a newer server" };
const _unknownArmTyped: UnknownRunEnvelope = { kind: "quantum", note: "…" };
