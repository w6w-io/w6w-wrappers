/**
 * `client.console.savedTests.*` — reusable, connection-scoped named test
 * inputs for an app action, plus the tester's run-log, relocated from the
 * studio's own API client.
 *
 * **Studio-internal, not the published partner contract.** This namespace
 * lives under the `console` subpath export (`@w6w/sdk/console`), excluded from
 * `endpoints.json` and from the root barrel (`mod.ts`) — see `docs/console.md`
 * and HITL-1 in this task's contract. `@w6w/sdk`'s instance-state mechanism
 * pin still applies here exactly as it does to every other namespace
 * (`docs/implementation.md` §MECHANISM PIN — instance state, never globals):
 * this class holds no state of its own beyond the injected host, so two
 * clients in one process never share a credential.
 *
 * Six methods relocate from the studio's own `// Saved tests` comment block
 * (`packages/studio/src/api/client.ts:259-315` on the studio base tree) —
 * field-for-field, not redesigned.
 *
 * **`recordTestRun` returns the REAL created row, not `void`.** Studio's
 * current `client.ts` discards it to `void` (`.then(() => {})`) only so its
 * `api` object stays assignable to `@w6w/ui`'s `W6wApi.recordTestRun`
 * (typed `Promise<void>`, `packages/ui/src/provider.tsx:168-177`) — that is
 * STUDIO's constraint, not the SDK's. Mirrors T2.2.1's `deleteApp` precedent:
 * a "complete client" returns genuinely informative data and discards only
 * boilerplate (`delete` below discards the true-boilerplate `{ok:true}`).
 * The void-discard for `recordTestRun` happens at studio's own repo layer
 * (`src/repos/saved-tests.ts`, a later task), not here.
 *
 * None of these methods take a `project` scoping parameter — saved tests
 * carry no `?project=`, the server scopes by connection/tenant — so
 * `SavedTestsHost` needs only the transport, mirroring `ConnectionsHost`, not
 * `DocumentsHost`.
 *
 * @module
 */

import { type HttpResponse, path, type RequestOptions } from "../http.ts";
import { unwrap } from "../types.ts";

/**
 * The slice of `W6wClient` this namespace needs: the transport, and nothing
 * else. Structural rather than a concrete client type, so the namespace stays
 * independently constructible in a test and this module never imports the
 * client back — mirrors `ConnectionsHost` in `./connections.ts`.
 */
export interface SavedTestsHost {
  /** Perform one request. */
  request<T>(options: RequestOptions): Promise<HttpResponse<T>>;
}

/**
 * A saved test — a named set of input values for an app action, scoped to a
 * connection. Lets a caller re-run an action with a remembered payload.
 */
export interface SavedTest {
  id: string;
  connectionId: string;
  appId: string;
  actionKey: string;
  name: string;
  values: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  /** When this saved test was last run (ISO), or null/undefined if never run. */
  lastRunAt?: string | null;
  /** Whether the most recent run succeeded, or null/undefined if never run. */
  lastRunOk?: boolean | null;
  /** Short headline for the most recent run's outcome, or null/undefined if never run. */
  lastRunSummary?: string | null;
}

/**
 * One row from a connection's `run_log`-backed test-run history (thin — NOT
 * the full `SavedTestRun` create response; the full `result` payload stays
 * server-side).
 */
export interface TestRunSummary {
  id: string;
  actionKey: string;
  ok: boolean;
  summary: string | null;
  occurredAt: string;
}

/** The real row `recordTestRun` creates (mirrors the server's `SavedTestRun`). */
export interface SavedTestRun {
  id: string;
  savedTestId: string | null;
  connectionId: string;
  appId: string;
  actionKey: string;
  ok: boolean;
  summary: string | null;
  result: unknown;
  createdAt: string;
}

/**
 * The `console.savedTests` namespace on a `W6wClient`.
 *
 * @example
 * ```ts
 * const tests = await client.console.savedTests.list("conn_1");
 * const created = await client.console.savedTests.create("conn_1", {
 *   actionKey: "send",
 *   name: "Happy path",
 *   values: { to: "a@b.com" },
 * });
 * const run = await client.console.savedTests.recordTestRun("conn_1", {
 *   savedTestId: created.id,
 *   actionKey: "send",
 *   ok: true,
 * });
 * await client.console.savedTests.delete("conn_1", created.id);
 * ```
 */
export class SavedTestsApi {
  readonly #host: SavedTestsHost;

  /**
   * @param host - The client this namespace issues requests through.
   */
  constructor(host: SavedTestsHost) {
    this.#host = host;
  }

  /**
   * List a connection's saved tests.
   *
   * @param connectionId - The `conn_…` id.
   * @returns The saved tests, unwrapped from the `savedTests` envelope.
   * @throws {ApiError} `404 unknown_connection` when there is no such connection.
   */
  async list(connectionId: string): Promise<SavedTest[]> {
    const res = await this.#host.request<unknown>({
      method: "GET",
      path: path`/connections/${connectionId}/saved-tests`,
    });
    return unwrap<SavedTest[]>(res, "savedTests");
  }

  /**
   * Create a saved test for a connection.
   *
   * @param connectionId - The `conn_…` id.
   * @param body - `actionKey` and `name` (unique per connection), plus the
   * `values` payload to remember — forwarded verbatim.
   * @returns The created saved test, unwrapped from the `savedTest` envelope (the server answers `201`).
   * @throws {ApiError} `400 invalid_name`/`invalid_action_key`/`invalid_values`;
   * `404 unknown_connection`; `409 duplicate_saved_test`.
   */
  async create(
    connectionId: string,
    body: { actionKey: string; name: string; values: Record<string, unknown> },
  ): Promise<SavedTest> {
    const res = await this.#host.request<unknown>({
      method: "POST",
      path: path`/connections/${connectionId}/saved-tests`,
      body,
    });
    return unwrap<SavedTest>(res, "savedTest");
  }

  /**
   * Update a saved test: rename it and/or replace its `values`.
   *
   * @param connectionId - The `conn_…` id.
   * @param id - The saved test's id.
   * @param patch - `name` and/or `values`, forwarded verbatim.
   * @returns The updated saved test, unwrapped from the `savedTest` envelope.
   * @throws {ApiError} `400 invalid_name`/`invalid_values`; `404 unknown_saved_test`;
   * `409 duplicate_saved_test`.
   */
  async update(
    connectionId: string,
    id: string,
    patch: { name?: string; values?: Record<string, unknown> },
  ): Promise<SavedTest> {
    const res = await this.#host.request<unknown>({
      method: "PATCH",
      path: path`/connections/${connectionId}/saved-tests/${id}`,
      body: patch,
    });
    return unwrap<SavedTest>(res, "savedTest");
  }

  /**
   * Delete a saved test.
   *
   * Returns nothing: the server's `{ok: true}` carries no information a
   * caller can use — true boilerplate, unlike {@linkcode recordTestRun}
   * below, which preserves its real row.
   *
   * @param connectionId - The `conn_…` id.
   * @param id - The saved test's id.
   * @throws {ApiError} `404 unknown_saved_test` when there is no such id.
   */
  async delete(connectionId: string, id: string): Promise<void> {
    await this.#host.request<unknown>({
      method: "DELETE",
      path: path`/connections/${connectionId}/saved-tests/${id}`,
    });
  }

  /**
   * Record the outcome of an action-test run against a connection. Appends a
   * run-log row server-side; when `savedTestId` is present, the saved test's
   * `lastRun*` fields are updated too.
   *
   * Returns the REAL created row — see this module's header. Does NOT
   * discard to `void`; a caller wanting the studio-facade `void` shape
   * adapts it themselves.
   *
   * @param connectionId - The `conn_…` id.
   * @param body - `savedTestId` (optional), `actionKey`, `ok`, and optional
   * `summary`/`result`, forwarded verbatim.
   * @returns The created `SavedTestRun`, unwrapped from the `run` envelope (the server answers `201`).
   * @throws {ApiError} `404 unknown_connection` when there is no such connection.
   */
  async recordTestRun(
    connectionId: string,
    body: {
      savedTestId?: string | null;
      actionKey: string;
      ok: boolean;
      summary?: string;
      result?: unknown;
    },
  ): Promise<SavedTestRun> {
    const res = await this.#host.request<unknown>({
      method: "POST",
      path: path`/connections/${connectionId}/test-runs`,
      body,
    });
    return unwrap<SavedTestRun>(res, "run");
  }

  /**
   * Run history for a connection from the unified `run_log` ledger — thin
   * rows; the full `result` payload from {@linkcode recordTestRun} stays
   * server-side.
   *
   * @param connectionId - The `conn_…` id.
   * @returns The runs, most-recent-first, unwrapped from the `runs` envelope.
   * @throws {ApiError} `404 unknown_connection` when there is no such connection.
   */
  async listTestRuns(connectionId: string): Promise<TestRunSummary[]> {
    const res = await this.#host.request<unknown>({
      method: "GET",
      path: path`/connections/${connectionId}/test-runs`,
    });
    return unwrap<TestRunSummary[]>(res, "runs");
  }
}
