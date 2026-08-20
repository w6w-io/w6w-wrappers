/**
 * `client.console.endpoints.*` — the named, stable callable-entry-point
 * surface (`list`/`get`/`upsert`/`invoke`), relocated from the studio's own
 * API client.
 *
 * **Studio-internal, not the published partner contract.** This namespace
 * lives under the `console` subpath export (`@w6w/sdk/console`), excluded
 * from `endpoints.json` and from the root barrel (`mod.ts`) — see
 * `docs/console.md` and HITL-1 in this task's contract. `@w6w/sdk`'s
 * instance-state mechanism pin still applies here exactly as it does to
 * every other namespace (`docs/implementation.md` §MECHANISM PIN — instance
 * state, never globals): this class holds no state of its own beyond the
 * injected host, so two clients in one process never share a credential.
 *
 * **`invoke`'s wire path is a PINNED mechanism, not a choice — read this
 * before touching `invoke` below.** {@linkcode EndpointsApi.invoke} MUST call
 * `POST /endpoints/:id/invoke` directly. It must NEVER be implemented by
 * delegating to `client.run()`/`runUrn()`/`POST /run`, even though that
 * dispatcher can also resolve an `ep_…` URN. Verified directly against the
 * server: `packages/server/packages/bll/resolve-run.ts`'s `ep_` arm
 * (`:198-207`) delegates to `InvokeEndpointService.invoke()` but then
 * **remaps** the action-kind result's field from `output` to `value`
 * (`return { kind: "action", value: result.output };`) to match `run()`'s own
 * `ActionRunEnvelope` shape. The dedicated `/endpoints/:id/invoke` route
 * (`packages/server/packages/api/admin/endpoints.ts:319-360`) does NOT do
 * this remap — it returns `InvokeEndpointResult` VERBATIM (`{kind:"action",
 * output}` for an action target). Studio's `EndpointsPage.tsx` renders the
 * raw envelope it gets back directly (`JSON.stringify(result, null, 2)`), so
 * this field name is user-visible. Routing `invoke` through `/run` instead of
 * the dedicated route would silently rename `output` to `value` and break
 * that page — a "simplification" that looks harmless and is not.
 *
 * Four methods relocate from the studio's `// Endpoints` comment block
 * (`packages/studio/src/api/client.ts:281-314`): `listEndpoints`→`list`,
 * `getEndpoint`→`get`, `saveEndpoint`→`upsert`, `invokeEndpoint`→`invoke`.
 *
 * None of the four methods take a client-side default-project fallback or a
 * `?project=` scoping parameter — neither is reachable via any HTTP route on
 * this domain — so `EndpointsHost` needs only the transport, mirroring
 * `WorkflowsHost`/`SchedulesHost`, not the base `DocumentsHost`.
 *
 * @module
 */

import { type HttpResponse, path, type RequestOptions } from "../http.ts";
import { unwrap } from "../types.ts";

/**
 * The slice of `W6WClient` this namespace needs: the transport, and nothing
 * else. Structural rather than a concrete client type, so the namespace stays
 * independently constructible in a test and this module never imports the
 * client back — mirrors `WorkflowsHost` in `./workflows.ts`.
 */
export interface EndpointsHost {
  /** Perform one request. */
  request<T>(options: RequestOptions): Promise<HttpResponse<T>>;
}

/** What an Endpoint dispatches to, when the target is a Function or Workflow. */
export type Callable =
  | { kind: "function"; function: string }
  | { kind: "workflow"; workflow: string };

/** What an Endpoint dispatches to, when the target is a direct app Action. */
export interface ActionTarget {
  kind: "action";
  uses: { app: string; action: string; connection?: string | null };
  with?: Record<string, unknown>;
}

/**
 * The alias-only fourth arm: dispatch to another Endpoint by id.
 * LEGAL FOR AN ALIAS'S `target` ONLY. `POST /endpoints` refuses it
 * (api/admin/endpoints.ts's validateDefinition) and that refusal is the sole
 * bound on Endpoint→Endpoint recursion; a regression test pins it (D-14).
 */
export interface EndpointRefTarget {
  kind: "endpoint";
  endpoint: string; // ep_…
}

/**
 * The full discriminated union of what an Endpoint may dispatch to. Shared by
 * `EndpointDef.target` and `AliasDef.target` — but the `endpoint` arm is
 * legal only for the latter: an Endpoint's own target can never be another
 * Endpoint (see {@linkcode EndpointRefTarget}).
 */
export type EndpointTarget = Callable | ActionTarget | EndpointRefTarget;

/**
 * Attempt policy for a Function/Endpoint call. Absent ⇒ one attempt. Mirrors
 * `@w6w/workflow-types`' `RetryPolicy` (the workflow step's own retry shape)
 * field-for-field.
 */
export interface RetryPolicy {
  /** Total attempts including the first. `1` means no retry. */
  maxAttempts: number;
  /** How the delay grows between attempts. Defaults to `"fixed"`. */
  backoff?: "fixed" | "exponential";
  /** Base delay in ms (the first retry waits this long). Defaults to 0. */
  delayMs?: number;
}

/**
 * Where a failed Function/Endpoint invocation is re-dispatched. A Function
 * and an Endpoint have no graph, so this can never be an `Edge.when: "error"`;
 * it is a {@linkcode Callable} reference — the same union `Endpoint.target`
 * already uses.
 */
export interface ErrorReroute {
  /** Invoked once, after `retry` is exhausted. Its output becomes the call's output. */
  target: Callable;
  /** Maps `{ inputs, error }` onto the reroute target's own inputs. Omitted ⇒ the
   *  original `inputs` are passed through unchanged. */
  with?: Record<string, unknown>;
}

/**
 * What a failed Function/Endpoint invocation does once `retry` and `reroute`
 * are exhausted. Deliberately NARROWER than a workflow step's `OnError`:
 * `continue-record` has no meaning without a run's `stepErrors` state.
 * - `fail` (default, and the meaning of absent) — the error propagates, as today.
 * - `continue` — the invocation resolves with a `null` output instead of throwing.
 */
export type CallableOnError = "fail" | "continue";

/** The inbound auth mode an Endpoint's public exposure enforces. */
export type EndpointAuthMode = "platform" | "none" | "basic" | "header" | "jwt";

/**
 * An Endpoint's inbound security policy. Secret-carrying fields
 * (`basicPassword`, `headerValue`, `jwtSecret`) come back from a `GET` masked
 * with {@linkcode SECRET_MASK}, never as plaintext or ciphertext — sending the
 * mask back on `upsert` preserves whatever is already stored.
 */
export interface EndpointSecurity {
  auth: EndpointAuthMode;
  basicUser?: string;
  basicPassword?: string;
  headerName?: string;
  headerValue?: string;
  jwtSecret?: string;
}

/**
 * The placeholder a `GET` returns in place of a configured secret, and which
 * an `upsert` may send back to mean "keep what is stored". Relocated
 * verbatim from `admin/endpoints.ts`'s own exported constant — same value,
 * same meaning.
 */
export const SECRET_MASK = "__stored__";

/** How an Endpoint may additionally be reachable, declaratively. */
export interface Exposure {
  http?: { method?: "POST" | "GET"; path?: string; auth?: "none" | "token" | "tenant" };
  security?: EndpointSecurity;
}

/** One declared input an Endpoint accepts. */
export interface EndpointInput {
  key: string;
  label: string;
  type: string;
  required?: boolean;
  default?: unknown;
  hint?: string;
}

/**
 * An Endpoint definition — a named, stable callable entry point that
 * dispatches to a target (`rfcs/endpoint.md`). `target` is typed with the
 * full {@linkcode EndpointTarget} union shared with `AliasDef.target`, but an
 * Endpoint's own target can never be another Endpoint: the `endpoint` arm
 * ({@linkcode EndpointRefTarget}) is legal only for an alias's `target`, and
 * `POST /endpoints` refuses it here. Callers bind to the Endpoint id; the
 * target beneath it can change without breaking them.
 *
 * `key` is **immutable after first save** — it is a public URL segment. A
 * save that changes `key` on an already-stored Endpoint answers `409
 * key_immutable`; a first save with a malformed `key` answers `400
 * invalid_endpoint`.
 */
export interface EndpointDef {
  manifestVersion: string;
  id: string;
  key: string;
  displayName?: string;
  description?: string;
  target: EndpointTarget;
  input?: EndpointInput[];
  exposure?: Exposure;
  /** Attempt policy for this call. Absent ⇒ one attempt. */
  retry?: RetryPolicy;
  /** Applied only after `retry` and `reroute` are exhausted. Absent ⇒ `"fail"`. */
  onError?: CallableOnError;
  /** Failure re-dispatch. Absent ⇒ none. */
  reroute?: ErrorReroute;
}

/**
 * One row of `list`'s result — an Endpoint's summary, not its full
 * definition. Each row already carries its own `invokeUrl`, merged in
 * server-side.
 */
export interface EndpointSummary {
  id: string;
  key: string;
  displayName: string;
  description: string;
  updatedAt: string;
  invokeUrl: string;
}

/**
 * What {@linkcode EndpointsApi.invoke} resolves to — the discriminated result
 * of dispatching one Endpoint, returned VERBATIM from the dedicated invoke
 * route. `output` (action/function) and `runId` (workflow) are the server's
 * own field names — never renamed, never normalised, per this module's
 * header pin.
 */
export type EndpointInvokeResult =
  | { kind: "action"; output: unknown }
  | { kind: "function"; output: unknown }
  | { kind: "workflow"; runId: string };

/**
 * The `console.endpoints` namespace on a `W6WClient`.
 *
 * @example
 * ```ts
 * const endpoints = await client.console.endpoints.list();
 * const { endpoint, invokeUrl } = await client.console.endpoints.get(endpoints[0].id);
 * const result = await client.console.endpoints.invoke(endpoint.id, { to: "a@b.com" });
 * ```
 */
export class EndpointsApi {
  readonly #host: EndpointsHost;

  /**
   * @param host - The client this namespace issues requests through.
   */
  constructor(host: EndpointsHost) {
    this.#host = host;
  }

  /**
   * List the caller's Endpoint definitions.
   *
   * @returns The Endpoints, unwrapped from the `endpoints` envelope; each row
   * carries its own `invokeUrl`/`invokeUrlByKey`, preserved untouched.
   */
  async list(): Promise<EndpointSummary[]> {
    const res = await this.#host.request<unknown>({ method: "GET", path: "/endpoints" });
    return unwrap<EndpointSummary[]>(res, "endpoints");
  }

  /**
   * Fetch one Endpoint's stored definition plus its callable URL(s). Any
   * configured secret comes back masked with {@linkcode SECRET_MASK}, never
   * as plaintext or ciphertext.
   *
   * **Returns the response body VERBATIM — a three-key top-level shape, NOT
   * merged.** `invokeUrl`/`invokeUrlByKey` are never spliced into `endpoint`;
   * this mirrors `console.workflows.get`'s "no envelope key to peel, multiple
   * top-level siblings" precedent, deliberately NOT
   * `console.functions.get`'s merge — these are two different,
   * individually-verified, individually-pinned shapes. `invokeUrl` is ALWAYS
   * present; `invokeUrlByKey` is present only when the owning account has a
   * slug — genuinely absent from the body otherwise, never an
   * `undefined`-valued key.
   *
   * No 404 special-casing — propagates as `ApiError` like every other "get"
   * in this package except `console.schedules.get`'s documented exception.
   *
   * @param id - The `ep_…` id.
   * @returns The whole response body — no envelope key to peel.
   * @throws {ApiError} `404 unknown_endpoint` when there is no such id.
   */
  async get(
    id: string,
  ): Promise<{ endpoint: EndpointDef; invokeUrl: string; invokeUrlByKey?: string }> {
    const res = await this.#host.request<
      { endpoint: EndpointDef; invokeUrl: string; invokeUrlByKey?: string }
    >({
      method: "GET",
      path: path`/endpoints/${id}`,
    });
    return res.body;
  }

  /**
   * Register (create or overwrite) an Endpoint definition.
   *
   * `definition` is the whole definition, sent verbatim as the request body —
   * not wrapped in an envelope key. **Returns the response body VERBATIM**,
   * same three-key shape as {@linkcode get} — no merge, no `unwrap()`.
   *
   * None of the four error codes below need special client-side handling —
   * they propagate as an ordinary `ApiError` with the server's own
   * `.message`, exactly like every other write in this package; this method
   * does not branch on any of them.
   *
   * @param definition - The whole Endpoint definition, forwarded verbatim.
   * @returns The new/updated Endpoint's id and key, plus its callable URL(s).
   * @throws {ApiError} `400 invalid_endpoint` — structurally invalid body, or (first save only) a malformed `key`.
   * @throws {ApiError} `409 key_immutable` — `key` differs from the already-stored row's `key`.
   * @throws {ApiError} `409 endpoint_conflict` — another `(tenant,subject)` owns this id.
   * @throws {ApiError} `409 endpoint_key_conflict` — another Endpoint already holds this `key`.
   */
  async upsert(
    definition: EndpointDef,
  ): Promise<
    { endpoint: { id: string; key: string }; invokeUrl: string; invokeUrlByKey?: string }
  > {
    const res = await this.#host.request<
      { endpoint: { id: string; key: string }; invokeUrl: string; invokeUrlByKey?: string }
    >({
      method: "POST",
      path: "/endpoints",
      body: definition,
    });
    return res.body;
  }

  /**
   * Invoke an Endpoint: dispatches to its configured target (an app Action, a
   * Function, or a Workflow) and returns the discriminated result.
   *
   * **Calls the DEDICATED `POST /endpoints/:id/invoke` route directly — see
   * this module's header for why it must NEVER delegate to `client.run()`/
   * `runUrn()`/`POST /run` instead.** The response body is returned
   * VERBATIM, field names untouched: an `action`/`function` target answers
   * `200` with `{kind, output}`; a `workflow` target answers `202` with
   * `{kind:"workflow", runId}` — both are success on this API, mirroring
   * `console.workflows`'s/base `run()`'s own "202 is success" convention.
   *
   * @param id - The `ep_…` id.
   * @param input - The Endpoint's declared inputs, forwarded verbatim as `{input}`.
   * @returns The discriminated dispatch result, unmodified from the wire.
   * @throws {ApiError} `404 unknown_endpoint` / `404 unknown_function` / `404 unknown_workflow`.
   * @throws {ApiError} `422 function_incomplete` — the target Function is not runnable.
   */
  async invoke(id: string, input: Record<string, unknown>): Promise<EndpointInvokeResult> {
    const res = await this.#host.request<EndpointInvokeResult>({
      method: "POST",
      path: path`/endpoints/${id}/invoke`,
      body: { input },
    });
    return res.body;
  }
}
