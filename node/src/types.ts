/**
 * Wire types, transcribed — plus the one envelope reader every operation uses.
 *
 * The shapes below are **transcribed** from `docs/implementation.md` §5 (which
 * reads them off the studio's API types), not imported or vendored from it: this
 * package publishes to npm and JSR and cannot depend on a private workspace
 * source. Field names are the wire's, verbatim — no camel/snake drift, no
 * renaming, no "nicer" aliases. A client that quietly renames a wire field makes
 * every error message and every documentation example wrong.
 *
 * Unknown fields are **tolerated, never rejected**: these are `interface`s, so a
 * field the server adds tomorrow simply arrives and is ignored by an older
 * client. Nothing here validates a response against a closed schema.
 *
 * Every exported member carries an explicit type — JSR publishes this file as
 * TypeScript source and rejects inferred public types ("no slow types",
 * `docs/implementation.md` §1).
 *
 * @module
 */

import { ApiError } from "./errors.ts";
import type { HttpResponse } from "./http.ts";

/**
 * A document's format hint.
 *
 * A **hint only**: it does not gate the content, which the server stores
 * verbatim and never parses. Defaults to `"text"` server-side when a create
 * omits it.
 */
export type DocFormat = "text" | "markdown" | "yaml" | "html" | "json";

/**
 * A document — a keyed blob of text in a project's document store.
 *
 * `id` is the server-issued `doc_…` handle used for update and delete; `key` is
 * the human-chosen name used at create time (and by `documents.getByKey`).
 * `key` is **immutable** — it is not in any patch body
 * (`docs/implementation.md` §7).
 *
 * Timestamps are ISO-8601 **strings**, exactly as they arrive. They are not
 * parsed into `Date`: date parsing is a policy that would have to be identical
 * in three languages and reversible for round-trips, so the wrappers adopt it
 * together or not at all.
 */
export interface Doc {
  /** Server-issued id, `doc_…`. Addresses update and delete. */
  id: string;
  /** Caller-chosen key: non-empty, ≤128 characters, unique per scope + project. */
  key: string;
  /** Raw text. Stored verbatim and never parsed by the server. */
  content: string;
  /** Format hint. */
  format: DocFormat;
  /** Free-text description; `""` when unset. */
  description: string;
  /** ISO-8601 timestamp. */
  createdAt: string;
  /** ISO-8601 timestamp. */
  updatedAt: string;
}

/** A variable's declared type. `value` is validated against it **server-side**. */
export type VarType = "string" | "number" | "boolean" | "json";

/**
 * A typed variable, scoped by tenant/subject.
 *
 * `value` is **`unknown`** on purpose: it is whatever the declared
 * {@linkcode VarType} allows, including an arbitrary JSON document, and a
 * wrapper that modelled its internals would be wrong for someone. Narrow it at
 * the call site after checking `type`.
 */
export interface Var {
  /** Server-issued id, `var_…`. Addresses update and delete. */
  id: string;
  /** Caller-chosen name, matching `^[a-z_][a-z0-9_]*$`. Immutable. */
  name: string;
  /** Declared type. */
  type: VarType;
  /** The value, opaque pass-through. */
  value: unknown;
  /** Free-text description; `""` when unset. */
  description: string;
  /** ISO-8601 timestamp. */
  createdAt: string;
  /** ISO-8601 timestamp. */
  updatedAt: string;
}

/**
 * Who the caller is, plus the versions of the components that answered.
 *
 * The body is **flat**: the identity fields sit at the top level, with no
 * wrapping object around them. That is the contract, not an accident of this
 * transcription — `client.me()` calls `/auth/me`, the server's real identity
 * handler, whose live consumer is the studio, so a nested envelope would break
 * that consumer (`docs/endpoints.md` §1, D15). Nothing in this file unwraps a
 * `me` response, because there is nothing to unwrap.
 *
 * The four identity fields mirror the server's principal.
 */
export interface Me {
  /** Tenant the caller belongs to. */
  tenant: string;
  /** The authenticated subject (a user or a machine principal). */
  subject: string;
  /** Account the caller is acting in. */
  account: string;
  /** The caller's role within that account. */
  role: string;
  /**
   * Component versions, e.g. `{composition: "server@1a2b3c4 …", wrapper: "0.1.0"}`.
   *
   * **Optional and open.** It may be absent entirely (an older server), and it
   * may carry keys this release has never heard of — so it is typed as a string
   * map and never as a closed record: adding a key server-side must not break an
   * installed client. `wrapper` is filled in by this package from its own
   * `VERSION` (`src/me.ts`); the server cannot know it.
   */
  versions?: Record<string, string>;
}

/**
 * Lifecycle state of a connection.
 *
 * A closed union because it is the server's own enum and a caller switches on
 * it; unknown *fields* are tolerated everywhere in this file, but a new state
 * would be a server change that the wrapper version-bumps with.
 */
export type ConnectionState = "pending" | "connected" | "needs_refresh" | "broken" | "revoked";

/**
 * A connection, as the list route projects it.
 *
 * **Two fields the stored record has are deliberately absent here**: the secret
 * material and its last-refresh timestamp are redacted server-side and never
 * reach a client. Declaring them would promise a caller a field that can never
 * arrive — and would invite exactly the code path (`if (c.…)`) that this
 * omission makes impossible to write (`docs/endpoints.md` §2).
 *
 * Timestamps are ISO-8601 strings, exactly as they arrive; `lastTestOk` and
 * `lastTestedAt` are `null` until the connection has been tested once.
 */
export interface ConnectionSummary {
  /** Server-issued id, `conn_…`. This is the handle a URN addresses. */
  id: string;
  /** The app this connection authenticates against, e.g. `"sendgrid"`. */
  appId: string;
  /** Which of the app's auth methods this connection uses. */
  authKey: string;
  /** The subject that owns the connection. */
  owner: string;
  /** Human-chosen label. */
  displayName: string;
  /** Lifecycle state. */
  state: ConnectionState;
  /** Non-secret profile data the app captured at connect time; opaque pass-through. */
  profile: Record<string, unknown>;
  /** Result of the last connection test; `null` when it has never been tested. */
  lastTestOk: boolean | null;
  /** ISO-8601 timestamp of the last test, or `null`. */
  lastTestedAt: string | null;
  /** ISO-8601 timestamp. */
  createdAt: string;
  /** ISO-8601 timestamp. */
  updatedAt: string;
}

/** Lifecycle state of a workflow: an editable draft, a published live one, or archived. */
export type WorkflowStatus = "draft" | "active" | "archived";

/**
 * A workflow definition, as the list route projects it.
 *
 * `name` is the stable slug the workflow was registered under; `displayName` is
 * the label a human reads. Both are present on the wire and neither is derived
 * from the other, so both are kept.
 */
export interface WorkflowSummary {
  /** Server-issued id, `wf_…`. This is the handle a URN addresses. */
  id: string;
  /** Stable slug, e.g. `"welcome-email"`. */
  name: string;
  /** Human-readable label. */
  displayName: string;
  /** Free-text description; `""` when unset. */
  description: string;
  /** Lifecycle state. */
  status: WorkflowStatus;
  /** Free-form labels. */
  tags: string[];
  /** Total number of runs this workflow has accumulated. */
  runCount: number;
  /** ISO-8601 timestamp. */
  updatedAt: string;
}

/**
 * A Function definition, as the list route projects it.
 *
 * `key` is the name the Function is CALLED by — `client.functions.run(key)` —
 * and `displayName` is the label a human reads; the server falls back to the
 * key when no display name was set, so `displayName` is never empty and never a
 * substitute for `key`.
 *
 * There is no `status` here, and no lifecycle to have one: a Function is either
 * runnable or not, which is what {@linkcode FunctionSummary.valid} answers.
 */
export interface FunctionSummary {
  /** Server-issued id, `fn_…`. */
  id: string;
  /** The callable name, e.g. `"send-email"`. Kebab-case, never contains `_`. */
  key: string;
  /** Human-readable label; falls back to `key` server-side. */
  displayName: string;
  /** Free-text description; `""` when unset. */
  description: string;
  /** ISO-8601 timestamp. */
  updatedAt: string;
  /**
   * Whether this Function can actually be run — server-computed, from the same
   * single predicate the invoke path guards with (`db/repos/functions.ts`'s
   * `isFunctionValid`). A draft with no `impl` is `false`, and running it is
   * `422 function_incomplete`.
   */
  valid: boolean;
}

/**
 * Lifecycle state of a run.
 *
 * `queued` and `running` are in-flight; `succeeded`, `failed` and `canceled`
 * are terminal (see {@linkcode isTerminalRunStatus}). **`failed` is a status,
 * not an error**: a run that failed comes back as a normal `200` carrying this
 * value, and no operation in this package raises on it
 * (`docs/implementation.md` §4).
 */
export type RunStatus = "queued" | "running" | "succeeded" | "failed" | "canceled";

/** One step's failure inside a run. `error` is opaque pass-through. */
export interface StepError {
  /** Id of the step that failed. */
  stepId: string;
  /** Whatever the step reported; shape belongs to the app, not to this client. */
  error: unknown;
}

/**
 * A workflow run: the handle, its state, and the result when it has one.
 *
 * A `202` body carries only `runId` + `status` — the run is queued or still
 * going — while a `200` additionally carries `output`, `error` and `steps`.
 * The optional fields are optional for exactly that reason.
 *
 * `output`, `error` and the values in `steps` are **opaque pass-through**
 * (`unknown`): they come from user workflows and vendor apps, and a client that
 * modelled their internals would be wrong for someone. `steps` is a map **keyed
 * by step id**, not an array (`docs/implementation.md` §5).
 */
export interface RunResult {
  /** Server-issued run handle, `run_…`. Present on every response, queued included. */
  runId: string;
  /** Where the run has got to. */
  status: RunStatus;
  /** The run's output when it finished; absent while it is still going. */
  output?: unknown;
  /** The run-level error when it failed; absent otherwise. Data, never a raised exception. */
  error?: unknown;
  /** Per-step state, keyed by step id. `{}` when the server sent none. */
  steps: Record<string, unknown>;
  /** Per-step failures, when the server reports them. */
  stepErrors?: StepError[];
}

/**
 * The invocation FRAME every `RunEnvelope` arm carries — the platform's own
 * record of the attempt, as opposed to whatever the target returned.
 *
 * Added by the server on 2026-08-20 and purely ADDITIVE: no existing field was
 * renamed, removed or re-typed, so code written against the three-arm shape
 * keeps compiling and keeps working.
 *
 * Every field is OPTIONAL here, and that is deliberate rather than lazy: an
 * installed SDK talks to whichever server version is deployed, and a required
 * field would make this type a lie against any server older than the change.
 * Treat an absent `invocationId` as "this server does not record invocations
 * yet", never as an error.
 */
export interface InvocationFrame {
  /**
   * This attempt's id, `inv_…`. Resolves through `GET /invocations/{id}` to the
   * stored inputs, output, error and timing.
   *
   * NOT the same thing as {@linkcode WorkflowRunEnvelope.runId}, and neither
   * replaces the other: this names the CALL, `runId` names the queued workflow
   * RUN that a call may have started. On the workflow arm both can be present
   * and they mean different things.
   */
  invocationId?: string;
  /**
   * The PLATFORM's verdict on the attempt — `"succeeded"`, `"failed"` or, on
   * the workflow arm, `"queued"`.
   *
   * Not to be confused with any status the target reported inside its own
   * payload: a SendGrid send whose `output` reads `{statusCode: 202}` is
   * SendGrid describing its own request, not this platform describing the call.
   */
  status?: "succeeded" | "failed" | "queued" | string;
  /** When the attempt started, ISO-8601. */
  startedAt?: string;
  /** When it reached a terminal state, ISO-8601. */
  finishedAt?: string;
  /** Wall-clock duration in milliseconds. */
  durationMs?: number;
}

/** `run` resolved a `conn_…` URN and executed an app action. HTTP `200`. */
export interface ActionRunEnvelope extends InvocationFrame {
  kind: "action";
  /**
   * The action's return value. Opaque pass-through.
   *
   * @deprecated Read {@linkcode ActionRunEnvelope.output} instead — it is the
   * one payload field every arm agrees on. `value` carries the identical value
   * and is not going away without a major bump, but new code should not reach
   * for a name that only one arm has.
   */
  value: unknown;
  /**
   * The action's return value, under the name every arm shares. Optional
   * because a server older than 2026-08-20 sends only `value`.
   */
  output?: unknown;
}

/** `run` resolved a `fn_…` / `ep_…` URN and executed it. HTTP `200`. */
export interface FunctionRunEnvelope extends InvocationFrame {
  kind: "function";
  /** The function's output. Opaque pass-through. */
  output: unknown;
}

/**
 * `run` resolved a `wf_…` URN and enqueued a workflow run. HTTP `202`.
 *
 * `202` is **success**: the run is queued, and `runId` is how the caller follows
 * it. There is no `?wait=` on this operation — use `workflows.run` for that (D4).
 */
export interface WorkflowRunEnvelope extends InvocationFrame {
  kind: "workflow";
  /**
   * Server-issued run handle — the QUEUED RUN, not the call that queued it.
   * Follow it with `workflows.getRun`. See
   * {@linkcode InvocationFrame.invocationId} for the other id and why they are
   * not the same.
   */
  runId: string;
  /** Where the run has got to; `"queued"` immediately after dispatch. */
  status: RunStatus;
}

/**
 * A `kind` this release has never heard of, handed back verbatim.
 *
 * The server may grow a fourth `kind` before the wrappers do — a purely
 * additive change on the one operation whose entire job is dispatch. This arm
 * is what keeps that additive change from becoming a hard breakage for every
 * user of an installed version: the parsed body is returned as it arrived,
 * `kind` and all sibling fields intact, and nothing raises
 * (`docs/implementation.md` §5).
 */
export type UnknownRunEnvelope = { kind: string } & Record<string, unknown>;

/**
 * What `client.run()` returns: three known arms plus an open one.
 *
 * `value` (action) and `output` (function) were **deliberately different names**
 * for the two synchronous arms, and the guards below still discriminate on
 * `kind` rather than on which field is present. Since 2026-08-20 the server
 * also sends `output` on the action arm, carrying the same value as `value` —
 * so `output` is now the field name every arm shares and the one new code
 * should read. `value` is kept, unchanged, for every caller written before
 * that (D3).
 *
 * **The union is open, and narrowing on `kind` alone does not work.** Because
 * the fourth arm admits any `kind: string`, a bare `env.kind === "workflow"`
 * check leaves `env.status` typed `unknown` under `--strict`, not `RunStatus`.
 * That is a property of the open union, not a bug in it: closing the union would
 * make an unknown `kind` unrepresentable and the pinned "return the raw
 * envelope" behaviour un-typeable. Use the guards below, which narrow properly:
 *
 * @example
 * ```ts
 * const env = await client.run({ urn: "wf_01HQ" });
 * if (isActionRun(env)) console.log(env.value);
 * else if (isFunctionRun(env)) console.log(env.output);
 * else if (isWorkflowRun(env)) console.log(env.runId, env.status);
 * else console.log("a kind this SDK version does not know:", env.kind, env);
 * ```
 */
export type RunEnvelope =
  | ActionRunEnvelope
  | FunctionRunEnvelope
  | WorkflowRunEnvelope
  | UnknownRunEnvelope;

/**
 * Is this the `action` arm? Narrows to {@linkcode ActionRunEnvelope}, so
 * `env.value` is reachable and typed inside the branch.
 *
 * @param env - Any envelope `run` returned.
 * @returns `true` when `kind` is `"action"`.
 */
export function isActionRun(env: RunEnvelope): env is ActionRunEnvelope {
  return env.kind === "action";
}

/**
 * Is this the `function` arm? Narrows to {@linkcode FunctionRunEnvelope}, so
 * `env.output` is reachable and typed inside the branch.
 *
 * @param env - Any envelope `run` returned.
 * @returns `true` when `kind` is `"function"`.
 */
export function isFunctionRun(env: RunEnvelope): env is FunctionRunEnvelope {
  return env.kind === "function";
}

/**
 * Is this the `workflow` arm? Narrows to {@linkcode WorkflowRunEnvelope}, so
 * `env.runId` and `env.status` are reachable and typed inside the branch.
 *
 * @param env - Any envelope `run` returned.
 * @returns `true` when `kind` is `"workflow"`.
 */
export function isWorkflowRun(env: RunEnvelope): env is WorkflowRunEnvelope {
  return env.kind === "workflow";
}

/**
 * Has a run reached a state it will not leave?
 *
 * Exported because it is the same question `workflows.run`'s `terminal` flag
 * answers, and a caller polling a `202` handle on its own schedule needs it
 * too. It reads the **run's** status rather than an HTTP code: a `202` can carry
 * `queued` or `running`, and the answer is about the run, not the transport.
 *
 * @param status - A run status.
 * @returns `true` for `succeeded`, `failed` and `canceled`.
 */
export function isTerminalRunStatus(status: RunStatus): boolean {
  return status === "succeeded" || status === "failed" || status === "canceled";
}

/**
 * Read one payload out of the server's envelope, or fail loudly.
 *
 * The server wraps every asset body under a key — `{documents: […]}`,
 * `{document: …}`, `{vars: […]}`, `{var: …}` — and the wrapper's contract is to
 * hand the caller the payload, never the wrapper (`docs/implementation.md` §6).
 *
 * A `2xx` body **missing** that key is a `bad_response`-class bug and raises,
 * rather than returning `undefined`. That is the pinned behaviour, and the
 * reason is worth keeping next to the code: three wrappers each returning a
 * silent `undefined` here would turn a server regression into a `TypeError`
 * thrown somewhere in the caller's code, minutes later, with nothing pointing
 * back at the response that caused it.
 *
 * This is the *only* place an operation module inspects a body's shape. It is
 * not schema validation: extra keys are ignored, and the payload itself is cast,
 * never checked.
 *
 * A key present but carrying **`null`** counts as missing, for exactly the same
 * reason: `{"document": null}` resolved `documents.get()` to `null` typed `Doc`
 * (measured), which is precisely the deferred `TypeError` in the caller that the
 * paragraph above says this function exists to prevent. The check is therefore
 * `!= null`, not `!== undefined`. The python lane stops the same body one level
 * further in (`unwrap_object`); what both lanes agree on is that it raises
 * `bad_response` with the status still in hand, rather than reaching the caller.
 *
 * @param res - The response returned by the transport.
 * @param key - The envelope key to read, e.g. `"document"`, `"vars"`.
 * @returns The unwrapped payload.
 * @throws {ApiError} `bad_response` when the body is not an object, or lacks the
 * key, or the key is `null`.
 */
export function unwrap<T>(res: HttpResponse<unknown>, key: string): T {
  const body = res.body;
  if (typeof body === "object" && body !== null) {
    const value = (body as Record<string, unknown>)[key];
    // Both arms are load-bearing: absent AND null are "the server did not send
    // what it promised", and only one of them used to be caught.
    if (value !== undefined && value !== null) return value as T;
  }
  throw new ApiError(
    res.status,
    "bad_response",
    `Server returned a ${res.status} with no "${key}" in the response body.`,
    body,
  );
}

/**
 * Mint a client-side id for a definition the caller is creating.
 *
 * **Both `POST /workflows` and `POST /functions` REQUIRE an `id` in the body
 * and never generate one** (`admin/workflows.ts`'s and `admin/functions.ts`'s
 * `validateDefinition`: "`id` is required."). The id is synthetic and never
 * user-facing — the display name is what a user sees and edits — so a caller
 * writing `create({name: "…", steps: […]})` should not have to know that, and
 * every consumer that does know it has ended up writing the same four lines
 * (studio's `newWorkflowId`/`newFunctionId`, `WorkflowsPage.tsx:141` and
 * `FunctionsPage.tsx:49`). This is that function, once.
 *
 * `crypto.randomUUID` is present on every runtime this package supports (Node
 * 19+, Deno, Bun, browsers) but is guarded anyway, byte-for-byte as studio
 * guards it: the fallback keeps `create` working on an older Node rather than
 * throwing a `TypeError` from inside the SDK, and the ids only need to be
 * unique per scope, not unguessable — the server owns ownership, not the id.
 *
 * @param prefix - The kind prefix, without its underscore: `"wf"` or `"fn"`.
 * @returns A new id of the form `wf_…` / `fn_…`.
 */
export function mintId(prefix: string): string {
  const uuid = typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : Math.floor(Math.random() * 1e16).toString(36);
  return `${prefix}_${uuid}`;
}
