/**
 * `client.console.apiCalls.*` — the outbound API call log behind a run,
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
 * One method: `list`, relocated from `client.ts:214-231`'s `listApiCalls` —
 * which lived under the `client.ts` `// Apps` comment block despite having no
 * apps-domain consumer (its only caller is reliability's drill-down page).
 *
 * **`ApiCallRecord` is REUSED from `console.apps`, never redefined.**
 * `console/apps.ts` already declares it (used internally by `AppsApi.invoke`'s
 * result type) and `console/mod.ts` already re-exports it — this module
 * imports it as a type and uses it verbatim as `list`'s return element type.
 *
 * `api-calls` is scoped to the caller by the server's own repo, not by a
 * `project` query param — so `ApiCallsHost` needs only the transport,
 * mirroring `VarsHost`/`ProjectsHost`, not `DocumentsHost`.
 *
 * @module
 */

import type { HttpResponse, RequestOptions } from "../http.ts";
import { unwrap } from "../types.ts";
import type { ApiCallRecord } from "./apps.ts";

// Re-exported so a caller (and this package's own type-reuse test) can reach
// the type via either module — REUSED, not redeclared: this is a re-export of
// `apps.ts`'s own interface, never a second, parallel `ApiCallRecord`.
export type { ApiCallRecord } from "./apps.ts";

/**
 * The slice of `W6wClient` this namespace needs: the transport, and nothing
 * else. Structural rather than a concrete client type, so the namespace stays
 * independently constructible in a test and this module never imports the
 * client back — mirrors `VarsHost` in `../vars.ts`.
 */
export interface ApiCallsHost {
  /** Perform one request. */
  request<T>(options: RequestOptions): Promise<HttpResponse<T>>;
}

/**
 * Optional filter for `list`. All fields optional; omitted or `undefined`
 * fields are not sent as query params — mirrors `client.ts:214-231`'s default
 * `{}` parameter and its `Object.entries` loop that skips `undefined`/`""`
 * values.
 */
export interface ApiCallsFilter {
  appId?: string;
  actionKey?: string;
  connectionId?: string;
  sessionId?: string;
  /** Server defaults to 25 when unset/invalid, caps at 200. */
  limit?: number;
}

/**
 * The `console.apiCalls` namespace on a `W6wClient`.
 *
 * @example
 * ```ts
 * const calls = await client.console.apiCalls.list({ appId: "app_x", limit: 50 });
 * ```
 */
export class ApiCallsApi {
  readonly #host: ApiCallsHost;

  /**
   * @param host - The client this namespace issues requests through.
   */
  constructor(host: ApiCallsHost) {
    this.#host = host;
  }

  /**
   * List outbound API calls, newest first. Filter by app/action/connection/
   * session.
   *
   * @param filter - Optional filter; omitted entirely, no query params are sent.
   * @returns The calls, unwrapped from the `apiCalls` envelope.
   * @throws {ApiError} On any non-2xx.
   */
  async list(filter?: ApiCallsFilter): Promise<ApiCallRecord[]> {
    const res = await this.#host.request<unknown>({
      method: "GET",
      path: "/api-calls",
      query: {
        appId: filter?.appId,
        actionKey: filter?.actionKey,
        connectionId: filter?.connectionId,
        sessionId: filter?.sessionId,
        limit: filter?.limit,
      },
    });
    return unwrap<ApiCallRecord[]>(res, "apiCalls");
  }
}
