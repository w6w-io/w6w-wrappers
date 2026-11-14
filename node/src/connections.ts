/**
 * `client.connections.*` — discover, inspect and remove connections.
 *
 * Three operations: `list`, `get`, `delete`. `list` exists because without it a
 * caller has no way to **discover** a `conn_…` id to pass to `run` (D4); `get`
 * and `delete` address one such id.
 *
 * Creating, updating, testing and OAuth-connecting a connection stay out of the
 * partner contract (`endpoints.json` `outOfScope`: "connection create / update /
 * test / OAuth"). That is a deliberate line, not an omission: connecting an app
 * is an interactive, secret-handling flow, and half of one in an SDK is worse
 * than none. Those flows live on `client.console.connections` (studio-internal)
 * and behind the React adapter.
 *
 * The rows the server returns are a **redacted projection** — the stored secret
 * never leaves the host — so {@linkcode ConnectionSummary} does not declare it.
 * Its keep-alive state (`autoRefresh`, `lastRefreshedAt`,
 * `refreshFailingSince`) is not secret and is on the row since contract
 * `0.19.0`.
 *
 * @module
 */

import { type CallOptions, type HttpResponse, path, type RequestOptions } from "./http.ts";
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
   * @param options - Optional per-call transport options (`signal` to abort).
   * @returns The connections, unwrapped from the `connections` envelope.
   * @throws {ApiError} On any non-2xx.
   */
  async list(options?: CallOptions): Promise<ConnectionSummary[]> {
    const res = await this.#host.request<unknown>({
      method: "GET",
      path: "/connections",
      signal: options?.signal,
    });
    return unwrap<ConnectionSummary[]>(res, "connections");
  }

  /**
   * Fetch one connection.
   *
   * Account-owned: another account's id answers the same uniform `404` as an
   * id that does not exist. The built-in zero-credential row `list` can include
   * (a `zerocred:…` id, flagged `builtIn: true`) is synthetic and is not
   * fetchable here — it answers `404` too.
   *
   * @param id - The `conn_…` id.
   * @param options - Optional per-call transport options (`signal` to abort).
   * @returns The connection, unwrapped from the `connection` envelope.
   * @throws {ApiError} `404 unknown_connection` for an unknown, foreign or built-in id.
   */
  async get(id: string, options?: CallOptions): Promise<ConnectionSummary> {
    const res = await this.#host.request<unknown>({
      method: "GET",
      path: path`/connections/${id}`,
      signal: options?.signal,
    });
    return unwrap<ConnectionSummary>(res, "connection");
  }

  /**
   * Delete a connection.
   *
   * Returns nothing: the server's `{ok: true}` carries no information a caller
   * can use. Not idempotent — a second delete is `404`. Before the row goes, the
   * server tears down every trigger subscription bound to the connection (the
   * vendor webhook is removed while the credential can still sign the call).
   * Ownership is checked first: another account's id, or a built-in `zerocred:…`
   * row, answers `404` and destroys nothing.
   *
   * @param id - The `conn_…` id.
   * @param options - `force` (send `?force=true`; only when true) and `signal` to abort.
   *   A forced delete disables dependent callables (never edits them); still resolves void.
   * @throws {ApiError} `404 unknown_connection` for an unknown, foreign or built-in id;
   *   `409 connection_in_use` when enabled callables depend on it and `force` is not set —
   *   the `dependents` object is on `err.raw.error.dependents`.
   */
  async delete(id: string, options?: CallOptions & { force?: boolean }): Promise<void> {
    await this.#host.request<unknown>({
      method: "DELETE",
      path: path`/connections/${id}`,
      query: options?.force === true ? { force: true } : undefined,
      signal: options?.signal,
    });
  }
}
