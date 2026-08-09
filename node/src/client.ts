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
import { ConnectionsApi } from "./connections.ts";
import { ConsoleApi } from "./console/mod.ts";
import { DocumentsApi } from "./documents.ts";
import { ConfigError } from "./errors.ts";
import { type HttpResponse, request, type RequestOptions } from "./http.ts";
import { fetchMe } from "./me.ts";
import { type RunInput, runUrn } from "./run.ts";
import type { Me, RunEnvelope } from "./types.ts";
import { VarsApi } from "./vars.ts";
import { WorkflowsApi } from "./workflows.ts";

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

  /**
   * The document store: `list`, `get`, `getByKey`, `create`, `update`,
   * `delete`. Project-scoped — every call accepts an optional `project` that
   * overrides this client's default.
   */
  readonly documents: DocumentsApi;

  /**
   * Typed variables: `list`, `get`, `getByName`, `create`, `update`, `delete`.
   * **No `project` option anywhere** — variables are scoped by tenant/subject
   * only, and the namespace is constructed without this client's configuration
   * so it cannot reach a default scope to send (`docs/implementation.md` §7).
   */
  readonly vars: VarsApi;

  /**
   * Connections: `list` only in this version. Read-only on purpose — creating
   * or testing a connection is an interactive, secret-handling flow that
   * `endpoints.json` puts out of scope for v0.1.0.
   */
  readonly connections: ConnectionsApi;

  /**
   * Workflows: `list` and `run`. `list` is project-scoped and accepts an
   * optional `project` that overrides this client's default; `run` is addressed
   * by `wf_…` id and takes `wait`, `variables`, `trigger` and `input`.
   *
   * `variables` and `input` are not interchangeable: `variables` lands as
   * `vars.*` in the run scope, while `input` is delivered to the entry
   * `@w6w/trigger` step and read downstream as `steps.<triggerId>.output.<key>`.
   */
  readonly workflows: WorkflowsApi;

  /**
   * Console-only namespaces: `console.reliability.list`, `console.auth.*`
   * (`login`, `signup`, `checkAccountSlug`, `createAccount`),
   * `console.dashboard.stats`, `console.projects.*` (`list`, `create`,
   * `delete`) and `console.schedules.*` (`get`, `upsert`, `delete`).
   * Studio-internal and unstable — not part of the published partner
   * contract, excluded from `endpoints.json` and from this package's root
   * barrel (`docs/console.md`, HITL-1). Reached only through
   * `@w6w/sdk/console`'s re-exports, and constructed with the transport only,
   * exactly like `vars` and `connections`.
   */
  readonly console: ConsoleApi;

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

    // Namespaces are per-instance and hold this client, so they inherit its
    // credential and base URL — never a module-level one. `vars` and
    // `connections` are handed the transport only; `documents` and `workflows`
    // additionally see the configuration, because they are the project-scoped
    // half of the surface and have a default project to apply.
    this.documents = new DocumentsApi(this);
    this.vars = new VarsApi(this);
    this.connections = new ConnectionsApi(this);
    this.workflows = new WorkflowsApi(this);
    this.console = new ConsoleApi(this);
  }

  /**
   * Who this client's credential says you are, plus the versions of the
   * components that answered.
   *
   * A method on the client rather than a namespace, because that is the symbol
   * `endpoints.json` names (`client.me()`). The response body is flat and
   * carries no envelope; the only thing added to it locally is
   * `versions.wrapper`, this package's own version, which is filled in and
   * never overwrites a key the server supplied.
   *
   * @returns The caller's identity.
   * @throws {ConfigError} When no token is configured.
   * @throws {ApiError} On any non-2xx, e.g. a `401` when the token is rejected.
   */
  me(): Promise<Me> {
    return fetchMe(this);
  }

  /**
   * Run whatever a URN addresses — a connection action, a function, an endpoint
   * or a workflow — and get back the kind-tagged envelope.
   *
   * A method on the client rather than a namespace, because that is the symbol
   * `endpoints.json` names (`client.run(input)`). It is the dispatching
   * counterpart to `workflows.run`, which stays separate because `?wait=`,
   * `variables` and `trigger` have no slot in this three-field shape (D4).
   *
   * Discriminate the result with `isActionRun` / `isFunctionRun` /
   * `isWorkflowRun`; a `kind` this version has never heard of is handed back
   * verbatim rather than raised.
   *
   * `POST /api/run` (verified live 2026-07-28).
   *
   * @param input - The URN, an optional `action`, and the payload.
   * @returns The `RunEnvelope`, exactly as it arrived.
   * @throws {ConfigError} When no token is configured.
   * @throws {ApiError} On any non-2xx, e.g. `404` for an unresolvable URN or
   * `424` when the target app failed during execute.
   */
  run(input: RunInput): Promise<RunEnvelope> {
    return runUrn(this, input);
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
