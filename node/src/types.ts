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
import type { AppSummary } from "./apps.ts";
import type { CallOptions, HttpResponse } from "./http.ts";

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
  /** Caller-chosen name, matching `^[A-Za-z_][A-Za-z0-9_]*$` (case-sensitive). Immutable. */
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
   * Component versions, e.g.
   * `{server: "1.2.3", composition: "core:a1b2c3d,server:e4f5a6b", wrapper: "0.1.0"}`.
   *
   * - `server` — the deployment's image version (= `GET /version`'s `version`).
   * - `composition` — the per-repo short-SHA string (= `GET /version`'s
   *   `composition`; `"dev"` for local builds).
   * - `wrapper` — this package's own version, filled in client-side.
   *
   * **Optional and open.** It may be absent entirely (an older server), and it
   * may carry keys this release has never heard of — so it is typed as a string
   * map and never as a closed record: adding a key server-side must not break an
   * installed client. `wrapper` is filled in by this package from its own
   * `VERSION` (`src/me.ts`); the server cannot know it.
   */
  versions?: Record<string, string> & {
    server?: string;
    composition?: string;
    wrapper?: string;
  };
  /**
   * Server capability markers. **Gate on `=== true`; absent means an older
   * server** that knows nothing of user-scoped credentials.
   */
  capabilities?: {
    /** `true` when this deployment lets a caller own personal ("Only me") credentials. */
    userScopedCredentials?: boolean;
  };
}

/**
 * Lifecycle state of a connection.
 *
 * A closed union because it is the server's own enum and a caller switches on
 * it; unknown *fields* are tolerated everywhere in this file, but a new state
 * would be a server change that the wrapper version-bumps with.
 *
 * `broken` means the connection has to be reconnected before it works again:
 * the server sets it at once when a credential refresh is refused in a way that
 * needs a new sign-in, and after background refreshes have kept failing for
 * days (see {@link ConnectionSummary.refreshFailingSince}).
 */
export type ConnectionState = "pending" | "connected" | "needs_refresh" | "broken" | "revoked";

/** The display metadata of a connection's app, inlined on each {@link ConnectionSummary}. */
export interface ConnectionAppMeta {
  displayName: string;
  /** Light-theme icon, a `data:image/svg+xml;base64,…` URI. */
  iconSvg?: string;
  /** Dark-theme icon, a `data:image/svg+xml;base64,…` URI. */
  iconSvgDark?: string;
  brandColor?: string;
  brandColorDark?: string;
}

/**
 * A connection, as the list route projects it.
 *
 * **The secret material is deliberately absent here**: it is redacted
 * server-side and never reaches a client. Declaring it would promise a caller a
 * field that can never arrive — and would invite exactly the code path
 * (`if (c.…)`) that this omission makes impossible to write
 * (`docs/endpoints.md` §2). The keep-alive timestamps (`lastRefreshedAt`,
 * `refreshFailingSince`) are not secret and are declared below (contract
 * `0.19.0`).
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
  /** The tenant that owns the connection. */
  tenant: string;
  /** The subject (the partner's user id) that created the connection (attribution only). */
  subject: string;
  /**
   * Who may use the connection: `"account"` (shared) or `"user"` (only its
   * creator). Absent means an older server. `subject` stays creator
   * attribution and does not imply ownership.
   */
  accessScope?: "account" | "user";
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
  /**
   * Background keep-alive refresh is on for this connection (the owner's
   * opt-out; the server defaults it to `true`). It only matters where the
   * auth method is `refreshable`. Absent on an older server and on the
   * synthetic `builtIn` row.
   */
  autoRefresh?: boolean;
  /**
   * ISO-8601 timestamp of the last successful credential refresh, or of the
   * original grant; `null` when unknown. Not secret. Absent on an older server
   * and on the synthetic `builtIn` row.
   */
  lastRefreshedAt?: string | null;
  /**
   * ISO-8601 timestamp of the first failure in the current streak of failing
   * background refreshes; `null` when refresh is not failing. Absent on an
   * older server and on the synthetic `builtIn` row.
   */
  refreshFailingSince?: string | null;
  /** ISO-8601 timestamp. */
  createdAt: string;
  /** ISO-8601 timestamp. */
  updatedAt: string;
  /**
   * The stored credential this connection uses. `null` = no stored credential
   * (tenantAuth, jit, none, or a zero-credential row).
   */
  credentialId: string | null;
  /**
   * The connection's app, inlined so a list needs no second fetch for names and icons.
   * `null` means the server found no app row; absent means an older server.
   */
  app?: ConnectionAppMeta | null;
  /**
   * `true` on the synthetic zero-credential row the list can include (a
   * `zerocred:…` id — usable with no connection step, not stored, not
   * deletable). Absent on a stored connection, and on an older server that does
   * not emit the marker.
   */
  builtIn?: boolean;
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
  /** The callable key, or `null` when this workflow has none yet — the normal state for every workflow that predates keys. */
  key: string | null;
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
  /** ISO-8601 archive time; `null` when the Function is live. Always present on the wire. */
  archivedAt: string | null;
  /** Free-form labels the list can be filtered by (`functions.list({ tag })`); `[]` when none. */
  tags: string[];
}

/**
 * An Endpoint definition, as the stable `endpoints.list` route projects it.
 *
 * `key` is the name the Endpoint is CALLED by — `client.endpoints.run(key)` — and
 * `displayName` is the label a human reads. Each row carries its own `invokeUrl`,
 * merged in server-side.
 */
export interface EndpointSummary {
  /** Server-issued id, `ep_…`. */
  id: string;
  /** The callable name, e.g. `"send-email"`. Kebab-case, never contains `_`. */
  key: string;
  /** Human-readable label; falls back to `key` server-side. */
  displayName: string;
  /** Free-text description; `""` when unset. */
  description: string;
  /** ISO-8601 timestamp. */
  updatedAt: string;
  /** The URL this Endpoint is invoked at. */
  invokeUrl: string;
  /** `"ready"` when the stored definition is runnable, else `"draft"`. */
  status: "draft" | "ready";
  /** `true` when `status` is not `"ready"`. */
  incomplete: boolean;
  /** ISO-8601 archive time; `null` when the Endpoint is live. */
  archivedAt: string | null;
  /** Free-form labels the list can be filtered by (`endpoints.list({ tag })`); `[]` when none. */
  tags: string[];
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
  /** Id of the node that failed (canonical). */
  nodeId: string;
  /** Alias of `nodeId`, kept so existing readers keep working. */
  stepId: string;
  /** Whatever the step reported; shape belongs to the app, not to this client. */
  error: unknown;
}

/**
 * A workflow run: the handle, its state, and the result when it has one.
 *
 * A `202` body carries only `runId` + `status` — the run is queued or still
 * going — while a `200` additionally carries `output`, `error`, `nodes` and its alias `steps`.
 * The optional fields are optional for exactly that reason.
 *
 * `output`, `error` and the values in `steps` are **opaque pass-through**
 * (`unknown`): they come from user workflows and vendor apps, and a client that
 * modelled their internals would be wrong for someone. `nodes` (and its `steps` alias) is a map **keyed
 * by node id**, not an array (`docs/implementation.md` §5).
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
  /** Per-node state, keyed by node id (canonical). `{}` when the server sent none. */
  nodes?: Record<string, unknown>;
  // Optional only so pre-existing `RunResult` literals (tests/surface_test.ts) still type-check;
  // the client always sets it.
  /** Alias of `nodes` with identical per-node records. `{}` when the server sent none. */
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

// ---------------------------------------------------------------------------
// Assets and resumable uploads (contract 0.11.0, `assets.*`)
//
// Transcribed from the host's wire shapes (`/asset-uploads`, `/assets`). The
// server never sends an object key, storage path or binding coordinate, so no
// type below has one. Timestamps are ISO strings exactly as sent.
// ---------------------------------------------------------------------------

/** What an upload becomes at finalize. `skill` / `context` run a purpose handler. */
export type AssetUploadPurpose = "asset" | "skill" | "context";

/** Who may see an asset. Default `private`. */
export type AssetVisibility = "private" | "project" | "account";

/** Lifecycle of an upload row. */
export type AssetUploadState =
  | "open"
  | "published"
  | "pending_sync"
  | "aborted"
  | "expired"
  | "failed";

/** Whether a version's bytes are usable yet. */
export type AssetReadiness = "pending" | "ready" | "failed";

/** One file the caller declares when reserving an upload. */
export interface AssetUploadEntryInput {
  /** Author path inside the package, e.g. `skill/SKILL.md`. Canonicalised by the server. */
  path: string;
  /** Exact byte length of the body that will be PUT. */
  sizeBytes: number;
  /** Lowercase hex sha256 of that body. */
  sha256: string;
  mediaType?: string;
}

/** Body of `assets.uploads.create`. */
export interface AssetUploadCreateInput {
  purpose: AssetUploadPurpose;
  /** Replays of the same key with the identical request return the same upload. */
  idempotencyKey: string;
  /**
   * The entries to send. Their position here is NOT the entry `index`: the server assigns
   * each entry's `index` (by its own path ordering) and returns it in the response —
   * address each `putEntry` by the returned `index` for that `path`.
   */
  entries: AssetUploadEntryInput[];
  /** Name of the asset to create at publish; ignored when `assetId` is given. */
  name?: string;
  visibility?: AssetVisibility;
  /** Publish a new version of this existing asset instead of creating one. */
  assetId?: string | null;
  /** Purpose-specific destination data, e.g. `{ skillId }` or `{ collectionId }`. */
  target?: Record<string, unknown>;
}

/** The upload row. */
export interface AssetUpload {
  id: string;
  purpose: AssetUploadPurpose;
  visibility: AssetVisibility;
  project: string | null;
  assetId: string | null;
  versionId: string | null;
  name: string | null;
  status: AssetUploadState;
  reservedBytes: number;
  reservedFiles: number;
  errorCode: string | null;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
}

/** One declared entry and whether its bytes have arrived. */
export interface AssetUploadEntry {
  index: number;
  path: string;
  sizeBytes: number;
  sha256: string;
  state: "pending" | "received";
  receivedAt: string | null;
}

/** `assets.uploads.create` / `get` / `abort`: the upload plus its entries, as sent. */
export interface AssetUploadStatus {
  upload: AssetUpload;
  entries: AssetUploadEntry[];
}

/** `assets.uploads.finalize`: the published version, as sent. */
export interface AssetFinalizeResult {
  uploadId: string;
  assetId: string;
  versionId: string;
  version: number;
  readiness: "ready" | "pending";
  /** What the purpose handler derived from the staged files; `null` for a plain asset. */
  derived: unknown;
  /** `false` when this call found the upload already published. */
  created: boolean;
  /** A `skill` upload only: the skill the package was published into. */
  skill?: Skill;
  /** A `skill` upload only: the new skill version (not the asset `version` number above). */
  skillVersion?: SkillVersion;
  /** A `context` upload only: the linked entry, with its new `revision`. */
  entry?: ContextEntryView;
}

/** An asset. */
export interface Asset {
  id: string;
  name: string;
  kind: string;
  visibility: AssetVisibility;
  project: string | null;
  ownerSubject: string;
  activeVersionId: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** One immutable version of an asset. */
export interface AssetVersion {
  id: string;
  assetId: string;
  version: number;
  inventoryDigest: string;
  readiness: AssetReadiness;
  syncState: string;
  totalBytes: number;
  fileCount: number;
  createdBy: string;
  createdAt: string;
  readyAt: string | null;
}

/** One file of a version. */
export interface AssetFile {
  id: string;
  path: string;
  mediaType: string;
  sizeBytes: number;
  sha256: string;
  createdAt: string;
}

/** `assets.files`: a version and its files, as sent. */
export interface AssetVersionFiles {
  version: AssetVersion;
  files: AssetFile[];
}

/** `assets.purge`: what was deleted, as sent. */
export interface AssetPurgeResult {
  assetId: string;
  versionsDeleted: number;
  objectsDeleted: number;
}

/**
 * The `assets` namespace the node client exposes (implemented by S2 in
 * `src/assets.ts`; named here so the CLI and react lanes can type against it).
 * `Uint8Array` is the byte type in both directions.
 */
export interface AssetsApi {
  uploads: {
    create(input: AssetUploadCreateInput, opts?: CallOptions): Promise<AssetUploadStatus>;
    putEntry(
      id: string,
      index: number,
      bytes: Uint8Array,
      opts?: CallOptions,
    ): Promise<AssetUploadEntry>;
    finalize(id: string, opts?: CallOptions): Promise<AssetFinalizeResult>;
    get(id: string, opts?: CallOptions): Promise<AssetUploadStatus>;
    abort(id: string, opts?: CallOptions): Promise<AssetUploadStatus>;
  };
  get(id: string, opts?: CallOptions): Promise<Asset>;
  versions(id: string, opts?: CallOptions): Promise<AssetVersion[]>;
  files(id: string, versionId: string, opts?: CallOptions): Promise<AssetVersionFiles>;
  content(
    id: string,
    versionId: string,
    fileId: string,
    opts?: CallOptions,
  ): Promise<Uint8Array>;
  archiveDownload(id: string, versionId: string, opts?: CallOptions): Promise<Uint8Array>;
  archive(id: string, opts?: CallOptions): Promise<Asset>;
  purge(id: string, opts?: CallOptions): Promise<AssetPurgeResult>;
}

// ---------------------------------------------------------------------------
// Skills, context collections and agent drafts (`skills.*`, `context.*`,
// `agents.*` — all JSON; skills and context files are UPLOADED through
// `assets.uploads.*`, never created here)
//
// Transcribed from the host's wire shapes (`/skills`, `/context-collections`,
// `/agents`). The server wraps each body in a single-key envelope (`{skills}`,
// `{collection}`, `{entry}`, `{agent}`, …); the namespaces unwrap it.
// ---------------------------------------------------------------------------

/**
 * Options of a write whose route requires the optimistic-concurrency
 * precondition (`agents.update`, `context.entries.update`).
 *
 * `ifUnmodifiedSince` is the `updatedAt` last read, sent as the
 * `x-w6w-if-unmodified-since` header and ONLY when given — never as an empty or
 * `"null"` string. The server requires it on these routes: omitted, the call
 * fails `428 precondition_required` (a typed precondition error), it is never a
 * silent last-write-wins.
 */
export interface PreconditionOptions extends CallOptions {
  ifUnmodifiedSince?: string;
}

/** Options of a list that hides archived rows by default. */
export interface ListArchivedOptions extends CallOptions {
  /** Include archived rows. Default `false`. */
  includeArchived?: boolean;
}

/** `skills.list` / `context.list` options. */
export interface ListPagedOptions extends ListArchivedOptions {
  /** Cap on rows returned. */
  limit?: number;
}

/** A skill. */
export interface Skill {
  id: string;
  name: string;
  description: string | null;
  visibility: AssetVisibility;
  project: string | null;
  ownerSubject: string;
  /** The version new pins should target; `null` before the first publish. */
  activeVersionId: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** One immutable version of a skill. Its `id` is what an agent pins. */
export interface SkillVersion {
  id: string;
  skillId: string;
  version: number;
  entryPath: string;
  metadata: Record<string, unknown>;
  createdBy: string;
  createdAt: string;
}

/** A context collection. */
export interface ContextCollection {
  id: string;
  name: string;
  description: string | null;
  tags: string[];
  visibility: AssetVisibility;
  project: string | null;
  ownerSubject: string;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * One entry of a collection, as `context.entries.list` answers it. It has NO
 * `revision` and NO `previewable` — those ride on {@linkcode ContextEntryView}.
 */
export interface ContextEntry {
  id: string;
  /** Member collections, sorted ascending. */
  collectionIds: string[];
  /** Present on the nested `/context-collections/:id/entries*` responses only. */
  collectionId?: string;
  /** The pin id an agent's {@linkcode ContextPin} attaches. */
  assetVersionId: string;
  name: string;
  mediaType: string;
  tags: string[];
  visibility: AssetVisibility;
  project: string | null;
  ownerSubject: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

/**
 * An entry as `context.entries.create` / `context.entries.update` answer it:
 * the entry plus the `revision` the next `context.entries.update` sends back.
 */
export interface ContextEntryView extends ContextEntry {
  revision: number;
  previewable: boolean;
}

/** Body of `context.create`. */
export interface CreateContextCollectionInput {
  name: string;
  description?: string;
  tags?: string[];
  visibility?: AssetVisibility;
}

/**
 * Body of `context.update`: every field optional, an omitted one is left alone.
 * No `visibility`, no `revision`, no precondition (last-write-wins).
 */
export interface UpdateContextCollectionInput {
  name?: string;
  description?: string;
  tags?: string[];
}

/** Body of `context.entries.create`. */
export interface CreateContextEntryInput {
  name: string;
  text: string;
}

/**
 * Body of `context.entries.update`: a full replacement of the text. `revision`
 * is the entry's last-seen revision, passed through unchanged.
 */
export interface UpdateContextEntryInput {
  text: string;
  revision: number;
}

/** A pin of an agent to one immutable skill version. */
export interface SkillPin {
  skillId: string;
  skillVersionId: string;
}

/** `contextEntries.list` options. */
export interface ListContextEntriesOptions extends ListArchivedOptions {
  /** Only members of this collection. */
  collectionId?: string;
  project?: string;
}

/** Body of `contextEntries.create`. */
export interface CreateStandaloneContextEntryInput {
  name: string;
  text: string;
  visibility?: AssetVisibility;
  collectionIds?: string[];
}

/** A pin of an agent to one context asset version. */
export interface ContextPin {
  /** At least one of `collectionId` / `entryId` is required. */
  collectionId?: string;
  entryId?: string;
  assetVersionId: string;
}

/** Sampling options of an agent's model call; `modelOptions` replaces the whole object. */
export interface ModelOptions {
  /** 0–2. */
  temperature?: number;
  /** 0–1. */
  topP?: number;
  /** Integer 1–1000000. */
  maxOutputTokens?: number;
  /** ≤4 items, each 1–64 chars. */
  stop?: string[];
}

/** Alias of {@linkcode ModelOptions}. */
export type AgentModelOptions = ModelOptions;

/** A capability the agent may call. Max 50 per agent; the server stores only these keys. */
export type AgentTool =
  & {
    /** 1–64 chars, stored trimmed; what the model calls the tool. Unique per agent (case-insensitive). */
    name?: string;
    /** ≤ 1024 chars; author override of what the model is told the tool does. */
    description?: string;
    /**
     * The target's field keys the MODEL fills — the only ones in the tool's schema and the only
     * ones of its arguments passed on. Absent ⇒ every field not in `with`.
     */
    ai?: string[];
    /**
     * Fixed field values: a literal, or an expression over vars/constants/secrets, resolved by
     * the host at call time. Never seen or overridden by the model. A key is in `ai` or `with`,
     * not both. ≤ 64 KiB.
     */
    with?: Record<string, unknown>;
  }
  & (
    | { kind: "action"; uses: { app: string; action: string; connection?: string | null } }
    | { kind: "function"; function: string }
    | { kind: "workflow"; workflow: string }
  );

/** One finding of an agent draft's validation. */
export interface AgentValidationIssue {
  field: string;
  code: string;
  message: string;
}

/** Who may see an agent draft. */
export type AgentVisibility = "private" | "project" | "account";

/**
 * An agent DRAFT. **`runnable` is always the literal `false`**: no Agent
 * runtime, RAG or chat history exists, and no operation runs an Agent (A22).
 * `revision` and `updatedAt` are the two tokens `agents.update` needs.
 */
export interface Agent {
  id: string;
  name: string;
  instructions: string;
  modelRouteId: string | null;
  skills: SkillPin[];
  context: ContextPin[];
  modelOptions: ModelOptions;
  /** Always present; `[]` when none. */
  tools: AgentTool[];
  visibility: AgentVisibility;
  project: string | null;
  revision: number;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
  validation: AgentValidationIssue[];
  runnable: false;
}

/** Body of `agents.create`: every field optional (an incomplete draft saves). */
export interface CreateAgentInput {
  name?: string;
  /** Capped at 64 KiB by the server. */
  instructions?: string;
  modelRouteId?: string | null;
  skills?: SkillPin[];
  context?: ContextPin[];
  modelOptions?: ModelOptions;
  /** On update, present REPLACES the whole list; absent leaves it unchanged. */
  tools?: AgentTool[];
  visibility?: AgentVisibility;
  project?: string | null;
}

/**
 * Body of `agents.update`: a partial update plus the REQUIRED last-seen
 * `revision`, passed through unchanged. A stale one is a typed conflict error
 * carrying the current revision.
 */
export interface UpdateAgentInput extends CreateAgentInput {
  revision: number;
}

/**
 * The `skills` namespace the node client exposes (implemented by S2 in
 * `src/skills.ts`; named here so the CLI and react lanes can type against it).
 * There is no `create`: a skill is uploaded via `assets.uploads` with
 * `purpose: "skill"`.
 */
export interface SkillsApi {
  list(opts?: ListPagedOptions): Promise<Skill[]>;
  get(id: string, opts?: CallOptions): Promise<Skill>;
  versions(id: string, opts?: CallOptions): Promise<SkillVersion[]>;
  archive(id: string, opts?: CallOptions): Promise<Skill>;
}

/** The `context` namespace (implemented by S3 in `src/context.ts`). */
export interface ContextApi {
  list(opts?: ListPagedOptions): Promise<ContextCollection[]>;
  create(input: CreateContextCollectionInput, opts?: CallOptions): Promise<ContextCollection>;
  get(id: string, opts?: CallOptions): Promise<ContextCollection>;
  update(
    id: string,
    patch: UpdateContextCollectionInput,
    opts?: CallOptions,
  ): Promise<ContextCollection>;
  archive(id: string, opts?: CallOptions): Promise<ContextCollection>;
  entries: {
    /** `id` is the COLLECTION id. */
    list(id: string, opts?: ListArchivedOptions): Promise<ContextEntry[]>;
    create(
      id: string,
      input: CreateContextEntryInput,
      opts?: CallOptions,
    ): Promise<ContextEntryView>;
    /** `id` is the COLLECTION id. Needs `revision` and the precondition (428 without it). */
    update(
      id: string,
      entryId: string,
      input: UpdateContextEntryInput,
      opts?: PreconditionOptions,
    ): Promise<ContextEntryView>;
  };
}

/** The `agents` namespace (implemented by S4 in `src/agents.ts`). */
export interface AgentsApi {
  list(opts?: ListArchivedOptions): Promise<Agent[]>;
  create(input?: CreateAgentInput, opts?: CallOptions): Promise<Agent>;
  get(id: string, opts?: CallOptions): Promise<Agent>;
  /** Needs `patch.revision` and the precondition (428 without it); a stale one is a 409. */
  update(id: string, patch: UpdateAgentInput, opts?: PreconditionOptions): Promise<Agent>;
  archive(id: string, opts?: CallOptions): Promise<Agent>;
}

/**
 * Mint a client-side id for a definition the caller is creating.
 *
 * **Both `POST /workflows` and `POST /functions` REQUIRE an `id` in the body
 * and never generate one** (`admin/workflows.ts`'s and `admin/functions.ts`'s
 * `validateDefinition`: "`id` is required."). The id is synthetic and never
 * user-facing — the display name is what a user sees and edits — so a caller
 * writing `create({name: "…", nodes: […]})` should not have to know that, and
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

// ---------------------------------------------------------------------------
// App management (contract 0.14.0) — `client.appManagement.*`
// ---------------------------------------------------------------------------

/**
 * Open-ended string: the known literals autocomplete, any other string still
 * type-checks. (`string & {}` fails `deno lint` `ban-types`.)
 */
type OpenString = string & Record<never, never>;

/** Who manages an app. Open: a newer server may add a class. */
export type ManagementClass =
  | "global"
  | "tenant"
  | "account"
  | "personal"
  | "unclassified"
  | OpenString;

/** Why a management capability is unavailable. Open: a newer server may add a reason. */
export type UnavailableReason =
  | "not_manager"
  | "global_operator_only"
  | "artifact_backed"
  | "no_source"
  | "local_import_forbidden"
  | "conflicting_ownership"
  | OpenString;

/** What the caller may do with one app, computed live at serve time. */
export interface Management {
  class: ManagementClass;
  owner: { tenant: string; subject: string };
  /** The attributed account id, iff `class` is `"account"`. */
  account: string | null;
  capabilities: { canSync: boolean; canEditSource: boolean; canDelete: boolean };
  /** `reasons.x` is present exactly when `capabilities.canX` is `false`. */
  reasons: { sync?: UnavailableReason; editSource?: UnavailableReason; delete?: UnavailableReason };
}

/** An app's active source, as the caller may see it. */
export interface SourceView {
  kind: "github" | "gitlab" | "bitbucket" | "folder" | "file" | "artifact" | "other";
  /** Canonical ref; `null` when the caller may not see it. */
  ref: string | null;
  folder?: { grant: string; label: string; path: string };
  /** `true` iff a source has been committed (not the lazy fallback to the latest version's ref). */
  active: boolean;
  /** The CAS revision; `0` means no committed source. Echo it as `expectedRevision`. */
  revision: number;
  /** The ref names a 40-hex commit (immutable). */
  pinned: boolean;
}

/** The closed set of sync outcomes. */
export type SyncOutcome = "registry_updated" | "definition_unchanged" | "failed";

/** The last recorded sync attempt. */
export interface LastSync {
  outcome: SyncOutcome;
  /** ISO-8601. */
  at: string;
  previousVersion: string | null;
  version: string | null;
  fetchedRevision?: string;
  /** Present iff `outcome` is `"failed"`. */
  errorCode?: string;
}

/** Where a registration lands. */
export type Target = "account" | "tenant" | "personal";

/** One registration target and whether the caller may use it. */
export interface TargetOption {
  target: Target;
  permitted: boolean;
  /** Present iff not permitted. Open: a newer server may add a reason. */
  reason?:
    | "user_import_disabled"
    | "not_tenant_admin"
    | "no_account"
    | "no_subject"
    | OpenString;
}

/** What the caller may name as a source; drives the add-source form. */
export interface SourceOptions {
  publicRepos: true;
  privateRepos: { grant: string; host: "github" | "gitlab" | "bitbucket"; repo: string }[];
  folders: { grant: string; label: string }[];
  localPaths: boolean;
}

/** A source: a canonical remote ref string, or a path inside a granted server folder. */
export type SourceInput = string | { folder: { grant: string; path: string } };

/** One row of the management inventory: the catalog summary plus management state. */
export type ManagedAppRow = AppSummary & {
  management: Management;
  source: SourceView;
  lastSync: LastSync | null;
};

/** Which apps `list` covers. Absent means `"all"`. */
export type ManagementScope = "all" | "account" | "tenant" | "personal";

/** Sort order for `list`. Absent means `"name"`. */
export type ManagedAppsSort = "name" | "-name" | "recent" | "-recent";

/** Options for `appManagement.list`; each is forwarded under its own name when defined. */
export interface ListManagedAppsOptions extends CallOptions {
  scope?: ManagementScope;
  q?: string;
  sort?: ManagedAppsSort;
  compact?: boolean;
  snapshot?: string;
  /** The previous page's `nextCursor`. */
  cursor?: string;
  offset?: number;
  limit?: number;
}

/** The `GET /app-management/apps` body, as sent. */
export interface ManagedAppsPage {
  apps: ManagedAppRow[];
  scope: ManagementScope;
  snapshot: string;
  total: number;
  offset: number;
  limit: number;
  expiresAt: string;
  nextCursor?: string;
  /** Always all three, in the order account, tenant, personal. */
  targets: TargetOption[];
  sourceOptions: SourceOptions;
}

/** The `GET /app-management/apps/:id` body: the catalog detail plus management state. */
export interface ManagedAppDetail {
  app: Record<string, unknown>;
  actions: Record<string, unknown>[];
  auths: Record<string, unknown>[];
  health: unknown;
  sourceRef: string | null;
  version: string;
  digest: string;
  versionCount: number;
  overlay: unknown;
  effective: unknown;
  owner: { tenant: string; subject: string };
  management: Management;
  source: SourceView;
  lastSync: LastSync | null;
}

/** Body of `appManagement.preview`. */
export interface PreviewAppInput {
  source: SourceInput;
  target: Target;
}

/** Body of `appManagement.register`. */
export interface RegisterAppInput {
  target: Target;
  source: SourceInput;
  /** Pack sources only. Sent only when given. */
  paths?: string[];
}

/** Body of `appManagement.updateSource`. */
export interface UpdateSourceInput {
  source: SourceInput;
  /** The `source.revision` read from the row or detail. */
  expectedRevision: number;
}

/** Options for `appManagement.sync`. */
export interface SyncAppOptions extends CallOptions {
  /** Refuse with `409 stale_source` unless this is the current revision. `0` is sent. */
  expectedRevision?: number;
}

/** One entry of a pack preview. */
export interface AppManagementPackEntry {
  path: string;
  id?: string;
  displayName?: string;
  version?: string;
  description?: string;
  alreadyRegistered: boolean;
  pinnedVersion?: string;
  pinnedId?: string;
  optional?: boolean;
  peekError?: string;
}

/** The pack header of a preview or pack registration. */
export interface AppManagementPackInfo {
  name: string;
  displayName?: string;
  description?: string;
  version?: string;
  count: number;
}

/** The `POST /app-management/preview` body. */
export type AppManagementPreview =
  | { kind: "app"; sourceRef: string; app: { id?: string; version?: string; displayName?: string } }
  | {
    kind: "pack";
    sourceRef: string;
    pack: AppManagementPackInfo;
    entries: AppManagementPackEntry[];
  };

/** The `POST /app-management/apps` body: the legacy import shapes plus `target`. */
export type RegisterAppResult =
  | {
    kind: "app";
    sourceRef: string;
    app: Record<string, unknown>;
    actions: Record<string, unknown>[];
    registered: boolean;
    latestAdvanced: boolean;
    target: Target;
  }
  | {
    kind: "pack";
    sourceRef: string;
    pack: AppManagementPackInfo;
    registered: number;
    failed: number;
    results: Array<
      | {
        path: string;
        ok: true;
        id: string;
        version: string;
        registered: boolean;
        latestAdvanced: boolean;
      }
      | { path: string; ok: false; optional: boolean; error: { code: string; message: string } }
    >;
    target: Target;
  };

/** The result of `updateSource` and `sync`. A `failed` outcome is still a 200. */
export interface SyncResult {
  appId: string;
  outcome: SyncOutcome;
  completedAt: string;
  previousVersion: string | null;
  version: string | null;
  bumped: boolean;
  fetchedRevision?: string;
  source: SourceView;
  /** Present iff `outcome` is `"failed"`. */
  error?: { code: string; message: string };
}

/** The `appManagement` namespace (implemented in `src/app-management.ts`). */
export interface AppManagementApi {
  list(opts?: ListManagedAppsOptions): Promise<ManagedAppsPage>;
  get(id: string, opts?: CallOptions): Promise<ManagedAppDetail>;
  preview(input: PreviewAppInput, opts?: CallOptions): Promise<AppManagementPreview>;
  register(input: RegisterAppInput, opts?: CallOptions): Promise<RegisterAppResult>;
  updateSource(id: string, input: UpdateSourceInput, opts?: CallOptions): Promise<SyncResult>;
  sync(id: string, opts?: SyncAppOptions): Promise<SyncResult>;
  remove(id: string, opts?: CallOptions): Promise<{ removed: number }>;
}

// ── Data stores (contract 0.15.0) ───────────────────────────────────────────

/** The three store kinds. Closed: a fourth is a contract change. */
export type DataStoreKind = "kv" | "doc" | "table";

/** One column of a `table` store's schema. */
export interface DataStoreColumn {
  name: string;
  type: "string" | "number" | "integer" | "boolean" | "date" | "datetime";
  required: boolean;
  default?: unknown;
}

/** A store's schema. `kv`/`doc` stores carry `{}`; a `table` store carries its columns. */
export interface DataStoreSchema {
  columns?: DataStoreColumn[];
  /** The column that names a row, when the table has one. */
  key?: string;
}

/** The wire `DataStore` (exactly the server's `storeJson`). */
export interface DataStore {
  id: string;
  kind: DataStoreKind;
  name: string;
  description: string;
  project: string;
  schema: DataStoreSchema;
  entryCount: number;
  sizeBytes: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/** The wire `Entry` (exactly the server's `entryJson`). */
export interface DataStoreEntry {
  key: string;
  value: unknown;
  version: number;
  sizeBytes: number;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** One page of stores. `nextCursor` is absent (never `null`) on the last page. */
export interface DataStorePage {
  items: DataStore[];
  nextCursor?: string;
}

/** One page of entries, by key. `nextCursor` is absent (never `null`) on the last page. */
export interface DataStoreEntryPage {
  items: DataStoreEntry[];
  nextCursor?: string;
}

/** The result of a query-mode read: the matching rows, no paging. */
export interface DataStoreRowSet {
  items: DataStoreEntry[];
}
