/**
 * `client.console.reliability.*` — the account-scoped reliability board,
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
 * One operation: `list`, `GET /reliability/services`. Unlike `documents`/
 * `vars`, the server's response carries **no envelope key** — the
 * `ReliabilityServices`-shaped object IS the top-level response body
 * (verified against `packages/server/packages/api/admin/reliability.ts:407-432`,
 * which answers `c.json(board)`) — so `list` returns `res.body` directly and
 * never calls this package's `unwrap()` helper.
 *
 * @module
 */

import type { HttpResponse, RequestOptions } from "../http.ts";

/**
 * The slice of `W6wClient` this namespace needs: the transport, and nothing
 * else. Structural rather than a concrete client type, so the namespace stays
 * independently constructible in a test and this module never imports the
 * client back — mirrors `VarsHost` in `../vars.ts`.
 */
export interface ReliabilityHost {
  /** Perform one request. */
  request<T>(options: RequestOptions): Promise<HttpResponse<T>>;
}

/**
 * The four states a service (or one of its days) can be in — the RFC's
 * `HealthReport.state` union (`core/rfcs/healthcheck.md`). There is no fifth
 * state: a service the account made no calls to is `unknown`, never `ok`.
 */
export type ReliabilityState = "ok" | "degraded" | "down" | "unknown";

/** The error mix the server counts per service and per day. Names are wire-pinned. */
export interface ReliabilityErrorMix {
  e4xx: number;
  e429: number;
  eAuth: number;
  e5xx: number;
}

/** One calendar day of one service's uptime strip. */
export interface ReliabilityUptimeDay {
  day: string;
  state: ReliabilityState;
  calls: number;
  errors: ReliabilityErrorMix;
}

/** The vendor's own verdict for one service. See `ReliabilityService.vendorStatus`. */
export interface ReliabilityVendorStatus {
  state: ReliabilityState;
  /** The deciding check's own words, rendered verbatim. Null when all clear. */
  message: string | null;
  checkedAt: string;
  /** Keys of the checks behind a non-`ok` verdict. Empty when `ok`. */
  attributedTo: string[];
}

/** One row of the service board — a single external service the account calls. */
export interface ReliabilityService {
  appId: string;
  displayName: string;
  state: ReliabilityState;
  hasDeclaredHealth: boolean;
  calls: number;
  errors: ReliabilityErrorMix;
  /** Null when the window holds no timed calls (the board renders "—"). */
  p95Ms: number | null;
  openAdvisories: number;
  /** Non-null while an outage is still open. */
  ongoingOutageId: string | null;
  /** Null when the account has never called this service. Drives the server's
   * recency ordering (`?limit=N`) — the client never re-sorts by it. */
  lastCallAt: string | null;
  /**
   * Gap-free, exactly `window.days` entries, ONE PER CALENDAR DAY, OLDEST FIRST —
   * including days with no data (`state: "unknown"`, `calls: 0`). The client
   * never synthesises a missing day and never re-sorts: if entries are missing or
   * out of order that is a server bug to report, not to paper over.
   */
  uptime: ReliabilityUptimeDay[];
  /**
   * What the VENDOR publishes about itself, from the app's declared public
   * health check (Slack's `status.slack.com`, SendGrid's status page, …).
   *
   * A SECOND, INDEPENDENT signal — never a restatement of `state` above, which
   * is strictly "did your calls succeed". Your credential can be revoked while
   * the vendor is green, and the vendor can be down in a window where you made
   * no calls at all, so the board shows both and folds neither into the other.
   *
   * `null` means the app publishes no public check — a different fact from
   * `state: "unknown"` ("it publishes one and we could not read it"), and the
   * board renders them differently.
   */
  vendorStatus: ReliabilityVendorStatus | null;
}

/**
 * Account-scoped reliability board (server `GET /reliability/services?days=…`,
 * T4.1.1). A free-form fetch seam, so this shape mirrors the server envelope
 * field for field — the field names below are PINNED by
 * `contracts/T4.1.1.contract.md` and must not be renamed on either side. This
 * relocates that pin from `packages/studio/src/api/client.ts:212-295` rather
 * than redesigning it.
 */
export interface ReliabilityServices {
  account: string;
  window: { from: string; to: string; days: number };
  /** The server's own wording for what "uptime" measures here — displayed verbatim. */
  uptimeMeans: string;
  definition: { id: string; version: string; source: string };
  services: ReliabilityService[];
}

/**
 * The `console.reliability` namespace on a `W6wClient`.
 *
 * @example
 * ```ts
 * const board = await client.console.reliability.list(30, 5);
 * ```
 */
export class ReliabilityApi {
  readonly #host: ReliabilityHost;

  /**
   * @param host - The client this namespace issues requests through.
   */
  constructor(host: ReliabilityHost) {
    this.#host = host;
  }

  /**
   * Fetch the account-scoped reliability board.
   *
   * @param days - The window size in days. Omitted, the server applies its own default.
   * @param limit - Cap on the number of services returned, most-recently-called first. Omitted, no cap.
   * @returns The board, exactly as the server sent it — no envelope key to peel.
   * @throws {ApiError} On any non-2xx.
   */
  async list(days?: number, limit?: number): Promise<ReliabilityServices> {
    const res = await this.#host.request<ReliabilityServices>({
      method: "GET",
      path: "/reliability/services",
      query: { days, limit },
    });
    return res.body;
  }
}
