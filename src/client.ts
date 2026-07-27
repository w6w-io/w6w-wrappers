/**
 * `W6wClient` — the object every operation hangs off.
 *
 * It holds three things and no behaviour of its own: the resolved
 * configuration, the transport, and (from T2.1.3 onward) the operation
 * namespaces. All of it is **instance** state.
 *
 * That is a mechanism pin, not a style choice (`docs/implementation.md` §2).
 * The browser client this package transcribes keeps its token in a mutable
 * module variable, which is fine for one page and an outright bug for a
 * server-side SDK: two clients in one process would share one credential, so a
 * host juggling tenants would silently issue requests as whichever tenant
 * constructed a client last. Nothing in `src/` holds mutable module state.
 *
 * @module
 */

import {
  type FetchLike,
  resolveConfig,
  type ResolvedConfig,
  type W6wClientOptions,
} from "./config.ts";
import { ConfigError } from "./errors.ts";
import { type HttpResponse, request, type RequestOptions } from "./http.ts";

/**
 * A client for the w6w HTTP API.
 *
 * Construction resolves configuration once — explicit arguments first, then the
 * environment (`W6W_BASE_URL`, `W6W_TOKEN`) — and never consults the
 * environment again. A missing base URL raises here; a missing token raises on
 * the first request, so a CLI can print `--help` offline.
 *
 * @example
 * ```ts
 * // From the environment.
 * const client = new W6wClient();
 *
 * // Explicit, overriding the environment. Two clients, two credentials, one
 * // process — no interference.
 * const other = new W6wClient({ baseUrl: "https://api.example.com", token: "t_2" });
 * ```
 */
export class W6wClient {
  /**
   * The resolved base URL, credential and default project. Exposed read-only
   * so a host can log *which server* it is talking to without re-deriving the
   * join rule.
   */
  readonly config: ResolvedConfig;

  readonly #fetch: FetchLike;

  /**
   * @param options - Explicit configuration; anything omitted falls back to the environment.
   * @throws {ConfigError} When no base URL is configured, or the host has no `fetch`.
   */
  constructor(options: W6wClientOptions = {}) {
    this.config = resolveConfig(options);
    if (options.fetch) {
      this.#fetch = options.fetch;
    } else {
      const global = globalThis.fetch;
      if (typeof global !== "function") {
        throw new ConfigError(
          "This runtime has no global fetch. Pass an implementation " +
            "(new W6wClient({ fetch })) or run on Node 18+, Deno or Bun.",
        );
      }
      // Bound, so the default keeps working when it is called as a bare
      // function reference rather than as a method of the global object.
      this.#fetch = global.bind(globalThis);
    }
  }

  /**
   * Perform one request against this client's server, with this client's
   * credential.
   *
   * This is the seam the operation modules are built on; it is public so a host
   * can also reach an endpoint this version does not model yet, rather than
   * constructing a second client by hand. It returns the status alongside the
   * body — a `202` is success on this API.
   *
   * @param options - The request to make.
   * @returns The status and parsed body.
   * @throws {ConfigError} When no token is configured.
   * @throws {ApiError} On a transport failure, a non-JSON error body, or an error envelope.
   */
  request<T>(options: RequestOptions): Promise<HttpResponse<T>> {
    return request<T>(this.config, this.#fetch, options);
  }
}
