/**
 * `client.workflows.*` — discovery today, `run` next.
 *
 * This module carries **`list` only** in T2.1.4; `workflows.run` is T2.1.5 and
 * lands here alongside it. `list` earns its place in a minimal surface for the
 * same reason `connections.list` does (D4): it is how a caller discovers a
 * `wf_…` id to pass to `run`.
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
import type { HttpResponse, RequestOptions } from "./http.ts";
import { unwrap, type WorkflowSummary } from "./types.ts";

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
 * The `workflows` namespace on a `W6wClient`.
 *
 * @example
 * ```ts
 * const active = (await client.workflows.list()).filter((w) => w.status === "active");
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
}
