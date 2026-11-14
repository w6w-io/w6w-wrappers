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
 * full investigation.** `endpoints.json`'s `outOfScope` entry "connection
 * create / update / test / OAuth" frames the eventual intent as a real partner
 * operation; the server routes this file wraps are plain, stateless handlers
 * over an already-resolved payload for both real studio call sites, which makes
 * console placement technically safe for studio's own use — it does not by
 * itself justify promoting the connect flows to the partner surface (cli/python
 * lockstep; no partner-facing OAuth-flow counterpart exists yet either). Contract
 * `0.7.0` promoted `get` and `delete` to the root client
 * (`client.connections.get/delete`); they remain here unchanged for the studio.
 * Console placement is the pinned default for the rest.
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
 * Non-secret per-connection binding for a credential-backed connection
 * (I-1): the scopes it asks for, the user it delegates as, and free settings.
 */
export interface ConnectionBinding {
  scopes?: string[];
  delegatedUser?: string;
  settings?: Record<string, string | number | boolean>;
}

/**
 * `create`'s body: either the legacy inline-secret form or the attach-by-id
 * form. The `?: never` arms make a body carrying both a compile error (the
 * server also answers `400 invalid_credential_source`).
 */
export type ConnectionCreateInput =
  | {
    authKey: string;
    credential: Record<string, unknown>;
    displayName?: string;
    profile?: Record<string, unknown>;
    credentialId?: never;
    binding?: never;
    accessScope?: "account" | "user";
    /**
     * Background keep-alive refresh for the new connection. The server
     * defaults it to `true`; send `false` to opt out. Omitted = not sent.
     */
    autoRefresh?: boolean;
  }
  | {
    authKey: string;
    credentialId: string;
    binding?: ConnectionBinding;
    displayName?: string;
    credential?: never;
    profile?: never;
    accessScope?: "account" | "user";
    /** Background keep-alive refresh; see the inline-credential arm. */
    autoRefresh?: boolean;
  };

/** A callable (Function/Endpoint) bound to a connection. */
export interface ConnectionDependentCallable {
  id: string;
  kind: string;
  key: string;
  displayName: string;
  enabled: boolean;
  sites: unknown[];
}

/** A trigger subscription bound to a connection. */
export interface ConnectionDependentSubscription {
  id: string;
  appId: string;
  triggerKey: string;
  workflowId: string;
}

/** `GET /connections/:id/dependents` payload (the `dependents` key). */
export interface ConnectionDependents {
  callables: ConnectionDependentCallable[];
  subscriptions: ConnectionDependentSubscription[];
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

/** The body without a (possibly `undefined`) `accessScope` key. */
function omitScope(body: ConnectionCreateInput): ConnectionCreateInput {
  const { accessScope: _omitted, ...rest } = body;
  return rest as ConnectionCreateInput;
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
   * @param body - `authKey` selects the app's auth method. Either `credential`
   * (the inline secret payload) **or** `credentialId` (attach a stored
   * credential, with an optional `binding`) — never both. `displayName` is optional.
   * `autoRefresh: false` turns background keep-alive off (the server's default is on);
   * a non-boolean is the server's `400 invalid_body`.
   * @returns The created connection, unwrapped from the `connection` envelope (the server answers `201`).
   * @throws {ApiError} `400 invalid_auth_key`/`invalid_credential`/`invalid_credential_source`/`invalid_body`;
   * `404 unknown_app`; `422 credential_invalid` when an auth method's sign-in (`exchange`
   * hook) refused the credential — the app's own short code, when it gave one, is
   * `raw.error.hookCode`.
   */
  async create(
    appId: string,
    body: ConnectionCreateInput,
  ): Promise<ConnectionSummary> {
    const res = await this.#host.request<unknown>({
      method: "POST",
      path: path`/apps/${appId}/connections`,
      // `accessScope` rides along only when defined (an omitted scope = today's body).
      body: body.accessScope === undefined ? omitScope(body) : body,
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
   * @param body - `displayName`, `binding`, `credentialId` (re-attach), `credential` and/or
   * `autoRefresh` (turn background keep-alive on or off), forwarded verbatim.
   * @returns The updated connection, unwrapped from the `connection` envelope.
   * @throws {ApiError} `400 invalid_body` ("Nothing to update", or a non-boolean `autoRefresh`);
   * `404 unknown_connection`; `422 credential_invalid` (with `raw.error.hookCode`) when a new
   * credential fails the auth method's sign-in.
   */
  async update(
    id: string,
    body: {
      /** Switch to a key/token auth method with a full replacement credential. */
      authKey?: string;
      displayName?: string;
      binding?: ConnectionBinding;
      credentialId?: string;
      credential?: Record<string, unknown>;
      /** Turn background keep-alive refresh on (`true`) or off (`false`). */
      autoRefresh?: boolean;
    },
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
   * @param opts - `force: true` sends `?force=true` (disables dependent callables);
   *   omitted/false sends no query and a 409 `connection_in_use` may be raised.
   * @throws {ApiError} `404 unknown_connection`; `409 connection_in_use`.
   */
  async delete(id: string, opts?: { force?: boolean }): Promise<void> {
    await this.#host.request<unknown>({
      method: "DELETE",
      path: path`/connections/${id}`,
      query: opts?.force === true ? { force: true } : undefined,
    });
  }

  /**
   * What would a delete touch? `GET /connections/:id/dependents`, unwrapping
   * `{ dependents }`.
   *
   * @param id - The `conn_…` id.
   * @throws {ApiError} `404 unknown_connection` when there is no such id.
   */
  async dependents(id: string): Promise<ConnectionDependents> {
    const res = await this.#host.request<unknown>({
      method: "GET",
      path: path`/connections/${id}/dependents`,
    });
    return unwrap<ConnectionDependents>(res, "dependents");
  }
}
