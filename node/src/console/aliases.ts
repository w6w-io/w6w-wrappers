/**
 * `client.console.aliases.*` — account-scoped alias management
 * (`list`/`get`/`upsert`/`delete`) for the names `run`'s URN dispatch
 * resolves alongside its four `conn_…`/`wf_…`/`fn_…`/`ep_…` arms
 * (`src/run.ts`).
 *
 * **Studio-internal, not the published partner contract.** This namespace
 * lives under the `console` subpath export (`@w6w/sdk/console`), excluded
 * from `endpoints.json` and from the root barrel (`mod.ts`) — see
 * `docs/console.md` and HITL-2 in this project's contract. This surface is
 * **new**: unlike `console.functions`/`console.endpoints`, there is no
 * pre-existing `studio/src/api/client.ts` alias code being relocated here —
 * Studio never had alias CRUD before this project. `@w6w/sdk`'s
 * instance-state mechanism pin still applies here exactly as it does to
 * every other namespace (`docs/implementation.md` §MECHANISM PIN — instance
 * state, never globals): this class holds no state of its own beyond the
 * injected host, so two clients in one process never share a credential.
 *
 * **`invoke`/`run` is deliberately NOT modeled here.** The base
 * `client.run({urn: aliasName, payload})` (already-published surface,
 * `endpoints.json`-named, exported from the root `mod.ts`) already reaches
 * an alias's target — an alias name is one of `run`'s runnable `urn` arms,
 * alongside `conn_…`/`wf_…`/`fn_…`/`ep_…` (`src/run.ts`). Adding a duplicate
 * `console.aliases.invoke` would give a caller two ways to reach the same
 * route — the exact anti-duplication defect `console/functions.ts:15-26`
 * flags for Functions, applied here with alias/`run` substituted for
 * function/`run`; `console.endpoints`/`console.workflows` follow the same
 * precedent. No invoke method lives here, and none should be added later
 * without re-litigating this reasoning.
 *
 * @module
 */

import { type HttpResponse, path, type RequestOptions } from "../http.ts";
import { unwrap } from "../types.ts";
import type { EndpointTarget } from "./endpoints.ts";

/**
 * The slice of `W6WClient` this namespace needs: the transport, and nothing
 * else. Structural rather than a concrete client type, so the namespace
 * stays independently constructible in a test and this module never
 * imports the client back — mirrors `FunctionsHost` in `./functions.ts`.
 */
export interface AliasesHost {
  /** Perform one request. */
  request<T>(options: RequestOptions): Promise<HttpResponse<T>>;
}

/**
 * An alias definition — an account-scoped name bound to one runnable
 * target (an app Action, a Function or a Workflow — the same
 * {@linkcode EndpointTarget} union `console.endpoints` dispatches to), so
 * `run`'s URN dispatch can resolve it by name instead of by id.
 *
 * `name` is **immutable after first save** (HITL-3): a save that changes
 * `name` on an already-stored alias answers `409 alias_name_immutable`.
 */
export interface AliasDef {
  id: string;
  name: string;
  displayName?: string;
  description?: string;
  target: EndpointTarget;
}

/** One row of `list`'s result — an alias's summary, not its full definition. */
export interface AliasSummary {
  id: string;
  name: string;
  displayName: string;
  description: string;
  updatedAt: string;
}

/**
 * The `console.aliases` namespace on a `W6WClient`.
 *
 * @example
 * ```ts
 * const aliases = await client.console.aliases.list();
 * const alias = await client.console.aliases.get(aliases[0].id);
 * await client.console.aliases.upsert({ ...alias, description: "Send email" });
 * await client.console.aliases.delete(alias.id);
 * ```
 */
export class AliasesApi {
  readonly #host: AliasesHost;

  /**
   * @param host - The client this namespace issues requests through.
   */
  constructor(host: AliasesHost) {
    this.#host = host;
  }

  /**
   * List the caller's aliases.
   *
   * @returns The aliases, unwrapped from the `aliases` envelope.
   */
  async list(): Promise<AliasSummary[]> {
    const res = await this.#host.request<unknown>({ method: "GET", path: "/aliases" });
    return unwrap<AliasSummary[]>(res, "aliases");
  }

  /**
   * Fetch one alias's stored definition.
   *
   * No server-computed field to splice in — unlike
   * {@linkcode FunctionsApi.get}'s `valid` merge, this returns
   * `unwrap<AliasDef>(res, "alias")` plainly.
   *
   * @param id - The alias's `id`.
   * @returns The alias definition, unwrapped from the `alias` envelope.
   * @throws {ApiError} `404 unknown_alias` when there is no such id.
   */
  async get(id: string): Promise<AliasDef> {
    const res = await this.#host.request<unknown>({ method: "GET", path: path`/aliases/${id}` });
    return unwrap<AliasDef>(res, "alias");
  }

  /**
   * Register (create or overwrite) an alias definition.
   *
   * `definition` is the whole definition, sent verbatim as the request body
   * — not wrapped in an envelope key.
   *
   * @param definition - The whole alias definition, forwarded verbatim.
   * @returns The new/updated alias's id and name.
   * @throws {ApiError} `400 invalid_alias` — structurally invalid body.
   * @throws {ApiError} `409 alias_conflict` — another `(tenant,subject)` owns this id.
   * @throws {ApiError} `409 alias_name_conflict` — another alias already owns this name.
   * @throws {ApiError} `409 alias_name_immutable` — `name` changed on an already-stored alias (HITL-3).
   */
  async upsert(definition: AliasDef): Promise<{ id: string; name: string }> {
    const res = await this.#host.request<unknown>({
      method: "POST",
      path: "/aliases",
      body: definition,
    });
    return unwrap<{ id: string; name: string }>(res, "alias");
  }

  /**
   * Delete an alias.
   *
   * Returns nothing: the server's `{ok: true}` carries no information a
   * caller can use, mirroring `console.vault.delete`/`console.projects.delete`
   * in this same package.
   *
   * @param id - The alias's `id`.
   * @throws {ApiError} `404 unknown_alias` when there is no such id.
   */
  async delete(id: string): Promise<void> {
    await this.#host.request<unknown>({ method: "DELETE", path: path`/aliases/${id}` });
  }
}
