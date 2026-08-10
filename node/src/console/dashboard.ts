/**
 * `client.console.dashboard.*` — the account-scoped dashboard rollup,
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
 * One operation: `stats`, `GET /dashboard/stats`. AUTHENTICATED — the account
 * is derived server-side from the principal (`admin/dashboard.ts:44-96`), so
 * this uses the default, unconditional `requireAuth` (HITL-9); the client
 * never sends an account. Unlike `client.documents.*` and `client.vars.*`,
 * the response carries **no envelope key** — the `DashboardStats`-shaped
 * object IS the top-level response body (`admin/dashboard.ts:90-95`, which
 * answers `c.json({range, headline, series, recent})`), so `stats` returns
 * `res.body` directly and never calls this package's `unwrap()` helper.
 *
 * @module
 */

import type { HttpResponse, RequestOptions } from "../http.ts";

/**
 * The slice of `W6wClient` this namespace needs: the transport, and nothing
 * else. Structural rather than a concrete client type, so the namespace stays
 * independently constructible in a test and this module never imports the
 * client back — mirrors `ReliabilityHost` in `./reliability.ts`.
 */
export interface DashboardHost {
  /** Perform one request. */
  request<T>(options: RequestOptions): Promise<HttpResponse<T>>;
}

/** Optional window/bucketing for `stats`. Omitted fields fall back to the server's own defaults. */
export interface DashboardStatsParams {
  from?: string;
  to?: string;
  bucket?: "day" | "week";
}

/**
 * Account-scoped dashboard rollup over the `run_log` ledger (server `GET
 * /dashboard/stats`). A free-form fetch seam, so this shape mirrors the
 * server envelope field for field — relocated verbatim from
 * `packages/studio/src/api/client.ts:189-197` rather than redesigned. The
 * account is derived server-side from the session; the client never sends
 * one. The `series` array is the charts-later seam (a flat payload the studio
 * slices client-side; no chart dependency).
 */
export interface DashboardStats {
  range: { from: string; to: string; bucket: "day" | "week" };
  headline: { workflowRuns: number; succeeded: number; failed: number };
  series: Array<{ bucket: string; kind: string; ok: boolean | null; count: number }>;
  recent: Array<{
    id: string;
    kind: string;
    ok: boolean | null;
    summary: string | null;
    occurredAt: string;
    workflowId: string | null;
  }>;
}

/**
 * The `console.dashboard` namespace on a `W6wClient`.
 *
 * @example
 * ```ts
 * const rollup = await client.console.dashboard.stats({ bucket: "week" });
 * ```
 */
export class DashboardApi {
  readonly #host: DashboardHost;

  /**
   * @param host - The client this namespace issues requests through.
   */
  constructor(host: DashboardHost) {
    this.#host = host;
  }

  /**
   * Fetch the account-scoped dashboard rollup.
   *
   * @param params - Optional `from`/`to`/`bucket`; each is forwarded as a
   * query parameter when given, and omitted from the query string entirely
   * when not (the server applies its own defaults).
   * @returns The rollup, exactly as the server sent it — no envelope key to peel.
   * @throws {ApiError} On any non-2xx.
   */
  async stats(params: DashboardStatsParams = {}): Promise<DashboardStats> {
    const res = await this.#host.request<DashboardStats>({
      method: "GET",
      path: "/dashboard/stats",
      query: { from: params.from, to: params.to, bucket: params.bucket },
    });
    return res.body;
  }
}
