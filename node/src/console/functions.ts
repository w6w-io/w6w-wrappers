/**
 * `client.console.functions.*` — the canonical, vendor-stable Function
 * definition surface (`list`/`get`/`upsert`), relocated from the studio's own
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
 * **`invoke` is deliberately NOT modeled here.** The base
 * `client.run({urn, payload})` (already-published surface,
 * `endpoints.json`-named, exported from the root `mod.ts`) dispatches a
 * `fn_…` URN through the exact same `InvokeFunctionService` the dedicated
 * `/functions/:id/invoke` route uses, returning `{kind:"function", output}` —
 * field-for-field identical to what the dedicated route returns. Adding a
 * duplicate `console.functions.invoke` would give a caller two ways to reach
 * the same route, the anti-duplication defect this project's own rules flag
 * — mirrors `console.workflows`'s established precedent of NOT re-wrapping
 * base `list`/`run`. Studio composes `client.run()` + `isFunctionRun` itself;
 * no invoke method lives here, and none should be added later without
 * re-litigating this reasoning.
 *
 * **The base namespace now carries this lifecycle too.** At contract `0.5.0`
 * `functions` left `endpoints.json`'s `outOfScope` and
 * `client.functions.list`/`get`/`create`/`update`/`delete` landed in all three
 * lanes (`../functions.ts`). These three stay for studio's sake and differ in
 * shape, deliberately: `get` here splices `valid` INTO the definition (what
 * studio's editor binds to), while the base `get` keeps it a sibling so a
 * read-modify-write round trip cannot carry it back into a save. New callers,
 * and every partner, want `client.functions.*`.
 *
 * Three methods relocate from the studio's `// Functions` comment block
 * (`packages/studio/src/api/client.ts:255-268`): `listFunctions`→`list`,
 * `getFunction`→`get`, `saveFunction`→`upsert`.
 *
 * None of the three methods take a client-side default-project fallback or a
 * `?project=` scoping parameter — neither is reachable via either HTTP route
 * — so `FunctionsHost` needs only the transport, mirroring
 * `WorkflowsHost`/`SchedulesHost`, not the base `DocumentsHost`.
 *
 * @module
 */

import { type HttpResponse, path, type RequestOptions } from "../http.ts";
import { unwrap } from "../types.ts";
import type { Callable, CallableOnError, ErrorReroute, RetryPolicy } from "./endpoints.ts";

/**
 * The slice of `W6WClient` this namespace needs: the transport, and nothing
 * else. Structural rather than a concrete client type, so the namespace stays
 * independently constructible in a test and this module never imports the
 * client back — mirrors `WorkflowsHost` in `./workflows.ts`.
 */
export interface FunctionsHost {
  /** Perform one request. */
  request<T>(options: RequestOptions): Promise<HttpResponse<T>>;
}

/** One declared input a Function accepts. */
export interface FunctionInput {
  key: string;
  label: string;
  type: "string" | "text" | "number" | "boolean" | "json" | "secret" | string;
  required?: boolean;
  default?: unknown;
  hint?: string;
}

/** One declared field of a Function's output shape. */
export interface FunctionOutputField {
  key: string;
  type: "string" | "number" | "boolean" | "object" | "array" | string;
  label?: string;
}

/** The app-Action arm — the historical shape. `kind` is ABSENT on every Function
 *  stored before this union existed, and absent MEANS "action". */
export interface FunctionActionImpl {
  kind?: "action";
  uses: { app: string; action: string; connection?: string | null };
  with?: Record<string, unknown>;
  outputMap?: Record<string, unknown>;
}

/** The Function / Workflow arms — {@linkcode Callable} reused verbatim, carrying the
 *  same two adapter maps the action arm has. */
export type FunctionCallableImpl = Callable & {
  with?: Record<string, unknown>;
  outputMap?: Record<string, unknown>;
};

/** What a Function is bound to: one app Action, another Function, or a Workflow,
 *  plus the mapping around it (D-8). */
export type FunctionImpl = FunctionActionImpl | FunctionCallableImpl;

/** The ONE discriminator every consumer branches on — never re-derive it. */
export function isCallableImpl(impl: FunctionImpl): impl is FunctionCallableImpl {
  return impl.kind === "function" || impl.kind === "workflow";
}

/**
 * A Function definition — a canonical, vendor-stable interface bound to one
 * swappable implementation: an app Action, or (D-8) another Function or a
 * Workflow via {@linkcode FunctionCallableImpl} (`rfcs/function.md`). Callers
 * bind to `inputs`/`output`; a vendor swap rewrites only `impl`, so no caller
 * breaks.
 *
 * `valid` is **server-computed**, spliced in by {@linkcode FunctionsApi.get}
 * — see that method's doc. It is never sent by a caller on `upsert`.
 */
export interface FunctionDef {
  manifestVersion: string;
  id: string;
  key: string;
  displayName?: string;
  description?: string;
  inputs: FunctionInput[];
  output?: FunctionOutputField[];
  impl: FunctionImpl;
  /** Attempt policy for this call. Absent ⇒ one attempt. */
  retry?: RetryPolicy;
  /** Applied only after `retry` and `reroute` are exhausted. Absent ⇒ `"fail"`. */
  onError?: CallableOnError;
  /** Failure re-dispatch. Absent ⇒ none. */
  reroute?: ErrorReroute;
  /** Server-computed, spliced in by `console.functions.get` — see above. Read-only. */
  valid: boolean;
}

/** One row of `list`'s result — a Function's summary, not its full definition. */
export interface FunctionSummary {
  id: string;
  key: string;
  displayName: string;
  description: string;
  updatedAt: string;
  valid: boolean;
}

/**
 * The `console.functions` namespace on a `W6WClient`.
 *
 * @example
 * ```ts
 * const fns = await client.console.functions.list();
 * const fn = await client.console.functions.get(fns[0].id);
 * await client.console.functions.upsert({ ...fn, description: "Send an email" });
 * ```
 */
export class FunctionsApi {
  readonly #host: FunctionsHost;

  /**
   * @param host - The client this namespace issues requests through.
   */
  constructor(host: FunctionsHost) {
    this.#host = host;
  }

  /**
   * List the caller's Function definitions.
   *
   * Each row already carries `valid` — server-computed
   * (`db/repos/functions.ts`'s `list()`) — same as {@linkcode get}'s splice,
   * but here it arrives already flat on the summary row, nothing to merge.
   *
   * @returns The Functions, unwrapped from the `functions` envelope.
   */
  async list(): Promise<FunctionSummary[]> {
    const res = await this.#host.request<unknown>({ method: "GET", path: "/functions" });
    return unwrap<FunctionSummary[]>(res, "functions");
  }

  /**
   * Fetch one Function's stored definition.
   *
   * **`valid` is a TOP-LEVEL SIBLING of `function` on the wire, never spliced
   * into the stored definition itself** (`admin/functions.ts:82-93`) — but
   * this method DOES splice it into its own return value, for caller
   * convenience: `{...body.function, valid: body.valid}`. This is a
   * deliberate, behavior-preserving relocation of studio's own current
   * `getFunction` (`client.ts:259-262`), not a redesign — a raw
   * `{function, valid}` return would be a regression.
   *
   * No 404 special-casing — propagates as `ApiError` like every other "get"
   * in this package except `console.schedules.get`'s documented exception.
   *
   * @param id - The `fn_…` id.
   * @returns The Function definition with `valid` merged in at the top level.
   * @throws {ApiError} `404 unknown_function` when there is no such id.
   */
  async get(id: string): Promise<FunctionDef> {
    const res = await this.#host.request<{ function: FunctionDef; valid: boolean }>({
      method: "GET",
      path: path`/functions/${id}`,
    });
    return { ...res.body.function, valid: res.body.valid };
  }

  /**
   * Register (create or overwrite) a Function definition.
   *
   * `definition` is the whole definition, sent verbatim as the request body —
   * not wrapped in an envelope key.
   *
   * @param definition - The whole Function definition, forwarded verbatim.
   * @returns The new/updated Function's id and key.
   * @throws {ApiError} `400 invalid_function` — structurally invalid body.
   * @throws {ApiError} `409 function_conflict` — another `(tenant,subject)` owns this id.
   */
  async upsert(definition: FunctionDef): Promise<{ id: string; key: string }> {
    const res = await this.#host.request<unknown>({
      method: "POST",
      path: "/functions",
      body: definition,
    });
    return unwrap<{ id: string; key: string }>(res, "function");
  }
}
