/**
 * `client.console.workflows.*` — the workflow definition/lifecycle and run
 * surface (`get`, `upsert`, `archive`, `delete`, `listRuns`, `getRun`),
 * relocated from the studio's own API client.
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
 * **Console placement is the same precedent as `console.connections`'s
 * `HITL-10`, not a fresh judgment call — see `HITL.md` and `plan.md`'s SP2.3
 * section for the full investigation.** `endpoints.json`'s `outOfScope` array
 * names "all write operations on connections and workflows" together, with the
 * identical "in this version" framing HITL-10 already resolved for
 * connections. The server routes here (`admin/workflows.ts`) are, like
 * connections, plain stateless handlers over an already-resolved request
 * body/precondition header — no interactive flow the SDK method itself would
 * need to conduct. Console placement is safe for studio's own use; it does not
 * by itself justify promotion to the partner surface (cli/python lockstep; no
 * documented partner story exists yet either) — that promotion, if it ever
 * happens, is a dedicated future project.
 *
 * **That promotion has since happened, and this namespace deliberately stayed.**
 * At contract `0.5.0` the definition lifecycle left `outOfScope` and landed on
 * the BASE namespace in all three lanes — `client.workflows.get`/`create`/
 * `update`/`archive`/`delete` (`../workflows.ts`). The two surfaces now overlap
 * on four routes, and the split is by SHAPE, not by capability: the base methods
 * take a definition and answer the wire's own envelope, while these keep the
 * shapes studio's components are already written against (`upsert`'s single
 * definition-plus-precondition argument, `get`'s three-field body). New callers
 * — and every partner — want `client.workflows.*`. What is still ONLY here is
 * the run history: `listRuns` and `getRun` stay console-only, and
 * `endpoints.json` names `workflows.listRuns` in `outOfScope` so that stays
 * deliberate rather than accidental.
 *
 * **`list` and `run` are NOT part of this domain.** Both already exist on the
 * BASE namespace (`client.workflows.list()`/`client.workflows.run()`,
 * `../workflows.ts`) and studio reuses them verbatim — adding a duplicate
 * `list`/`run` under `console.workflows` would give a caller two ways to reach
 * the same route, exactly the anti-duplication defect this project's own
 * rules flag. **No poll loop lives here either**: `../workflows.ts`'s own
 * module doc pins "no client-side polling" for the whole package, and
 * `getRun` below is deliberately a single request with no retry — the caller
 * (studio's `lib/workflow-poll.ts`) owns the loop.
 *
 * Five of six methods relocate from the studio's `// Workflows` comment block
 * (`packages/studio/src/api/client.ts:254-331`): `getWorkflow`→`get`,
 * `createWorkflow`→`upsert`, `archiveWorkflow`→`archive`,
 * `deleteWorkflow`→`delete`, `listRuns`→`listRuns`. `getRun` is genuinely NEW
 * here — `client.ts`'s own `getRun` method is dead code today (zero callers),
 * but this task gives it a real consumer: `runWorkflow`'s poll loop, ported
 * into studio's `lib/workflow-poll.ts`, calls it.
 *
 * None of the six methods take a client-side default-project fallback — they
 * are addressed by `wf_…`/`run_…` id (plus an optional explicit `?project=`
 * on `upsert`), so `WorkflowsHost` needs only the transport, mirroring
 * `SchedulesHost`/`ProjectsHost`, not the BASE `WorkflowsHost` (`../workflows.ts`),
 * which additionally reads `config.project` as `list()`'s default.
 *
 * @module
 */

import { type HttpResponse, path, type RequestOptions } from "../http.ts";
import { type RunStatus, type StepError, unwrap } from "../types.ts";

/** The precondition header `upsert` sends when `ifUnmodifiedSince` is given. */
const PRECONDITION_HEADER = "x-w6w-if-unmodified-since";

/**
 * The slice of `W6WClient` this namespace needs: the transport, and nothing
 * else. Structural rather than a concrete client type, so the namespace stays
 * independently constructible in a test and this module never imports the
 * client back — mirrors `SchedulesHost` in `./schedules.ts`.
 */
export interface WorkflowsHost {
  /** Perform one request. */
  request<T>(options: RequestOptions): Promise<HttpResponse<T>>;
}

/**
 * A workflow run's full state, as `GET /runs/:id` returns it.
 *
 * Field-for-field, relocated from `packages/studio/src/api/types.ts:84-102`,
 * with ONE deliberate deviation from studio's local shape: `error` and `steps`
 * stay OPAQUE (`unknown`/`Record<string, unknown>`), matching this package's
 * own documented philosophy for `RunResult` (`../types.ts` — "a client that
 * modelled their internals would be wrong for someone"). Studio's local type
 * typed `error` as a structured `{code,message,…}` and `steps` as
 * `Record<string, StepExecution>`; that richer typing does not carry over
 * here, on purpose, for consistency with every other run-shaped type in this
 * package.
 *
 * Defined LOCALLY in this file, not in the shared `../types.ts`: it is
 * consumed only by console methods, never by base `run()`/`list()`, mirroring
 * where `Schedule`/`Project` live (inside their own `console/*.ts` files).
 */
export interface RunState {
  /** Server-issued run handle, `run_…`. */
  runId: string;
  /** The workflow this run belongs to. */
  workflowId: string;
  /** Where the run has got to. */
  status: RunStatus;
  /** Variables the run was started with. Opaque pass-through. */
  variables: Record<string, unknown>;
  /** Per-step state, keyed by step id. Opaque pass-through. */
  steps: Record<string, unknown>;
  /** The run's output when it finished; absent while it is still going. */
  output?: unknown;
  /** The run-level error when it failed; absent otherwise. Data, never a raised exception. Opaque pass-through. */
  error?: unknown;
  /** Per-step failures, when the server reports them. */
  stepErrors?: StepError[];
}

/**
 * One row of `listRuns`'s result — a run's summary, not its full state.
 *
 * Field-for-field, relocated from `packages/studio/src/api/types.ts:84-102`
 * (the summary subset). Defined LOCALLY, same reasoning as {@linkcode RunState}.
 */
export interface RunSummary {
  /** Server-issued run handle, `run_…`. */
  runId: string;
  /** Where the run has got to. */
  status: RunStatus;
  /** What triggered this run, e.g. `"manual"`, `"schedule"`, `"webhook"`. */
  trigger: string;
  /** ISO-8601 timestamp. */
  startedAt: string;
  /** ISO-8601 timestamp, or `null` while the run is still going. */
  finishedAt: string | null;
}

/**
 * The `console.workflows` namespace on a `W6WClient`.
 *
 * @example
 * ```ts
 * const { workflow, updatedAt } = await client.console.workflows.get("wf_1");
 * const saved = await client.console.workflows.upsert(workflow, { ifUnmodifiedSince: updatedAt });
 * const runs = await client.console.workflows.listRuns("wf_1");
 * const run = await client.console.workflows.getRun(runs[0].runId);
 * await client.console.workflows.archive("wf_1");
 * await client.console.workflows.delete("wf_1");
 * ```
 */
export class WorkflowsApi {
  readonly #host: WorkflowsHost;

  /**
   * @param host - The client this namespace issues requests through.
   */
  constructor(host: WorkflowsHost) {
    this.#host = host;
  }

  /**
   * Fetch one workflow's stored definition.
   *
   * `workflow` is the merged definition (the stored definition overlaid with
   * `status` and `tags`) — an arbitrary JSON object, never a fixed shape, kept
   * as `Record<string, unknown>` exactly as `client.ts` typed it. `updatedAt`
   * is TOP-LEVEL, never inside `workflow` — it is the optimistic-concurrency
   * token a save echoes back via {@linkcode upsert}'s `ifUnmodifiedSince`.
   *
   * No 404 special-casing — propagates as `ApiError` like every other "get" in
   * this package except `console.schedules.get`'s documented, unrelated
   * exception.
   *
   * @param id - The `wf_…` id.
   * @returns The whole response body — no envelope key to peel.
   * @throws {ApiError} `404 unknown_workflow` when there is no such id.
   */
  async get(
    id: string,
  ): Promise<{ workflow: Record<string, unknown>; sourceRef: string | null; updatedAt: string }> {
    const res = await this.#host.request<
      { workflow: Record<string, unknown>; sourceRef: string | null; updatedAt: string }
    >({
      method: "GET",
      path: path`/workflows/${id}`,
    });
    return res.body;
  }

  /**
   * Register (create or overwrite) a workflow definition.
   *
   * `definition` is the whole definition, sent verbatim as the request body —
   * not wrapped in an envelope key. `options.ifUnmodifiedSince` is the
   * optional optimistic-concurrency precondition: pass the exact `updatedAt`
   * this client last saw (from {@linkcode get}, or a prior `upsert`'s own
   * `updatedAt`) and the server rejects the write with `409 workflow_stale` if
   * the stored row has moved on since. Omitted, the save is last-write-wins
   * and the header is never sent at all — never as an empty or `"null"`
   * string, mirroring the server's own conditional exactly
   * (`admin/workflows.ts`).
   *
   * @param definition - The whole workflow definition, forwarded verbatim.
   * @param options - `project` scopes the write; `ifUnmodifiedSince` is the concurrency precondition.
   * @returns The new/updated workflow's id and name, whether a schedule was (re)applied, and the new `updatedAt`.
   * @throws {ApiError} `400 invalid_workflow`/`invalid_body`/`invalid_precondition`.
   * @throws {ApiError} `409 workflow_conflict` — another `(tenant,subject)` owns this id. NOT recoverable by reloading.
   * @throws {ApiError} `409 workflow_stale` — the precondition didn't match the stored `updatedAt`. IS recoverable by reloading and re-saving.
   */
  async upsert(
    definition: unknown,
    options?: { project?: string; ifUnmodifiedSince?: string | null },
  ): Promise<{ workflow: { id: string; name: string }; scheduled: boolean; updatedAt: string }> {
    const res = await this.#host.request<
      { workflow: { id: string; name: string }; scheduled: boolean; updatedAt: string }
    >({
      method: "POST",
      path: "/workflows",
      query: { project: options?.project },
      body: definition,
      ...(options?.ifUnmodifiedSince
        ? { headers: { [PRECONDITION_HEADER]: options.ifUnmodifiedSince } }
        : {}),
    });
    return res.body;
  }

  /**
   * Archive a workflow. One-way — no unarchive route exists anywhere on this
   * domain.
   *
   * Idempotent: archiving an already-archived workflow re-returns it
   * unchanged rather than erroring.
   *
   * @param id - The `wf_…` id.
   * @returns The archived workflow — no envelope key to peel.
   * @throws {ApiError} `404 unknown_workflow` when there is no such id.
   */
  async archive(id: string): Promise<{ workflow: Record<string, unknown> }> {
    const res = await this.#host.request<{ workflow: Record<string, unknown> }>({
      method: "POST",
      path: path`/workflows/${id}/archive`,
    });
    return res.body;
  }

  /**
   * Delete a workflow. Cascade-deletes its runs/schedules/subscriptions
   * server-side; nothing for the caller to do about that.
   *
   * The server requires archive-then-delete — deleting a workflow whose status
   * isn't `"archived"` yet answers `409 workflow_not_archived`, which this
   * method does NOT catch. That is a real signal the caller must handle;
   * enforcing archive-then-delete is not this method's job.
   *
   * Returns nothing: the server's `{ok: true}` carries no information a
   * caller can use.
   *
   * @param id - The `wf_…` id.
   * @throws {ApiError} `404 unknown_workflow` when there is no such id.
   * @throws {ApiError} `409 workflow_not_archived` when the workflow exists but is not archived yet.
   */
  async delete(id: string): Promise<void> {
    await this.#host.request<unknown>({ method: "DELETE", path: path`/workflows/${id}` });
  }

  /**
   * List a workflow's runs.
   *
   * @param id - The `wf_…` id.
   * @returns The runs, unwrapped from the `runs` envelope.
   * @throws {ApiError} `404 unknown_workflow` — an ownership gate: the workflow must belong to the caller.
   */
  async listRuns(id: string): Promise<RunSummary[]> {
    const res = await this.#host.request<unknown>({
      method: "GET",
      path: path`/workflows/${id}/runs`,
    });
    return unwrap<RunSummary[]>(res, "runs");
  }

  /**
   * Fetch one run's full state.
   *
   * **One request, one answer — no polling, no `wait`, no retry.** The caller
   * (studio's `lib/workflow-poll.ts`) owns the loop; see this module's header
   * and `../workflows.ts`'s own "no client-side polling" pin.
   *
   * @param runId - The `run_…` id.
   * @returns The run, unwrapped from the `run` envelope.
   * @throws {ApiError} `404 unknown_run` — covers both "no such run" and "not your workflow"; the caller cannot and does not need to distinguish them.
   */
  async getRun(runId: string): Promise<RunState> {
    const res = await this.#host.request<unknown>({
      method: "GET",
      path: path`/runs/${runId}`,
    });
    return unwrap<RunState>(res, "run");
  }
}
