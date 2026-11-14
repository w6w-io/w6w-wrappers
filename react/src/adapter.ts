/**
 * `createW6WUiAdapter` — a structurally-typed bridge from a `W6WClient` to
 * `@w6w/ui`'s `W6WApi` contract (C-1, C-2).
 *
 * `W6WApi` below is a HAND-DUPLICATE of `packages/ui/src/provider.tsx:87-231` —
 * transcribed by hand, never imported. `@w6w/ui` is `SEE LICENSE IN LICENSE`
 * and unpublished; this lane is MIT, so no dependency edge to it may exist
 * anywhere, not even a type-only one (C-1). The VALUE types the interface
 * needs (`AppSummary`, `ActionDef`, `AuthDef`, `ApiCallRecord`, `SavedTest`,
 * `TestRunSummary`, `StepTest`, `InvokeOptions`, `ConnectionSummary`) are NOT
 * hand-duplicated — they are already exported from `@w6w/sdk`/`@w6w/sdk/console`
 * and structurally compatible (`building-blocks.md` §3's "Type duplication"
 * analysis). Two documented, harmless narrowings from that analysis:
 * - `getAppActions`'s `ActionDef.params` (`ActionParam`, `@w6w/sdk/console`)
 *   carries 6 fields vs `@w6w/ui`'s 14 richer, presentation-only ones —
 *   typechecks fine, no runtime loss, no autocomplete for the extra optional
 *   fields. See README "Known limitations".
 * - `listTestRuns` is REQUIRED here; `@w6w/ui`'s declaration marks it optional
 *   (`?`) only so a consumer that hasn't wired history yet still typechecks.
 *   Every consumer of THIS adapter gets a real implementation, so there is no
 *   reason to decline it — a required member still satisfies an interface
 *   that declares it optional.
 *
 * Every member here is a thin call into `client.console.*`, with two
 * exceptions the SDK's own module headers document:
 * - `listConnections` — see the comment at its call site below.
 * - `recordTestRun` / `recordStepTestRun` — the SDK returns the real created
 *   row; `W6WApi` is pinned `Promise<void>`. Discarded with
 *   `.then(() => undefined)`, mirroring
 *   `packages/studio/src/repos/saved-tests.ts:97-109` and
 *   `step-tests.ts:46-59` (read-only reference, transcribed, never imported).
 *
 * `listApps` is a direct, one-line pass-through to `client.console.apps.list()`
 * — that method already pages internally (`node/src/console/apps.ts:469-496`),
 * so writing a second pagination loop here would be exactly the "third client
 * for these routes" C-2 exists to prevent.
 *
 * `listTriggerApps`/`getAppTriggers`/`listSubscriptionsForWorkflow`/
 * `createSubscription` are REQUIRED here even though `@w6w/ui`'s own
 * declaration marks them optional (`?`) — plan.md D-2: optional-in-`ui` lets
 * a partner on an older `@w6w/react` degrade instead of crashing, while every
 * consumer of THIS adapter gets a real implementation.
 *
 * `listFunctions`/`getFunction`/`invokeFunction`/`listWorkflows`/`getWorkflow`/
 * `runWorkflow` are thin calls over the BASE `client.functions.*`/
 * `client.workflows.*` surface — never `client.console.*` — mirroring
 * `listConnections`'s own base-over-console preference above. `getFunction`
 * and `getWorkflow` reshape the base namespace's intentionally OPAQUE
 * definition (`node/src/functions.ts`'s `FunctionDefinition`,
 * `node/src/workflows.ts`'s `WorkflowDefinition` are both
 * `Record<string, unknown>`, by design — a newer server may add fields a
 * modelled type would reject) into `@w6w/ui`'s narrower `FunctionDetail`/
 * `WorkflowDetail` by reading the handful of fields every stored definition
 * carries (`id`, `key`/`name`, `displayName`, `description`, `inputs`/
 * `steps`) — the same real wire fields `@w6w/sdk/console`'s typed
 * `FunctionDef`/the console workflow shape name, not a guess. `getFunction`'s
 * `inputs` picks up the SAME `ActionParam` narrowing as `getAppActions`
 * above (6 fields vs `@w6w/ui`'s 14 richer, presentation-only ones). `runWorkflow`
 * always sends `wait: true` and forwards `client.workflows.run`'s own
 * `terminal` unchanged — that field is already derived from the run's
 * `status` (`200` ⇒ terminal, the server's `202` wait-timeout ⇒ not), so
 * re-deriving it from `httpStatus` a second time here would be a second,
 * possibly-diverging copy of the same rule.
 *
 * @module
 */
import {
  ApiError,
  type ConnectionSummary,
  type FunctionSummary,
  type W6WClient,
  type WorkflowSummary,
} from "@w6w/sdk";
import type {
  ActionDef,
  ActionParam,
  ApiCallRecord,
  AppSummary,
  AuthDef,
  ConnectionCreateInput,
  CredentialDependents,
  CredentialSummary,
  CredentialTestResult,
  InvokeOptions,
  SavedTest,
  StepTest,
  Subscription,
  TestRunSummary,
  TriggerDef,
} from "@w6w/sdk/console";

/**
 * The `@w6w/ui` `W6WApi` contract, hand-duplicated — see this module's
 * header. Every member's signature mirrors `provider.tsx:87-231`'s member of
 * the same name.
 */
/**
 * Options for {@link W6WApi.listAppsPage} — one bounded, server-paged
 * request. Every member is optional; an omitted member is a host-defined
 * default (usually "no filter"/"first page"), never a client-side guess.
 * Hand-duplicated verbatim from `packages/ui/src/provider.tsx` — see this
 * module's header.
 */
export interface ListAppsPageOptions {
  /** Full-text search term, forwarded to the server verbatim. */
  q?: string;
  /** Server-side category filter (e.g. `"ai"`). */
  category?: string;
  /** Opaque pagination cursor from a prior {@link AppsPageResult.nextCursor}. */
  cursor?: string;
  /** Snapshot token from a prior {@link AppsPageResult.snapshot}; sent with `offset`, not with `cursor`. */
  snapshot?: string;
  /** Zero-based offset into the snapshot; `0` is sent. */
  offset?: number;
  /** Page size; a host may clamp this to its own bounds. */
  limit?: number;
  /** Ask the host for a bounded picker-summary projection (heavy fields like inline icons may be trimmed). */
  compact?: boolean;
  /** Abort this request. Local request control only; never a wire field. */
  signal?: AbortSignal;
}

/** One page of apps, as returned by {@link W6WApi.listAppsPage}. */
export interface AppsPageResult {
  apps: AppSummary[];
  /** Present unless this is the last page. */
  nextCursor?: string;
  /** The snapshot token this page was cut from. */
  snapshot?: string;
  /** Total number of apps in the snapshot. */
  total?: number;
  /** Zero-based offset of this page's first app within the snapshot. */
  offset?: number;
  /** The page size the server applied. */
  limit?: number;
  /** ISO timestamp after which the snapshot may be gone. */
  expiresAt?: string;
}

/**
 * One step of a Workflow, as {@link W6WApi.getWorkflow} returns it — the
 * minimal shape the Configure stage needs to find the entry/trigger step's
 * own declared `with` fields. Hand-duplicated verbatim from
 * `packages/ui/src/types.ts`'s `WorkflowStepSummary` — see this module's
 * header.
 */
export interface WorkflowStepSummary {
  id: string;
  uses: { app: string; action: string };
  with?: Record<string, unknown>;
}

/**
 * A Workflow's full definition, as {@link W6WApi.getWorkflow} returns it.
 * Hand-duplicated verbatim from `packages/ui/src/types.ts`'s
 * `WorkflowDetail` — see this module's header.
 */
export interface WorkflowDetail {
  id: string;
  name: string;
  displayName?: string;
  description?: string;
  steps: WorkflowStepSummary[];
}

/**
 * A Function's canonical interface, as {@link W6WApi.getFunction} returns
 * it. Hand-duplicated verbatim from `packages/ui/src/types.ts`'s
 * `FunctionDetail` — see this module's header.
 */
export interface FunctionDetail {
  id: string;
  key: string;
  displayName?: string;
  description?: string;
  inputs: ActionParam[];
  valid: boolean;
}

/** The three things a host can call by name. */
export type CallableKind = "workflow" | "function" | "endpoint";

/** One callable, normalised across the three lists. */
export interface CallableRef {
  kind: CallableKind;
  id: string;
  name: string;
  tags: string[];
}

/** An explicit host-key binding: which callable, which trigger (workflows), which input field. */
export interface CallableBinding {
  kind: CallableKind;
  callableId: string;
  entry?: string;
  field: string;
}

export interface W6WApi {
  /** List registered apps to pick from in the connection modal. */
  listApps(): Promise<AppSummary[]>;

  /**
   * Fetch ONE bounded, server-paged slice of the app catalog — the seam every
   * bounded picker UI (`AppPicker`'s paged mode, `StepBuilderModal`'s
   * Apps/AI/Triggers tabs) prefers over {@link listApps} when a host
   * implements it. OPTIONAL and ADDITIVE: an older/imported provider that
   * only implements `listApps` still typechecks and simply keeps the
   * eager-list behavior everywhere this member is absent.
   */
  listAppsPage?(options?: ListAppsPageOptions): Promise<AppsPageResult>;

  /**
   * Resolve a bounded, explicit set of app ids to their summaries — the seam
   * behind the "Ready to use" tab's connected-app batching and
   * `AddConnectionModal`'s `initialAppId` resolution: a caller that already
   * knows exactly which ids it needs never has to fetch (or filter) the whole
   * catalog to find them. OPTIONAL, like {@link listAppsPage}: absent, a
   * caller falls back to its pre-existing `listApps`-based resolution.
   * Missing/404 ids are simply omitted from the result, never an error for
   * the whole batch.
   */
  listAppsByIds?(ids: readonly string[], options?: { signal?: AbortSignal }): Promise<AppSummary[]>;

  /** Load auth methods declared by an app's manifest, with availability flags. */
  getAppAuth(appId: string): Promise<AuthDef[]>;

  /** Create a non-OAuth connection with a user-supplied credential. */
  createConnection(appId: string, body: ConnectionCreateInput): Promise<ConnectionSummary>;

  /**
   * Start an OAuth 2.0 flow. Server builds the provider's authorize URL and
   * returns it; the caller opens it in a popup and awaits the server's
   * callback message — that popup/message flow is `@w6w/ui`'s concern
   * (`oauth-popup.ts`), unchanged by this bridge. `autoRefresh: false` turns
   * background keep-alive off for the connection the callback creates.
   */
  startAppOAuthFlow(
    appId: string,
    authKey: string,
    body: { displayName?: string; autoRefresh?: boolean },
  ): Promise<{ authorizationUrl: string }>;

  /** List the actions an app exposes, to pick from in the step builder. */
  getAppActions(appId: string): Promise<ActionDef[]>;

  /** List the connections that already exist for a given app. */
  listConnectionsForApp(appId: string): Promise<ConnectionSummary[]>;

  /** List every connection across apps — drives the "Connected apps" tab. */
  listConnections(): Promise<ConnectionSummary[]>;

  /** List stored credentials; only the given filter keys are sent. */
  listCredentials(filter?: {
    contract?: string;
    appId?: string;
    authKey?: string;
  }): Promise<CredentialSummary[]>;

  /** Create a stored credential. `source` is an opaque secret payload. */
  createCredential(body: {
    name: string;
    contract: string;
    source: Record<string, unknown>;
  }): Promise<CredentialSummary>;

  /** Fetch one stored credential. */
  getCredential(id: string): Promise<CredentialSummary>;

  /** Replace a credential's secret. */
  rotateCredential(
    id: string,
    body: { source: Record<string, unknown> },
  ): Promise<CredentialSummary>;

  /** `"disabled"` → `POST /disable`, `"active"` → `POST /enable`. */
  setCredentialStatus(id: string, status: "active" | "disabled"): Promise<CredentialSummary>;

  /** Probe a credential; `ok: false` resolves (it is data, not an error). */
  testCredential(id: string): Promise<CredentialTestResult>;

  /** The connections that use a credential. */
  credentialDependents(id: string): Promise<CredentialDependents>;

  /**
   * Delete a credential. A 409 `credential_in_use` rejects with `.body`
   * carrying the dependents at `body.error.dependents.connections`.
   */
  deleteCredential(id: string): Promise<void>;

  /**
   * Invoke a single action — used to test-run one step from the visual
   * editor. `opts.connectionId` runs with a stored connection's credential;
   * `opts.project` scopes document/var expressions; `opts.state` seeds
   * `steps.<id>.output` / `trigger.event` so upstream references resolve
   * instead of the empty string. `apiCalls` carries the outbound HTTP calls
   * the action made (redacted); a failed invoke rejects with an error whose
   * `.body` holds the same field (see `withApiErrorBody` below).
   */
  invokeAction(
    appId: string,
    actionKey: string,
    params: Record<string, unknown>,
    opts?: InvokeOptions,
  ): Promise<{ value: unknown; logs?: string[]; apiCalls?: ApiCallRecord[] }>;

  /** List the saved action-test inputs stored against a connection. */
  listSavedTests(connectionId: string): Promise<SavedTest[]>;

  /** Save a new set of action-test inputs against a connection. */
  createSavedTest(
    connectionId: string,
    body: { actionKey: string; name: string; values: Record<string, unknown> },
  ): Promise<SavedTest>;

  /** Rename a saved test or replace its stored input values. */
  updateSavedTest(
    connectionId: string,
    id: string,
    patch: { name?: string; values?: Record<string, unknown> },
  ): Promise<SavedTest>;

  /** Delete a saved test by id. */
  deleteSavedTest(connectionId: string, id: string): Promise<void>;

  /**
   * Record the outcome of an action-test run against a connection. Appends a
   * run-log row server-side; when `savedTestId` is present the saved test's
   * `lastRun*` fields are updated too.
   */
  recordTestRun(
    connId: string,
    body: {
      savedTestId?: string | null;
      actionKey: string;
      ok: boolean;
      summary?: string;
      result?: unknown;
    },
  ): Promise<void>;

  /** List a connection's recent tester-run history from the unified run ledger. */
  listTestRuns(connectionId: string): Promise<TestRunSummary[]>;

  /**
   * Save a reusable per-step test fixture against a workflow step. Captures
   * the resolved incoming state (`input`) and the step's params (`with`).
   */
  saveStepTest(
    workflowId: string,
    stepId: string,
    body: { name?: string; input: Record<string, unknown>; with: Record<string, unknown> },
  ): Promise<StepTest>;

  /**
   * Record the outcome of a step-test run. When `stepTestId` is present, the
   * fixture's `lastRun*` fields are updated too.
   */
  recordStepTestRun(
    workflowId: string,
    stepId: string,
    body: {
      stepTestId?: string | null;
      status: string;
      input?: unknown;
      output?: unknown;
      error?: unknown;
    },
  ): Promise<void>;

  /** List the saved test fixtures for a workflow step. */
  listStepTests(workflowId: string, stepId: string): Promise<StepTest[]>;

  /** List the apps whose latest version declares at least one trigger. */
  listTriggerApps(): Promise<AppSummary[]>;

  /** List an app's declared triggers, to pick from in the Triggers tab. */
  getAppTriggers(appId: string): Promise<TriggerDef[]>;

  /** List the subscriptions (trigger bindings) already bound to one workflow. */
  listSubscriptionsForWorkflow(workflowId: string): Promise<Subscription[]>;

  /** Bind an app's trigger to a workflow. */
  createSubscription(
    appId: string,
    triggerKey: string,
    input: { workflowId: string; connectionId?: string | null; params?: Record<string, unknown> },
  ): Promise<Subscription>;

  /** List the caller's registered Functions — drives the step builder's Functions tab. */
  listFunctions(): Promise<FunctionSummary[]>;

  /** Load one Function's canonical interface, for the Functions tab's Configure stage. */
  getFunction(id: string): Promise<FunctionDetail>;

  /** Invoke a Function directly — the Functions tab's Test stage. Returns the raw output. */
  invokeFunction(id: string, inputs: Record<string, unknown>): Promise<unknown>;

  /** List the caller's registered Workflows — drives the step builder's Workflows tab. */
  listWorkflows(): Promise<WorkflowSummary[]>;

  /** Load one Workflow's full definition, for the Workflows tab's Configure stage. */
  getWorkflow(id: string): Promise<WorkflowDetail>;

  /**
   * Run a Workflow synchronously — the Workflows tab's Test stage. Always the
   * SAME `?wait=true` path a saved `@w6w/call` step takes at run time, never
   * a client-side enqueue-and-poll. `terminal` is derived from the run's own
   * status (`200` ⇒ `true`, the server's `202` wait-timeout ⇒ `false` — a
   * legitimate "still running" outcome, not an error).
   */
  runWorkflow(
    id: string,
    opts?: {
      variables?: Record<string, unknown>;
      input?: Record<string, unknown>;
      entry?: string;
    },
  ): Promise<{
    runId: string;
    status: string;
    output?: unknown;
    error?: unknown;
    terminal: boolean;
  }>;

  /**
   * Optional. All callables (workflows, Functions, Endpoints) carrying `tag` (equal, or a
   * `.`-bounded prefix), merged with their `kind`.
   */
  listCallables?(opts: { tag?: string }): Promise<CallableRef[]>;

  /** Optional. Run an Endpoint with `input` as its whole input. */
  invokeEndpoint?(idOrKey: string, input: Record<string, unknown>): Promise<unknown>;

  /** Optional. The explicit binding saved under `hostKey`, or `null` when none. */
  getCallableBinding?(hostKey: string): Promise<CallableBinding | null>;

  /** Optional. Create or replace the explicit binding saved under `hostKey`. */
  saveCallableBinding?(hostKey: string, binding: CallableBinding): Promise<void>;
}

/** The document key an explicit binding lives under — a user-visible, editable namespace. */
export function callableBindingKey(hostKey: string): string {
  return `callable-binding/${hostKey}`;
}

/**
 * The one place a list `tag` is normalised: trimmed, and an absent/empty/whitespace tag becomes
 * `undefined` ("no filter"), so no list request ever carries an empty `?tag=`.
 */
export function normalizeTag(tag: string | undefined | null): string | undefined {
  const trimmed = tag?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * `listCallables` over a client: the three tag-filtered lists, merged (all callables when `tag` is
 * empty). Failure of any list rejects.
 */
export async function listCallablesFor(
  client: W6WClient,
  rawTag: string | undefined,
  signal?: AbortSignal,
): Promise<CallableRef[]> {
  const tag = normalizeTag(rawTag);
  const [workflows, functions, endpoints] = await Promise.all([
    client.workflows.list({ tag, signal }),
    client.functions.list({ tag, signal }),
    client.endpoints.list({ tag, signal }),
  ]);
  return [
    ...workflows.map((w) => ({
      kind: "workflow" as const,
      id: w.id,
      name: w.displayName,
      tags: w.tags,
    })),
    ...functions.map((f) => ({
      kind: "function" as const,
      id: f.id,
      name: f.displayName,
      tags: f.tags,
    })),
    ...endpoints.map((e) => ({
      kind: "endpoint" as const,
      id: e.id,
      name: e.displayName,
      tags: e.tags,
    })),
  ];
}

/**
 * Run a callable by kind — P4's request, exactly. Workflow: `{ entry, input }` with `wait: true`;
 * Function: the payload as `inputs`; Endpoint: the payload as `input`. `entry` (which manual
 * trigger) is the caller's choice; it is never derived here and `allowUnpublished` is never set.
 */
export function runCallableFor(
  client: W6WClient,
  kind: CallableKind,
  id: string,
  input: Record<string, unknown>,
  entry?: string,
): Promise<unknown> {
  if (kind === "workflow") {
    return client.workflows.run(id, {
      wait: true,
      input,
      ...(entry !== undefined ? { entry } : {}),
    });
  }
  if (kind === "function") return client.functions.run(id, { payload: input });
  return client.endpoints.run(id, { payload: input });
}

/** Read the binding document; a missing key (404) is `null`, anything else rejects. */
export async function getCallableBindingFor(
  client: W6WClient,
  hostKey: string,
  signal?: AbortSignal,
): Promise<CallableBinding | null> {
  try {
    const doc = await client.documents.getByKey(callableBindingKey(hostKey), {
      signal,
    });
    return JSON.parse(doc.content) as CallableBinding;
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  }
}

/** Create the binding document, or update it in place when the key already exists. */
export async function saveCallableBindingFor(
  client: W6WClient,
  hostKey: string,
  binding: CallableBinding,
): Promise<void> {
  const key = callableBindingKey(hostKey);
  const content = JSON.stringify(binding);
  let existing: { id: string } | null = null;
  try {
    existing = await client.documents.getByKey(key);
  } catch (err) {
    if (!(err instanceof ApiError && err.status === 404)) throw err;
  }
  if (existing) await client.documents.update(existing.id, { content, format: "json" });
  else await client.documents.create({ key, content, format: "json" });
}

/**
 * Alias `@w6w/sdk`'s `ApiError.raw` onto `.body` (`err.body === err.raw`, not
 * a copy) before an error reaches the caller — the field name every
 * duck-typing consumer of `@w6w/ui`'s own `ApiError` shape expects
 * (`packages/ui/src/createW6WApi.ts:29-44`). `ApiError.name` is already
 * `"ApiError"` on `@w6w/sdk`'s own class (`node/src/errors.ts`); nothing to
 * add there.
 *
 * Does **not**, and cannot, fix `ActionTestForm.tsx:149,176`'s NOMINAL
 * `instanceof ApiError` check against `@w6w/ui`'s own class — no object built
 * here can ever satisfy a check against a different class without importing
 * `@w6w/ui`, which C-1 forbids. Filed as a `packages/ui` follow-up
 * (`.ai/projects/backlog/26-08-13-01-ui-error-nominal-check.md`); see README
 * "Known limitations".
 *
 * ONE shared helper, not reimplemented per member — every adapter call below
 * routes through this.
 */
async function withApiErrorBody<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ApiError) {
      (err as ApiError & { body?: unknown }).body = err.raw;
    }
    throw err;
  }
}

/** Build a `W6WApi` implementation over an existing `W6WClient`. See this module's header. */
export function createW6WUiAdapter(client: W6WClient): W6WApi {
  return {
    listApps: () => withApiErrorBody(() => client.console.apps.list()),

    listAppsPage: (options = {}) =>
      withApiErrorBody(async () => {
        const page = await client.console.apps.listPage({
          q: options.q,
          category: options.category,
          cursor: options.cursor,
          snapshot: options.snapshot,
          offset: options.offset,
          limit: options.limit,
          compact: options.compact,
          signal: options.signal,
        });
        return {
          apps: page.apps,
          nextCursor: page.nextCursor,
          snapshot: page.snapshot,
          total: page.total,
          offset: page.offset,
          limit: page.limit,
          expiresAt: page.expiresAt,
        };
      }),

    // Delegates to the public `client.apps.byIds` (R-18): it dedupes, resolves
    // `[]` with no request, chunks to the server's 100-id cap and issues the
    // chunks concurrently, so the adapter carries none of that logic itself.
    listAppsByIds: (ids, options) =>
      withApiErrorBody(() => client.apps.byIds(ids, { signal: options?.signal })),

    getAppAuth: (appId) => withApiErrorBody(() => client.console.apps.getAuth(appId)),

    createConnection: (appId, body) =>
      withApiErrorBody(() => client.console.connections.create(appId, body)),

    startAppOAuthFlow: (appId, authKey, body) =>
      withApiErrorBody(() => client.console.apps.startOAuthFlow(appId, authKey, body)),

    getAppActions: (appId) => withApiErrorBody(() => client.console.apps.getActions(appId)),

    listConnectionsForApp: (appId) =>
      withApiErrorBody(() => client.console.connections.listForApp(appId)),

    // Deliberately the BASE `client.connections.list()`, never
    // `console.connections` — there is no `console.connections.list()` at all
    // (only `listForApp`, which is scoped to one app). Do not "fix" this into
    // console-namespace consistency; that would silently narrow "every
    // connection across every app" down to one app's connections.
    listConnections: () => withApiErrorBody(() => client.connections.list()),

    listCredentials: (filter) => withApiErrorBody(() => client.console.credentials.list(filter)),
    createCredential: (body) => withApiErrorBody(() => client.console.credentials.create(body)),
    getCredential: (id) => withApiErrorBody(() => client.console.credentials.get(id)),
    rotateCredential: (id, body) =>
      withApiErrorBody(() => client.console.credentials.rotate(id, body)),
    setCredentialStatus: (id, status) =>
      withApiErrorBody(() =>
        status === "disabled"
          ? client.console.credentials.disable(id)
          : client.console.credentials.enable(id),
      ),
    testCredential: (id) => withApiErrorBody(() => client.console.credentials.test(id)),
    credentialDependents: (id) => withApiErrorBody(() => client.console.credentials.dependents(id)),
    deleteCredential: (id) => withApiErrorBody(() => client.console.credentials.delete(id)),

    invokeAction: (appId, actionKey, params, opts) =>
      withApiErrorBody(() => client.console.apps.invoke(appId, actionKey, params, opts)),

    listSavedTests: (connectionId) =>
      withApiErrorBody(() => client.console.savedTests.list(connectionId)),

    createSavedTest: (connectionId, body) =>
      withApiErrorBody(() => client.console.savedTests.create(connectionId, body)),

    updateSavedTest: (connectionId, id, patch) =>
      withApiErrorBody(() => client.console.savedTests.update(connectionId, id, patch)),

    deleteSavedTest: (connectionId, id) =>
      withApiErrorBody(() => client.console.savedTests.delete(connectionId, id)),

    // The SDK returns the real created `SavedTestRun`; `W6WApi.recordTestRun`
    // is pinned `Promise<void>` — discard, don't drop the call.
    recordTestRun: (connId, body) =>
      withApiErrorBody(() =>
        client.console.savedTests.recordTestRun(connId, body).then(() => undefined),
      ),

    listTestRuns: (connectionId) =>
      withApiErrorBody(() => client.console.savedTests.listTestRuns(connectionId)),

    saveStepTest: (workflowId, stepId, body) =>
      withApiErrorBody(() => client.console.stepTests.save(workflowId, stepId, body)),

    // Same discard as `recordTestRun` above.
    recordStepTestRun: (workflowId, stepId, body) =>
      withApiErrorBody(() =>
        client.console.stepTests.recordRun(workflowId, stepId, body).then(() => undefined),
      ),

    listStepTests: (workflowId, stepId) =>
      withApiErrorBody(() => client.console.stepTests.list(workflowId, stepId)),

    // Same predicate studio's own facade uses (T2.1.1), so the two embedding
    // paths cannot disagree on which apps have a trigger to offer.
    listTriggerApps: () =>
      withApiErrorBody(async () => {
        const apps = await client.console.apps.list();
        return apps.filter((a) => (a.triggerCount ?? 0) > 0);
      }),

    getAppTriggers: (appId) => withApiErrorBody(() => client.console.apps.getTriggers(appId)),

    listSubscriptionsForWorkflow: (workflowId) =>
      withApiErrorBody(() => client.console.subscriptions.listForWorkflow(workflowId)),

    // `input` is forwarded verbatim as the whole POST body.
    createSubscription: (appId, triggerKey, input) =>
      withApiErrorBody(() => client.console.subscriptions.create(appId, triggerKey, input)),

    // The BASE `client.functions.*`/`client.workflows.*` surface from here
    // down — never `console.*`. See this module's header.
    listFunctions: () => withApiErrorBody(() => client.functions.list()),

    getFunction: (id) =>
      withApiErrorBody(async () => {
        const { function: fn, valid } = await client.functions.get(id);
        const def = fn as {
          id: string;
          key: string;
          displayName?: string;
          description?: string;
          inputs?: ActionParam[];
        };
        return {
          id: def.id,
          key: def.key,
          displayName: def.displayName,
          description: def.description,
          inputs: def.inputs ?? [],
          valid,
        };
      }),

    // `inputs` is forwarded as the whole `payload` — the Function's canonical
    // inputs object, matching `client.functions.run`'s own `{payload}` shape
    // (`node/src/functions.ts`), which POSTs `{inputs: payload}`.
    invokeFunction: (id, inputs) =>
      withApiErrorBody(() => client.functions.run(id, { payload: inputs })),

    listWorkflows: () => withApiErrorBody(() => client.workflows.list()),

    getWorkflow: (id) =>
      withApiErrorBody(async () => {
        const { workflow } = await client.workflows.get(id);
        const def = workflow as {
          id: string;
          name: string;
          displayName?: string;
          description?: string;
          nodes?: WorkflowStepSummary[];
          steps?: WorkflowStepSummary[];
        };
        return {
          id: def.id,
          name: def.name,
          displayName: def.displayName,
          description: def.description,
          steps: def.nodes ?? def.steps ?? [],
        };
      }),

    // Always `wait: true` — see this module's header for why `terminal` is
    // forwarded from `client.workflows.run`'s own result rather than
    // re-derived from `httpStatus` a second time.
    runWorkflow: (id, opts) =>
      withApiErrorBody(async () => {
        const result = await client.workflows.run(id, { ...opts, wait: true });
        return {
          runId: result.runId,
          status: result.status,
          output: result.output,
          error: result.error,
          terminal: result.terminal,
        };
      }),

    listCallables: ({ tag }) => withApiErrorBody(() => listCallablesFor(client, tag)),

    invokeEndpoint: (idOrKey, input) =>
      withApiErrorBody(() => runCallableFor(client, "endpoint", idOrKey, input)),

    getCallableBinding: (hostKey) => withApiErrorBody(() => getCallableBindingFor(client, hostKey)),

    saveCallableBinding: (hostKey, binding) =>
      withApiErrorBody(() => saveCallableBindingFor(client, hostKey, binding)),
  };
}
