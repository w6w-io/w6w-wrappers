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
 * @module
 */
import { ApiError, type ConnectionSummary, type W6WClient } from "@w6w/sdk";
import type {
  ActionDef,
  ApiCallRecord,
  AppSummary,
  AuthDef,
  InvokeOptions,
  SavedTest,
  StepTest,
  TestRunSummary,
} from "@w6w/sdk/console";

/**
 * The `@w6w/ui` `W6WApi` contract, hand-duplicated — see this module's
 * header. Every member's signature mirrors `provider.tsx:87-231`'s member of
 * the same name.
 */
export interface W6WApi {
  /** List registered apps to pick from in the connection modal. */
  listApps(): Promise<AppSummary[]>;

  /** Load auth methods declared by an app's manifest, with availability flags. */
  getAppAuth(appId: string): Promise<AuthDef[]>;

  /** Create a non-OAuth connection with a user-supplied credential. */
  createConnection(
    appId: string,
    body: {
      authKey: string;
      credential: Record<string, unknown>;
      displayName?: string;
      profile?: Record<string, unknown>;
    },
  ): Promise<ConnectionSummary>;

  /**
   * Start an OAuth 2.0 flow. Server builds the provider's authorize URL and
   * returns it; the caller opens it in a popup and awaits the server's
   * callback message — that popup/message flow is `@w6w/ui`'s concern
   * (`oauth-popup.ts`), unchanged by this bridge.
   */
  startAppOAuthFlow(
    appId: string,
    authKey: string,
    body: { displayName?: string },
  ): Promise<{ authorizationUrl: string }>;

  /** List the actions an app exposes, to pick from in the step builder. */
  getAppActions(appId: string): Promise<ActionDef[]>;

  /** List the connections that already exist for a given app. */
  listConnectionsForApp(appId: string): Promise<ConnectionSummary[]>;

  /** List every connection across apps — drives the "Connected apps" tab. */
  listConnections(): Promise<ConnectionSummary[]>;

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
  };
}
