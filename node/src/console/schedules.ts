/**
 * `client.console.schedules.*` — per-workflow schedules, relocated from the
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
 * **`GET /schedules` (list) is deliberately not modeled here.** Studio's
 * `api/client.ts` never wrapped it (zero client-side coverage) — see this
 * task's contract Requirement and `plan.md`'s FINDINGS DISPOSITION for the
 * full reasoning.
 *
 * Schedules are addressed by `workflowId` alone, never by a project or account
 * scope, so `SchedulesHost` needs only the transport, no client configuration —
 * mirrors `VarsHost` in `../vars.ts`, not `DocumentsHost`.
 *
 * **`get`'s 404→`null` behavior is a deliberate, pinned deviation from every
 * other "get" method in this package** (`documents.get`, `vars.get`, … all
 * throw `ApiError` on 404). It is relocated verbatim from
 * `packages/studio/src/api/client.ts:535-542`, which catches ANY 404
 * (regardless of the server's error `code`) and resolves `null` instead of
 * throwing. The server sends two different codes for "no schedule to show" —
 * `unknown_workflow` and `no_schedule` (`admin/schedules.ts:82,85`) — and this
 * method does not discriminate between them, only the HTTP status: any other
 * status (400, 500, …) still throws, unchanged.
 *
 * @module
 */

import { type HttpResponse, path, type RequestOptions } from "../http.ts";
import { ApiError } from "../errors.ts";
import { unwrap } from "../types.ts";

/**
 * The slice of `W6WClient` this namespace needs: the transport, and nothing
 * else. Structural rather than a concrete client type, so the namespace stays
 * independently constructible in a test and this module never imports the
 * client back — mirrors `VarsHost` in `../vars.ts`.
 */
export interface SchedulesHost {
  /** Perform one request. */
  request<T>(options: RequestOptions): Promise<HttpResponse<T>>;
}

/**
 * A workflow's schedule. Field-for-field per
 * `packages/studio/src/api/types.ts:368-375` — this module does not redesign
 * the shape, only gives it a second home.
 */
export interface Schedule {
  workflowId: string;
  cron: string;
  enabled: boolean;
  variables: Record<string, unknown>;
  nextRunAt: string;
  lastRunAt: string | null;
}

/**
 * The body of `schedules.upsert`.
 *
 * Create-or-update — there is no distinct "create" and "update" on this
 * domain, mirroring `POST /workflows/:id/schedule`'s own create-or-update
 * semantics (`admin/schedules.ts:32-77`, `200` either way, no distinct `201`).
 */
export interface ScheduleUpsertInput {
  /** A standard 5-field cron expression. `400 invalid_cron` if malformed. */
  cron: string;
  /** Omitted, the server applies its own default. */
  enabled?: boolean;
  /** Variables bound into the scheduled run. Omitted, the server applies its own default. */
  variables?: Record<string, unknown>;
}

/**
 * The `console.schedules` namespace on a `W6WClient`.
 *
 * @example
 * ```ts
 * const schedule = await client.console.schedules.get("wf_1");
 * if (schedule === null) {
 *   await client.console.schedules.upsert("wf_1", { cron: "0 * * * *" });
 * }
 * await client.console.schedules.delete("wf_1");
 * ```
 */
export class SchedulesApi {
  readonly #host: SchedulesHost;

  /**
   * @param host - The client this namespace issues requests through.
   */
  constructor(host: SchedulesHost) {
    this.#host = host;
  }

  /**
   * Fetch a workflow's schedule.
   *
   * **Resolves `null` on a 404, of any code — it does not throw.** This is a
   * deliberate deviation from every other "get" method in this package, pinned
   * exactly from `client.ts:535-542`: see this module's header. Any other
   * error status (400, 500, …) still throws.
   *
   * @param workflowId - The `wf_…` id.
   * @returns The schedule, or `null` when there is none to show.
   * @throws {ApiError} On any non-404 non-2xx.
   */
  async get(workflowId: string): Promise<Schedule | null> {
    try {
      const res = await this.#host.request<unknown>({
        method: "GET",
        path: path`/workflows/${workflowId}/schedule`,
      });
      return unwrap<Schedule>(res, "schedule");
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) return null;
      throw err;
    }
  }

  /**
   * Create or overwrite a workflow's schedule.
   *
   * @param workflowId - The `wf_…` id.
   * @param body - The schedule to set; forwarded as-is.
   * @returns The resulting schedule (the server answers `200`, create-or-update alike).
   * @throws {ApiError} `404 unknown_workflow`; `400 invalid_body`/`invalid_cron`.
   */
  async upsert(workflowId: string, body: ScheduleUpsertInput): Promise<Schedule> {
    const res = await this.#host.request<unknown>({
      method: "POST",
      path: path`/workflows/${workflowId}/schedule`,
      body,
    });
    return unwrap<Schedule>(res, "schedule");
  }

  /**
   * Delete a workflow's schedule.
   *
   * Returns nothing: the server's `{ok: true}` carries no information a caller
   * can use. Unlike `get`, this method does NOT catch a 404 — deleting a
   * schedule that does not exist is `404 unknown_workflow`, not a silent
   * success.
   *
   * @param workflowId - The `wf_…` id.
   * @throws {ApiError} `404 unknown_workflow` when there is no such workflow.
   */
  async delete(workflowId: string): Promise<void> {
    await this.#host.request<unknown>({
      method: "DELETE",
      path: path`/workflows/${workflowId}/schedule`,
    });
  }
}
