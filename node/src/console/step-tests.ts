/**
 * `client.console.stepTests.*` — reusable, workflow-step-scoped test
 * fixtures for a step's resolved incoming state (`input`) and its params
 * (`with`), plus their run-log, relocated from the studio's own API client.
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
 * Three methods relocate from the studio's own `// Saved per-step tests`
 * comment block (`packages/studio/src/api/client.ts:317-351` on the studio
 * base tree) — field-for-field, not redesigned. Method names here are
 * SHORTENED versus `client.ts`'s flat names (`saveStepTest` → `save`,
 * `listStepTests` → `list`, `recordStepTestRun` → `recordRun`), mirroring
 * `console.connections.listForApp`/`console.workflows.get`'s own convention:
 * the domain prefix (`console.stepTests.*`) already disambiguates.
 *
 * **`PATCH`/`DELETE /workflows/:workflowId/steps/:stepId/tests/:id` also
 * exist server-side but have ZERO client-side coverage anywhere (studio or
 * `@w6w/ui`) — deliberately NOT wrapped here.** Same disposition prior
 * console domains already established for their own orphan routes
 * (HITL-4's philosophy applied one step further).
 *
 * **`recordRun` returns the REAL created row, not `void`.** Studio's current
 * `client.ts` discards it to `void` (`.then(() => {})`) only so its `api`
 * object stays assignable to `@w6w/ui`'s `W6wApi.recordStepTestRun` (typed
 * `Promise<void>`, `packages/ui/src/provider.tsx:211-221`) — that is
 * STUDIO's constraint, not the SDK's. Mirrors `./saved-tests.ts`'s
 * `recordTestRun` exactly; the void-discard happens at studio's own repo
 * layer (`src/repos/step-tests.ts`, a later task), not here.
 *
 * None of these methods take a `project` scoping parameter — step tests
 * carry no `?project=`, the server scopes by workflow/tenant — so
 * `StepTestsHost` needs only the transport, mirroring `ConnectionsHost`, not
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
export interface StepTestsHost {
  /** Perform one request. */
  request<T>(options: RequestOptions): Promise<HttpResponse<T>>;
}

/**
 * A saved per-step test fixture — a reusable, project-owned named capture of
 * a workflow step's resolved incoming state (`input`) and its params
 * (`with`), keyed by `(workflowId, stepId)`. Mirrors the connection-scoped
 * `SavedTest`, re-keyed to a workflow step. `lastRun*` denormalizes the most
 * recent run.
 */
export interface StepTest {
  id: string;
  workflowId: string;
  stepId: string;
  name: string | null;
  input: Record<string, unknown>;
  with: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  lastRunAt?: string | null;
  lastRunStatus?: string | null;
  lastRunError?: unknown;
  lastRunOutput?: unknown;
}

/** The real row `recordRun` creates (mirrors the server's `StepTestRun`). */
export interface StepTestRun {
  id: string;
  stepTestId: string | null;
  workflowId: string;
  stepId: string;
  status: string;
  input: unknown;
  output: unknown;
  error: unknown;
  createdAt: string;
}

/**
 * The `console.stepTests` namespace on a `W6wClient`.
 *
 * @example
 * ```ts
 * const fixture = await client.console.stepTests.save("wf_1", "nd_1", {
 *   input: { foo: "bar" },
 *   with: { to: "a@b.com" },
 * });
 * const fixtures = await client.console.stepTests.list("wf_1", "nd_1");
 * const run = await client.console.stepTests.recordRun("wf_1", "nd_1", {
 *   stepTestId: fixture.id,
 *   status: "succeeded",
 *   output: { ok: true },
 * });
 * ```
 */
export class StepTestsApi {
  readonly #host: StepTestsHost;

  /**
   * @param host - The client this namespace issues requests through.
   */
  constructor(host: StepTestsHost) {
    this.#host = host;
  }

  /**
   * Save a step-test fixture.
   *
   * @param workflowId - The `wf_…` id.
   * @param stepId - The step's id within that workflow.
   * @param body - Optional `name`, plus `input`/`with`, forwarded verbatim.
   * @returns The created step test, unwrapped from the `stepTest` envelope (the server answers `201`).
   * @throws {ApiError} `400 invalid_name`/`invalid_input`/`invalid_with`;
   * `404 unknown_workflow`.
   */
  async save(
    workflowId: string,
    stepId: string,
    body: { name?: string; input: Record<string, unknown>; with: Record<string, unknown> },
  ): Promise<StepTest> {
    const res = await this.#host.request<unknown>({
      method: "POST",
      path: path`/workflows/${workflowId}/steps/${stepId}/tests`,
      body,
    });
    return unwrap<StepTest>(res, "stepTest");
  }

  /**
   * List a step's saved test fixtures.
   *
   * @param workflowId - The `wf_…` id.
   * @param stepId - The step's id within that workflow.
   * @returns The step tests, unwrapped from the `stepTests` envelope.
   */
  async list(workflowId: string, stepId: string): Promise<StepTest[]> {
    const res = await this.#host.request<unknown>({
      method: "GET",
      path: path`/workflows/${workflowId}/steps/${stepId}/tests`,
    });
    return unwrap<StepTest[]>(res, "stepTests");
  }

  /**
   * Record the outcome of a step-test run. Appends a `step_test_runs` row
   * (and a best-effort `run_log` ledger row) server-side; when `stepTestId`
   * is present, the fixture's `lastRun*` fields are updated too.
   *
   * Returns the REAL created row — see this module's header. Does NOT
   * discard to `void`; a caller wanting the studio-facade `void` shape
   * adapts it themselves.
   *
   * @param workflowId - The `wf_…` id.
   * @param stepId - The step's id within that workflow.
   * @param body - `stepTestId` (optional), `status`, and optional
   * `input`/`output`/`error`, forwarded verbatim.
   * @returns The created `StepTestRun`, unwrapped from the `run` envelope (the server answers `201`).
   * @throws {ApiError} `400 invalid_body`/`invalid_status`. No `404` — the
   * route never checks the workflow/step exist before writing.
   */
  async recordRun(
    workflowId: string,
    stepId: string,
    body: {
      stepTestId?: string | null;
      status: string;
      input?: unknown;
      output?: unknown;
      error?: unknown;
    },
  ): Promise<StepTestRun> {
    const res = await this.#host.request<unknown>({
      method: "POST",
      path: path`/workflows/${workflowId}/steps/${stepId}/test-runs`,
      body,
    });
    return unwrap<StepTestRun>(res, "run");
  }
}
