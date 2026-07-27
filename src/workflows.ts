/**
 * `client.workflows.*` — discovery and the typed run.
 *
 * Two operations: `list` (T2.1.4) and `run` (T2.1.5). `list` earns its place in
 * a minimal surface for the same reason `connections.list` does (D4): it is how
 * a caller discovers a `wf_…` id to pass to `run`.
 *
 * ── `run`, and the three things this API gets called wrong ──
 * 1. **`202` is success.** No `wait` → the run is queued and the server answers
 *    `202 {runId, status:"queued"}`. With `?wait=true` and a timeout → `202`
 *    again, with the current status. Neither raises.
 * 2. **A failed run is data.** `?wait=true` on a run that failed is a plain
 *    `200` carrying `status: "failed"` and an `error`. This module returns it
 *    like any other result. Mapping it to an exit code is the CLI's job
 *    (`cli.exitCodes` in `endpoints.json`), not the SDK's.
 * 3. **No client-side polling.** The server already polls internally for
 *    `?wait=true`, up to its own `RUN_WAIT_TIMEOUT_SEC`. The studio's 600 × 500 ms
 *    browser loop predates that and is deliberately **not** transcribed
 *    (`docs/implementation.md` §4): three wrappers each re-implementing a poll
 *    would be three timeout policies and three retry-storm bugs to keep in sync.
 *    There is no timer, no delay and no retry anywhere in this package — a `202`
 *    hands the caller `runId` and lets them decide.
 *
 * Workflows are **project-scoped**, like documents and unlike vars: the route
 * accepts an optional `?project=`, resolved per call, then from the client's
 * default, and otherwise left to the server. This host therefore sees the
 * client's resolved configuration, which `connections` and `vars` deliberately
 * do not.
 *
 * ── Pagination ──
 * The route is **not paginated today** and this module does not pretend
 * otherwise: there is no `cursor` argument, no `cursor` field, and no
 * client-side paging loop. `list` returns the unwrapped array, exactly as
 * `docs/implementation.md` §6 pins it.
 *
 * That is not a corner this signature is painted into. A JavaScript array is an
 * object, so the day the server grows a cursor the wrapper can return an array
 * that carries it (`WorkflowSummary[] & {cursor?: string}`) and widen this
 * return type to match — every existing caller, which only ever reads the list,
 * keeps compiling and keeps working. Inventing the field now would put a key on
 * the type that no server has ever sent, which is the failure mode
 * `endpoints.json` actually warns about.
 *
 * @module
 */

import type { ResolvedConfig } from "./config.ts";
import { ApiError } from "./errors.ts";
import { type HttpResponse, path, type RequestOptions } from "./http.ts";
import {
  isTerminalRunStatus,
  type RunResult,
  type RunStatus,
  unwrap,
  type WorkflowSummary,
} from "./types.ts";

/**
 * The slice of `W6wClient` this namespace needs: the transport, plus the
 * resolved configuration it reads the **default project** out of. Structural
 * rather than a concrete client type, so the namespace stays independently
 * constructible in a test and this module never imports the client back.
 */
export interface WorkflowsHost {
  /** The resolved configuration; only `project` is read. */
  readonly config: ResolvedConfig;
  /** Perform one request. */
  request<T>(options: RequestOptions): Promise<HttpResponse<T>>;
}

/**
 * Per-call options for `workflows.list`.
 *
 * A named interface rather than a bare `project?: string` parameter, so the
 * operation can accept a further argument later without changing its arity.
 */
export interface WorkflowListOptions {
  /** Project id to scope this call to; overrides the client's default. */
  project?: string;
}

/**
 * Per-call options for `workflows.run`.
 *
 * **No `project` here, on purpose.** A `wf_…` id is unambiguous on its own, and
 * `endpoints.json` gives this operation exactly four parameters — `id`, `wait`,
 * `variables`, `trigger`. Sending a `?project=` the route does not read would be
 * inventing a parameter.
 */
export interface WorkflowRunOptions {
  /**
   * Wait for the run to reach a terminal state before answering.
   *
   * Sent as `?wait=true` **only when `true`**: the server compares the raw query
   * value to the string `"true"`, so `?wait=false` would mean the same thing as
   * omitting it while looking like it meant something else.
   *
   * The wait happens **server-side**, bounded by the server's own timeout. On a
   * timeout the answer is a `202` carrying the current status, which is a normal
   * outcome — see {@linkcode WorkflowRunResult.terminal}.
   */
  wait?: boolean;
  /** Variables handed to the run, merged into its scope by the engine. Opaque pass-through. */
  variables?: Record<string, unknown>;
  /**
   * What triggered the run; defaults to `"manual"` server-side.
   *
   * Typed as a plain `string` rather than a closed union: the value is a
   * server-owned enum (`"manual" | "schedule" | "webhook" | "event" | "replay"`
   * today) that the server may extend, and an SDK that froze the set would
   * reject a value a newer server accepts.
   */
  trigger?: string;
}

/**
 * What `workflows.run` returns: the server's flat body, plus two signals derived
 * locally.
 *
 * It **is** a `RunResult` — the wire fields are present under their wire names,
 * unwrapped from nothing (this route has no envelope). The two extra fields
 * exist because a caller otherwise cannot tell a queued run from a finished one
 * without re-deriving the rule:
 *
 * - {@linkcode terminal} answers "has this run finished?" from the **run's own
 *   status**, which is the question a caller actually has.
 * - {@linkcode httpStatus} is the transport's own answer (`200` finished in
 *   time, `202` still going), kept because it is the distinction the server
 *   makes and dropping it would leave a caller unable to tell a `?wait=` timeout
 *   from a run that was never waited on.
 */
export interface WorkflowRunResult extends RunResult {
  /** `true` when `status` is `succeeded`, `failed` or `canceled`. */
  terminal: boolean;
  /** The HTTP status that carried this body: `200` terminal, `202` queued or still running. */
  httpStatus: number;
}

/**
 * The `workflows` namespace on a `W6wClient`.
 *
 * @example
 * ```ts
 * const active = (await client.workflows.list()).filter((w) => w.status === "active");
 *
 * const run = await client.workflows.run(active[0].id, { wait: true });
 * if (run.status === "failed") console.error(run.error); // data, not an exception
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
   * List the caller's workflow definitions.
   *
   * The project this call is scoped to is the per-call argument first, then the
   * client's default, then nothing at all — an absent value means "no
   * `?project=`", which is how the caller asks for every project the credential
   * can see.
   *
   * @param options - Optional per-call project scope.
   * @returns The workflows, unwrapped from the `workflows` envelope.
   * @throws {ApiError} On any non-2xx.
   */
  async list(options?: WorkflowListOptions): Promise<WorkflowSummary[]> {
    const res = await this.#host.request<unknown>({
      method: "GET",
      path: "/workflows",
      query: { project: options?.project ?? this.#host.config.project ?? undefined },
    });
    return unwrap<WorkflowSummary[]>(res, "workflows");
  }

  /**
   * Start a run of one workflow, optionally waiting for it to finish.
   *
   * Returns on **both** success statuses this route uses:
   *
   * | Call | HTTP | Body | `terminal` |
   * |---|---|---|---|
   * | no `wait` | `202` | `{runId, status:"queued"}` | `false` |
   * | `wait: true`, finished in time | `200` | `{runId, status, output, error, steps}` | `true` |
   * | `wait: true`, timed out | `202` | `{runId, status}` | `false` |
   *
   * **A run that failed is the second row, not an error**: `200` with
   * `status: "failed"` and the failure in `error`. This method returns it. It
   * raises only when the *request* failed — `404 unknown_workflow`, a rejected
   * token, a transport failure.
   *
   * @param id - The `wf_…` id, percent-encoded into the path.
   * @param options - `wait`, plus the `variables` and `trigger` that go in the body.
   * @returns The run handle, its status, and the result when the run has one.
   * @throws {ApiError} `404 unknown_workflow` when there is no such workflow.
   * @throws {ApiError} `bad_response` when a success body is not a run object.
   */
  async run(id: string, options?: WorkflowRunOptions): Promise<WorkflowRunResult> {
    const res = await this.#host.request<unknown>({
      method: "POST",
      path: path`/workflows/${id}/run`,
      // `?wait=true` or no `wait` at all — never `?wait=false`, which the server
      // reads as "no wait" anyway and which would misrepresent the request in a
      // log or a proxy.
      query: { wait: options?.wait ? true : undefined },
      // Always a body, even when empty: the route parses one when the text is
      // non-empty and defaults to `{}` otherwise, so `{}` and no body are the
      // same request — and sending the object keeps the two optional fields at
      // one place instead of behind a conditional.
      body: { variables: options?.variables, trigger: options?.trigger },
    });

    const body = res.body;
    // The `runId` and `status` checks are the guard, not decoration. An
    // object-only check let `{}`, `[]`, `[{…}]` and `{"ok":true}` through and
    // returned a `WorkflowRunResult` whose `runId: string` and `status:
    // RunStatus` were **`undefined` at runtime** (measured) — a lie the compiler
    // cannot catch, which becomes a `TypeError` somewhere in the caller minutes
    // later. That is the failure this package's own `unwrap` exists to prevent.
    //
    // Requiring the two fields also subsumes the array case (`[].runId` is
    // `undefined`), and makes this guard exactly as strict as its sibling in
    // `src/run.ts`, which requires a string `kind`: two operations in one
    // package must not disagree about what a malformed success body is. It
    // keeps the lanes in step too — python's idiomatic `isinstance(body, dict)`
    // rejects `[]` where `typeof [] === "object"` accepts it.
    if (
      typeof body !== "object" || body === null ||
      typeof (body as { runId?: unknown }).runId !== "string" ||
      typeof (body as { status?: unknown }).status !== "string"
    ) {
      throw new ApiError(
        res.status,
        "bad_response",
        `Server returned a ${res.status} whose body is not a run object.`,
        body,
      );
    }
    const run = body as Partial<RunResult>;
    const status = run.status as RunStatus;
    return {
      // Spread first so any field a newer server adds survives; the normalised
      // ones below then take their pinned shape.
      ...run,
      runId: run.runId as string,
      status,
      // A `202` carries no `steps`. Normalised to `{}` rather than left absent,
      // so a caller iterating a run's steps never has to branch on which status
      // carried it — the same reason an empty list is `[]` and not `null`.
      steps: run.steps ?? {},
      terminal: isTerminalRunStatus(status),
      httpStatus: res.status,
    };
  }
}
