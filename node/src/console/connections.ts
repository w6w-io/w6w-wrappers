/**
 * `client.console.connections.*` — the app-catalog write surface for
 * connections (list-for-app, get, create, update, test, delete), relocated
 * from the studio's own API client.
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
 * **Console placement is a resolved HITL, not a default applied without
 * thought — see `HITL-10` in `HITL.md` and `plan.md`'s SP2.3 section for the
 * full investigation.** `endpoints.json`'s `outOfScope` entry for connections
 * writes frames the eventual intent as a real partner operation, unlike
 * `projects`/`schedules`/`apps`; the server routes this file wraps are plain,
 * stateless handlers over an already-resolved payload for both real studio
 * call sites, which makes console placement technically safe for studio's own
 * use — it does not by itself justify promoting straight to the partner
 * surface (cli/python lockstep; no partner-facing OAuth-flow counterpart
 * exists yet either). Console placement is the pinned default here; partner
 * promotion is deferred to a dedicated future project.
 *
 * **`listConnections` (base `client.connections.list()`,
 * `../connections.ts:47-64`) is deliberately NOT relocated here** — it is the
 * one method of the seven studio call sites that already has a home on the
 * pre-existing BASE namespace; duplicating it under `console.connections`
 * would give a caller two ways to reach the same route. See this task's
 * contract Requirement.
 *
 * Six methods relocate from the studio's single `// Connections` comment block
 * (`packages/studio/src/api/client.ts:252-298` on the studio base tree) —
 * field-for-field, not redesigned.
 *
 * None of these methods take a `project` scoping parameter — connections carry
 * no `?project=`, the server scopes by tenant/account from the credential
 * alone — so `ConnectionsHost` needs only the transport, mirroring
 * `VarsHost`/the base `ConnectionsHost`, not `DocumentsHost`.
 *
 * @module
 */

import { type HttpResponse, path, type RequestOptions } from "../http.ts";
import { type ConnectionSummary, unwrap } from "../types.ts";

/**
 * The slice of `W6WClient` this namespace needs: the transport, and nothing
 * else. Structural rather than a concrete client type, so the namespace stays
 * independently constructible in a test and this module never imports the
 * client back — mirrors `VarsHost` in `../vars.ts`.
 */
export interface ConnectionsHost {
  /** Perform one request. */
  request<T>(options: RequestOptions): Promise<HttpResponse<T>>;
}

/**
 * `test`'s result — the whole response body, no envelope key
 * (`packages/server/packages/api/admin/connections.ts:151-190`). Three
 * possible 200-status shapes:
 *
 * - `{ok: true, untested: true, message}` — no safe probe action exists for
 *   this connection's app.
 * - `{ok: true, actionKey}` — the probe action ran and passed.
 * - `{ok: false, actionKey, error: {message}}` — the probe action ran and
 *   failed. **Still a 200** — a failed test is data, never a raised error,
 *   the same rule `client.run()`/`workflows.run()` already document for a
 *   failed run.
 *
 * Only a genuine non-2xx (e.g. `404 unknown_connection`) raises `ApiError`.
 */
export interface ConnectionTestResult {
  ok: boolean;
  actionKey?: string;
  untested?: boolean;
  message?: string;
  error?: { message: string };
}

/**
 * The `console.connections` namespace on a `W6WClient`.
 *
 * @example
 * ```ts
 * const conns = await client.console.connections.listForApp("sendgrid");
 * const created = await client.console.connections.create("sendgrid", {
 *   authKey: "apiKey",
 *   credential: { key: "sk_live_…" },
 * });
 * const result = await client.console.connections.test(created.id);
 * if (!result.ok) console.log(result.error?.message);
 * await client.console.connections.delete(created.id);
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
   * List an app's connections.
   *
   * @param appId - The app id.
   * @returns The connections, unwrapped from the `connections` envelope.
   * @throws {ApiError} `404 unknown_app` when there is no such app.
   */
  async listForApp(appId: string): Promise<ConnectionSummary[]> {
    const res = await this.#host.request<unknown>({
      method: "GET",
      path: path`/apps/${appId}/connections`,
    });
    return unwrap<ConnectionSummary[]>(res, "connections");
  }

  /**
   * Fetch one connection.
   *
   * No 404 special-casing — propagates as `ApiError` like every other "get"
   * in this package except `console.schedules.get`, which has its own
   * documented, unrelated exception.
   *
   * @param id - The `conn_…` id.
   * @returns The connection, unwrapped from the `connection` envelope.
   * @throws {ApiError} `404 unknown_connection` when there is no such id.
   */
  async get(id: string): Promise<ConnectionSummary> {
    const res = await this.#host.request<unknown>({
      method: "GET",
      path: path`/connections/${id}`,
    });
    return unwrap<ConnectionSummary>(res, "connection");
  }

  /**
   * Create a connection for an app.
   *
   * `credential` is opaque — forwarded verbatim, never inspected, logged, or
   * transformed. This is a security-adjacent discipline, not a style note:
   * the whole point of this field is a caller-opaque secret payload.
   *
   * @param appId - The app id.
   * @param body - `authKey` selects the app's auth method; `credential` is
   * the secret payload it needs; `displayName` and `profile` are optional.
   * @returns The created connection, unwrapped from the `connection` envelope (the server answers `201`).
   * @throws {ApiError} `400 invalid_auth_key`/`invalid_credential`; `404 unknown_app`.
   */
  async create(
    appId: string,
    body: {
      authKey: string;
      credential: Record<string, unknown>;
      displayName?: string;
      profile?: Record<string, unknown>;
    },
  ): Promise<ConnectionSummary> {
    const res = await this.#host.request<unknown>({
      method: "POST",
      path: path`/apps/${appId}/connections`,
      body,
    });
    return unwrap<ConnectionSummary>(res, "connection");
  }

  /**
   * Update a connection: rename it and/or replace its credential.
   *
   * `credential` is opaque — forwarded verbatim, never inspected, logged, or
   * transformed, same discipline as {@linkcode create}. The body is sent
   * exactly as given; this method does not pre-validate it — the server also
   * validates "nothing to update" and answers `400 invalid_body` itself.
   *
   * @param id - The `conn_…` id.
   * @param body - `displayName` and/or `credential`, forwarded verbatim.
   * @returns The updated connection, unwrapped from the `connection` envelope.
   * @throws {ApiError} `400 invalid_body` ("Nothing to update"); `404 unknown_connection`.
   */
  async update(
    id: string,
    body: { displayName?: string; credential?: Record<string, unknown> },
  ): Promise<ConnectionSummary> {
    const res = await this.#host.request<unknown>({
      method: "PATCH",
      path: path`/connections/${id}`,
      body,
    });
    return unwrap<ConnectionSummary>(res, "connection");
  }

  /**
   * Probe a connection by running a safe read action of its app.
   *
   * **No envelope key — the whole body IS the result**, mirroring
   * `console.reliability.list`'s pattern. A failed probe (`ok: false`) is
   * still a `200` and resolves normally; this method never throws on it — the
   * same rule `client.run()`/`workflows.run()` already document: a failed
   * run (here, a failed test) is data. Only a genuine non-2xx (e.g.
   * `404 unknown_connection`) raises `ApiError`. See {@linkcode ConnectionTestResult}.
   *
   * @param id - The `conn_…` id.
   * @returns The whole response body — no envelope key to peel.
   * @throws {ApiError} `404 unknown_connection` when there is no such id.
   */
  async test(id: string): Promise<ConnectionTestResult> {
    const res = await this.#host.request<ConnectionTestResult>({
      method: "POST",
      path: path`/connections/${id}/test`,
    });
    return res.body;
  }

  /**
   * Delete a connection.
   *
   * Returns nothing: the server's `{ok: true}` carries no information a
   * caller can use, mirroring `console.projects.delete`/
   * `console.schedules.delete` in this same package (NOT
   * `console.apps.delete`, which is the one documented exception, preserving
   * a genuinely informative `{removed: number}`) — connections delete has no
   * such value to preserve.
   *
   * @param id - The `conn_…` id.
   * @throws {ApiError} `404 unknown_connection` when there is no such id.
   */
  async delete(id: string): Promise<void> {
    await this.#host.request<unknown>({ method: "DELETE", path: path`/connections/${id}` });
  }
}
