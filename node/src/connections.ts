/**
 * `client.connections.list()` — discovery, and nothing more.
 *
 * One operation in v0.1.0. It exists because without it a caller has no way to
 * **discover** a `conn_…` id to pass to `run` (D4): the intake's surface is
 * `run` plus the assets it needs, and an id nobody can enumerate is an id
 * nobody can use.
 *
 * Everything else about connections — creating one, testing one, replacing its
 * secret — is `outOfScope` in `endpoints.json` for this version. That is a
 * deliberate line, not an omission: connecting an app is an interactive,
 * secret-handling flow, and half of one in a v0.1.0 wrapper is worse than none.
 * This namespace is therefore read-only and stays that way until the contract
 * says otherwise.
 *
 * The list the server returns is a **redacted projection** — the stored secret
 * and its refresh timestamp never leave the host — so
 * {@linkcode ConnectionSummary} does not declare them.
 *
 * @module
 */

import type { HttpResponse, RequestOptions } from "./http.ts";
import { type ConnectionSummary, unwrap } from "./types.ts";

/**
 * The slice of `W6WClient` this namespace needs: the transport, and nothing
 * else. Connections carry no `?project=` — the server scopes them by
 * tenant/account from the credential — so, as with `vars`, this host cannot
 * reach the client's configuration to send a scope even by accident.
 */
export interface ConnectionsHost {
  /** Perform one request. */
  request<T>(options: RequestOptions): Promise<HttpResponse<T>>;
}

/**
 * The `connections` namespace on a `W6WClient`.
 *
 * @example
 * ```ts
 * for (const c of await client.connections.list()) {
 *   if (c.state === "connected") console.log(c.id, c.appId);
 * }
 * ```
 */
export class ConnectionsApi {
  readonly #host: ConnectionsHost;

  /**
   * @param host - The client this namespace issues requests through.
   */
  constructor(host: ConnectionsHost) {
    this.#host = host;
  }

  /**
   * List the caller's connections.
   *
   * @returns The connections, unwrapped from the `connections` envelope.
   * @throws {ApiError} On any non-2xx.
   */
  async list(): Promise<ConnectionSummary[]> {
    const res = await this.#host.request<unknown>({ method: "GET", path: "/connections" });
    return unwrap<ConnectionSummary[]>(res, "connections");
  }
}
