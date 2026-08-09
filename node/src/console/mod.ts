/**
 * `@w6w/sdk/console` — the console-only namespace group.
 *
 * A **second, separate** entry point from the package's root (`@w6w/sdk`),
 * built on the same transport (`../http.ts`, `../errors.ts`, `../config.ts`)
 * but deliberately EXCLUDED from `endpoints.json`'s `operations[]` and from
 * the root barrel (`../../mod.ts`) — see `docs/console.md` and HITL-1 in this
 * task's contract. `client.console` is instance state exactly like every other
 * namespace on `W6wClient` (`docs/implementation.md` §MECHANISM PIN —
 * instance state, never globals): it holds the host it was constructed with
 * and nothing of its own.
 *
 * This file is the append point for the console surface's later phases: each
 * new console domain gets one `this.<domain> = new <Domain>Api(host)` line
 * here, mirroring `reliability` below, rather than being folded into
 * `../client.ts` directly.
 *
 * @module
 */

import type { HttpResponse, RequestOptions } from "../http.ts";
import { ReliabilityApi } from "./reliability.ts";

export { ReliabilityApi } from "./reliability.ts";
export type {
  ReliabilityErrorMix,
  ReliabilityHost,
  ReliabilityService,
  ReliabilityServices,
  ReliabilityState,
  ReliabilityUptimeDay,
  ReliabilityVendorStatus,
} from "./reliability.ts";

/**
 * The slice of `W6wClient` the console namespace group needs: the transport,
 * and nothing else. Structural rather than a concrete client type, so
 * `ConsoleApi` stays independently constructible in a test and this module
 * never imports the client back.
 */
export interface ConsoleHost {
  /** Perform one request. */
  request<T>(options: RequestOptions): Promise<HttpResponse<T>>;
}

/**
 * The `console` namespace group on a `W6wClient` — studio-internal, not part
 * of the published partner contract.
 *
 * @example
 * ```ts
 * const board = await client.console.reliability.list(30, 5);
 * ```
 */
export class ConsoleApi {
  /** `console.reliability.*`. */
  readonly reliability: ReliabilityApi;

  /**
   * @param host - The client this namespace group issues requests through.
   */
  constructor(host: ConsoleHost) {
    this.reliability = new ReliabilityApi(host);
  }
}
