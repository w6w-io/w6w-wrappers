/**
 * `client.workflows.*` — discovery, the typed run, and the definition lifecycle.
 *
 * Seven operations: `list` (T2.1.4) and `run` (T2.1.5), plus `get`, `create`,
 * `update`, `archive` and `delete`. `list` earns its place in a minimal surface
 * for the same reason `connections.list` does (D4): it is how a caller
 * discovers a `wf_…` id to pass to `run`.
 *
 * ── The write path, and the two things the server does NOT do ──
 * 1. **It does not mint ids.** `POST /workflows` requires `id` in the body, so
 *    `create` mints one (`mintId("wf")`) when the definition has none. Every
 *    consumer that talked to this route directly had already written that
 *    themselves — studio's `newWorkflowId` is the same four lines.
 * 2. **It does not patch.** There is ONE write route and it stores what it is
 *    given, so `update` is a full replacement. `create` and `update` are the
 *    same POST; what differs is that one mints the id and the other pins it.
 *
 * Deleting is two calls, `archive` then `delete`, and this module keeps it that
 * way — see {@linkcode WorkflowsApi.delete}.
 *
 * ── `run`, and the three things this API gets called wrong ──
 * 1. **`202` is success.** No `wait` → the run is queued and the server answers
 *    `202 {runId, status:"queued"}`. With `?wait=true` and a timeout → `202`
 *    again, with the current status. Neither raises.
 * 2. **A failed run is data.** `?wait=true` on a run that failed is a plain
 *    `200` carrying `status: "failed"` and an `error`. This module returns it
 *    like any other result. Mapping it to an exit code is the CLI's job
 *    (`cli.exitCodes` in `endpoints.json`), not the SDK's.
 * 3. **No client-side polling.** The server already polls internally for
 *    `?wait=true`, up to its own `RUN_WAIT_TIMEOUT_SEC`. The studio's 600 × 500 ms
 *    browser loop predates that and is deliberately **not** transcribed
 *    (`docs/implementation.md` §4): three wrappers each re-implementing a poll
 *    would be three timeout policies and three retry-storm bugs to keep in sync.
 *    There is no timer, no delay and no retry anywhere in this package — a `202`
 *    hands the caller `runId` and lets them decide.
 *
 * Workflows are **project-scoped**, like documents and unlike vars: the route
 * accepts an optional `?project=`, resolved per call, then from the client's
 * default, and otherwise left to the server. This host therefore sees the
 * client's resolved configuration, which `connections` and `vars` deliberately
 * do not.
 *
 * ── Pagination ──
 * The route is **not paginated today** and this module does not pretend
 * otherwise: there is no `cursor` argument, no `cursor` field, and no
 * client-side paging loop. `list` returns the unwrapped array, exactly as
 * `docs/implementation.md` §6 pins it.
 *
 * That is not a corner this signature is painted into. A JavaScript array is an
 * object, so the day the server grows a cursor the wrapper can return an array
 * that carries it (`WorkflowSummary[] & {cursor?: string}`) and widen this
 * return type to match — every existing caller, which only ever reads the list,
 * keeps compiling and keeps working. Inventing the field now would put a key on
 * the type that no server has ever sent, which is the failure mode
 * `endpoints.json` actually warns about.
 *
 * @module
 */

import type { ResolvedConfig } from "./config.ts";
import { ApiError } from "./errors.ts";
import { type HttpResponse, path, type RequestOptions } from "./http.ts";
import {
  isTerminalRunStatus,
  mintId,
  type RunResult,
  type RunStatus,
  unwrap,
  type WorkflowSummary,
} from "./types.ts";

/**
 * The precondition header the write path sends when `ifUnmodifiedSince` is given.
 *
 * Deliberately not the standard `If-Unmodified-Since`: that header's HTTP-date
 * format has one-second granularity, and two saves inside one second is the
 * exact case this guards (`admin/workflows.ts`).
 */
const PRECONDITION_HEADER = "x-w6w-if-unmodified-since";

/**
 * The slice of `W6WClient` this namespace needs: the transport, plus the
 * resolved configuration it reads the **default project** out of. Structural
 * rather than a concrete client type, so the namespace stays independently
 * constructible in a test and this module never imports the client back.
 */
export interface WorkflowsHost {
  /** The resolved configuration; only `project` is read. */
  readonly config: ResolvedConfig;
  /** Perform one request. */
  request<T>(options: RequestOptions): Promise<HttpResponse<T>>;
}

/**
 * Per-call options for `workflows.list`.
 *
 * A named interface rather than a bare `project?: string` parameter, so the
 * operation can accept a further argument later without changing its arity.
 */
export interface WorkflowListOptions {
  /** Project id to scope this call to; overrides the client's default. */
  project?: string;
}

/**
 * Per-call options for `workflows.run`.
 *
 * **No `project` here, on purpose.** A `wf_…` id is unambiguous on its own, and
 * `endpoints.json` gives this operation exactly five parameters — `id`, `wait`,
 * `variables`, `trigger`, `input`. Sending a `?project=` the route does not read
 * would be inventing a parameter.
 */
export interface WorkflowRunOptions {
  /**
   * Wait for the run to reach a terminal state before answering.
   *
   * Sent as `?wait=true` **only when `true`**: the server compares the raw query
   * value to the string `"true"`, so `?wait=false` would mean the same thing as
   * omitting it while looking like it meant something else.
   *
   * The wait happens **server-side**, bounded by the server's own timeout. On a
   * timeout the answer is a `202` carrying the current status, which is a normal
   * outcome — see {@linkcode WorkflowRunResult.terminal}.
   */
  wait?: boolean;
  /** Variables handed to the run, merged into its scope by the engine. Opaque pass-through. */
  variables?: Record<string, unknown>;
  /**
   * What triggered the run; defaults to `"manual"` server-side.
   *
   * Typed as a plain `string` rather than a closed union: the value is a
   * server-owned enum (`"manual" | "schedule" | "webhook" | "event" | "replay"`
   * today) that the server may extend, and an SDK that froze the set would
   * reject a value a newer server accepts.
   */
  trigger?: string;
  /**
   * Delivered to the entry trigger node's own recorded output, read downstream
   * as `steps.<triggerId>.output.<key>` — the shape a trigger's declared fields
   * actually arrive in. Not the same slot as {@linkcode variables}, which seeds
   * the run's variable scope (`vars.*`) instead.
   */
  input?: Record<string, unknown>;
}

/**
 * What `workflows.run` returns: the server's flat body, plus two signals derived
 * locally.
 *
 * It **is** a `RunResult` — the wire fields are present under their wire names,
 * unwrapped from nothing (this route has no envelope). The two extra fields
 * exist because a caller otherwise cannot tell a queued run from a finished one
 * without re-deriving the rule:
 *
 * - {@linkcode terminal} answers "has this run finished?" from the **run's own
 *   status**, which is the question a caller actually has.
 * - {@linkcode httpStatus} is the transport's own answer (`200` finished in
 *   time, `202` still going), kept because it is the distinction the server
 *   makes and dropping it would leave a caller unable to tell a `?wait=` timeout
 *   from a run that was never waited on.
 */
export interface WorkflowRunResult extends RunResult {
  /** `true` when `status` is `succeeded`, `failed` or `canceled`. */
  terminal: boolean;
  /** The HTTP status that carried this body: `200` terminal, `202` queued or still running. */
  httpStatus: number;
}

/**
 * A workflow definition — the portable document, kept OPAQUE.
 *
 * `Record<string, unknown>` and not a modelled shape, on purpose. A workflow's
 * body is `steps[]` of node types the engine owns and extends
 * (`rfcs/node-types.md`); a wrapper that froze that shape would reject a
 * workflow a newer server accepts, and would have to ship a release every time
 * a node type gained a field. What the wrapper *does* pin is the envelope
 * around it — {@linkcode WorkflowDetail}, {@linkcode WorkflowSaveResult} —
 * because that is the part the wrapper is responsible for.
 *
 * The one field this package reads out of it is `id`, in
 * {@linkcode WorkflowsApi.create}, to decide whether to mint one.
 */
export type WorkflowDefinition = Record<string, unknown>;

/** What `workflows.get` returns: the definition, plus the two things that are not in it. */
export interface WorkflowDetail {
  /** The stored definition, overlaid with the authoritative `status` and `tags`. */
  workflow: WorkflowDefinition;
  /** Where this workflow was imported from, when it was imported at all. */
  sourceRef: string | null;
  /**
   * ISO-8601. The optimistic-concurrency token — pass it back as
   * {@linkcode WorkflowWriteOptions.ifUnmodifiedSince} to make the next save
   * conditional.
   */
  updatedAt: string;
}

/** What both `workflows.create` and `workflows.update` return. */
export interface WorkflowSaveResult {
  /** The saved workflow's id and display name. */
  workflow: { id: string; name: string };
  /**
   * `true` when this save also (re)applied a schedule from the definition's
   * `trigger.cron`. A workflow that already had one is not re-scheduled, so
   * `false` does not mean "not scheduled" — it means "not scheduled by THIS
   * call".
   */
  scheduled: boolean;
  /** The new concurrency token, so a caller can chain saves without a re-`get`. */
  updatedAt: string;
}

/** Per-call options for `workflows.create` and `workflows.update`. */
export interface WorkflowWriteOptions {
  /** Project id to scope this write to; overrides the client's default. */
  project?: string;
  /**
   * The exact `updatedAt` this client last saw. When given, the server refuses
   * the write with `409 workflow_stale` if the stored row has moved on since —
   * recoverable by re-reading and re-saving. Omitted, the save is
   * last-write-wins.
   */
  ifUnmodifiedSince?: string | null;
}

/**
 * The `workflows` namespace on a `W6WClient`.
 *
 * @example
 * ```ts
 * const active = (await client.workflows.list()).filter((w) => w.status === "active");
 *
 * const run = await client.workflows.run(active[0].id, { wait: true });
 * if (run.status === "failed") console.error(run.error); // data, not an exception
 *
 * // The definition lifecycle: create, read-modify-write, then retire.
 * const { workflow } = await client.workflows.create({
 *   manifestVersion: "2",
 *   name: "Nightly sync",
 *   steps: [],
 * });
 * const current = await client.workflows.get(workflow.id);
 * await client.workflows.update(
 *   workflow.id,
 *   { ...current.workflow, name: "Nightly sync (EU)" },
 *   { ifUnmodifiedSince: current.updatedAt },
 * );
 * await client.workflows.archive(workflow.id);
 * await client.workflows.delete(workflow.id);
 * ```
 */
export class WorkflowsApi {
  readonly #host: WorkflowsHost;

  /**
   * @param host - The client this namespace issues requests through.
   */
  constructor(host: WorkflowsHost) {
    this.#host = host;
  }

  /**
   * List the caller's workflow definitions.
   *
   * The project this call is scoped to is the per-call argument first, then the
   * client's default, then nothing at all — an absent value means "no
   * `?project=`", which is how the caller asks for every project the credential
   * can see.
   *
   * @param options - Optional per-call project scope.
   * @returns The workflows, unwrapped from the `workflows` envelope.
   * @throws {ApiError} On any non-2xx.
   */
  async list(options?: WorkflowListOptions): Promise<WorkflowSummary[]> {
    const res = await this.#host.request<unknown>({
      method: "GET",
      path: "/workflows",
      query: { project: options?.project ?? this.#host.config.project ?? undefined },
    });
    return unwrap<WorkflowSummary[]>(res, "workflows");
  }

  /**
   * Start a run of one workflow, optionally waiting for it to finish.
   *
   * Returns on **both** success statuses this route uses:
   *
   * | Call | HTTP | Body | `terminal` |
   * |---|---|---|---|
   * | no `wait` | `202` | `{runId, status:"queued"}` | `false` |
   * | `wait: true`, finished in time | `200` | `{runId, status, output, error, steps}` | `true` |
   * | `wait: true`, timed out | `202` | `{runId, status}` | `false` |
   *
   * **A run that failed is the second row, not an error**: `200` with
   * `status: "failed"` and the failure in `error`. This method returns it. It
   * raises only when the *request* failed — `404 unknown_workflow`, a rejected
   * token, a transport failure.
   *
   * @param id - The `wf_…` id, or the Workflow's `key`. Percent-encoded into the path.
   * @param options - `wait`, plus the `variables`, `trigger` and `input` that go in the body.
   * @returns The run handle, its status, and the result when the run has one.
   * @throws {ApiError} `404 unknown_workflow` when there is no such workflow.
   * @throws {ApiError} `bad_response` when a success body is not a run object.
   */
  async run(id: string, options?: WorkflowRunOptions): Promise<WorkflowRunResult> {
    const res = await this.#host.request<unknown>({
      method: "POST",
      path: path`/workflows/${id}/run`,
      // `?wait=true` or no `wait` at all — never `?wait=false`, which the server
      // reads as "no wait" anyway and which would misrepresent the request in a
      // log or a proxy.
      query: { wait: options?.wait ? true : undefined },
      // Always a body, even when empty: the route parses one when the text is
      // non-empty and defaults to `{}` otherwise, so `{}` and no body are the
      // same request — and sending the object keeps the three optional fields at
      // one place instead of behind a conditional.
      body: { variables: options?.variables, trigger: options?.trigger, input: options?.input },
    });

    const body = res.body;
    // The `runId` and `status` checks are the guard, not decoration. An
    // object-only check let `{}`, `[]`, `[{…}]` and `{"ok":true}` through and
    // returned a `WorkflowRunResult` whose `runId: string` and `status:
    // RunStatus` were **`undefined` at runtime** (measured) — a lie the compiler
    // cannot catch, which becomes a `TypeError` somewhere in the caller minutes
    // later. That is the failure this package's own `unwrap` exists to prevent.
    //
    // Requiring the two fields also subsumes the array case (`[].runId` is
    // `undefined`), and makes this guard exactly as strict as its sibling in
    // `src/run.ts`, which requires a string `kind`: two operations in one
    // package must not disagree about what a malformed success body is. It
    // keeps the lanes in step too — python's idiomatic `isinstance(body, dict)`
    // rejects `[]` where `typeof [] === "object"` accepts it.
    if (
      typeof body !== "object" || body === null ||
      typeof (body as { runId?: unknown }).runId !== "string" ||
      typeof (body as { status?: unknown }).status !== "string"
    ) {
      throw new ApiError(
        res.status,
        "bad_response",
        `Server returned a ${res.status} whose body is not a run object.`,
        body,
      );
    }
    const run = body as Partial<RunResult>;
    const status = run.status as RunStatus;
    return {
      // Spread first so any field a newer server adds survives; the normalised
      // ones below then take their pinned shape.
      ...run,
      runId: run.runId as string,
      status,
      // A `202` carries no `steps`. Normalised to `{}` rather than left absent,
      // so a caller iterating a run's steps never has to branch on which status
      // carried it — the same reason an empty list is `[]` and not `null`.
      steps: run.steps ?? {},
      terminal: isTerminalRunStatus(status),
      httpStatus: res.status,
    };
  }

  /**
   * Fetch one workflow's stored definition.
   *
   * `workflow` is the definition the server has, overlaid with the
   * authoritative `status` and `tags` columns — so a freshly created workflow
   * that carries neither inline still reports its real lifecycle state.
   *
   * **`updatedAt` is a TOP-LEVEL SIBLING of `workflow`, never a field inside
   * it**, and that placement is load-bearing rather than incidental: the
   * definition is the portable document (it can be exported, re-imported, or
   * committed to a repo) and a server timestamp must not enter it. It is also
   * the optimistic-concurrency token — hand it straight back to
   * {@linkcode update} as `ifUnmodifiedSince` and a save that would clobber
   * someone else's is refused instead.
   *
   * @param id - The `wf_…` id, percent-encoded into the path.
   * @returns The definition, its source ref, and the concurrency token.
   * @throws {ApiError} `404 unknown_workflow` when there is no such id.
   */
  async get(id: string): Promise<WorkflowDetail> {
    const res = await this.#host.request<WorkflowDetail>({
      method: "GET",
      path: path`/workflows/${id}`,
    });
    // No envelope key to peel — this route's body IS the payload, all three
    // fields of it. `unwrap` would be wrong here, not merely unnecessary:
    // there is no key it could name.
    return res.body;
  }

  /**
   * Create a workflow.
   *
   * **The id is minted client-side when the definition does not carry one.**
   * The server requires an `id` in the body and never generates one
   * (`admin/workflows.ts`'s `validateDefinition`), so a `create` that simply
   * forwarded the caller's object would answer `400 invalid_workflow` for the
   * most natural call there is — `create({name, steps})`. A caller that wants
   * to choose its own id still can: an `id` already present is forwarded
   * untouched, which is what makes this method usable for a seeded or
   * imported definition.
   *
   * `create` and {@linkcode update} reach the SAME upsert route, and the
   * server does not distinguish them — the distinction is in what each one
   * does to the body, and it is a real one: `create` mints an id, `update`
   * pins the one you addressed. Posting a definition whose id already exists
   * therefore OVERWRITES it; this method does not pre-check, because a
   * check-then-write is two round trips that still race.
   *
   * @param definition - The whole workflow definition, forwarded verbatim apart from a minted `id`.
   * @param options - `project` scopes the write to one project.
   * @returns The new workflow's id and name, whether a schedule was applied, and the first `updatedAt`.
   * @throws {ApiError} `400 invalid_workflow` — missing `name`/`steps`, or a wrong `manifestVersion`.
   * @throws {ApiError} `400 unknown_project` — `project` names a project this account does not own.
   * @throws {ApiError} `409 workflow_conflict` — another `(tenant, subject)` already owns that id.
   */
  async create(
    definition: WorkflowDefinition,
    options?: WorkflowWriteOptions,
  ): Promise<WorkflowSaveResult> {
    const body = typeof definition.id === "string" && definition.id.length > 0
      ? definition
      : { ...definition, id: mintId("wf") };
    return await this.#save(body, options);
  }

  /**
   * Overwrite a workflow's stored definition.
   *
   * **This is a full replacement, not a patch.** The server has one write
   * route for workflows and it stores what it is given, so a field left out of
   * `definition` is a field removed from the workflow — the same semantics as
   * the studio's own save. Read with {@linkcode get}, change what you mean to
   * change, and send the whole thing back.
   *
   * `id` is taken from the FIRST ARGUMENT and pinned into the body, overriding
   * any `id` the definition carries. The alternative — trusting the body —
   * makes `update("wf_a", defOfB)` silently write to B while reading as a
   * write to A.
   *
   * Pass `options.ifUnmodifiedSince` (the `updatedAt` from {@linkcode get} or
   * from a previous save) to make the write conditional. Without it the save
   * is last-write-wins.
   *
   * @param id - The `wf_…` id to write to.
   * @param definition - The whole replacement definition.
   * @param options - `project` scopes the write; `ifUnmodifiedSince` is the concurrency precondition.
   * @returns The workflow's id and name, whether a schedule was (re)applied, and the new `updatedAt`.
   * @throws {ApiError} `400 invalid_workflow` / `400 invalid_precondition`.
   * @throws {ApiError} `409 workflow_conflict` — another `(tenant, subject)` owns this id. NOT recoverable by reloading.
   * @throws {ApiError} `409 workflow_stale` — the precondition did not match the stored `updatedAt`. IS recoverable by reloading and re-saving.
   */
  async update(
    id: string,
    definition: WorkflowDefinition,
    options?: WorkflowWriteOptions,
  ): Promise<WorkflowSaveResult> {
    return await this.#save({ ...definition, id }, options);
  }

  /**
   * Archive a workflow.
   *
   * One-way: there is no unarchive route on this domain. Idempotent —
   * archiving an already-archived workflow re-returns it unchanged rather than
   * erroring.
   *
   * This is a required step, not a convenience: {@linkcode delete} refuses a
   * workflow that is still `draft` or `active`.
   *
   * @param id - The `wf_…` id.
   * @returns The archived definition, with `status` and `tags` merged in as {@linkcode get} returns them.
   * @throws {ApiError} `404 unknown_workflow` when there is no such id.
   */
  async archive(id: string): Promise<WorkflowDefinition> {
    const res = await this.#host.request<unknown>({
      method: "POST",
      path: path`/workflows/${id}/archive`,
    });
    return unwrap<WorkflowDefinition>(res, "workflow");
  }

  /**
   * Delete an archived workflow, and everything that hangs off it.
   *
   * The workflow's runs, schedules and subscriptions cascade-delete server-side
   * — there is nothing for the caller to clean up, and nothing to undo.
   *
   * **Archive first.** Deleting a workflow whose status is not `archived` is
   * `409 workflow_not_archived`, which this method deliberately does NOT catch
   * and retry through {@linkcode archive}: a two-step destructive path that an
   * SDK silently completes for you is how a caller deletes something they only
   * meant to look at.
   *
   * Returns nothing. The server's `{ok: true}` carries no information a caller
   * can use, and `Ok` is not a public type of this package
   * (`docs/implementation.md` §5).
   *
   * @param id - The `wf_…` id.
   * @throws {ApiError} `404 unknown_workflow` when there is no such id.
   * @throws {ApiError} `409 workflow_not_archived` when it exists but has not been archived yet.
   */
  async delete(id: string): Promise<void> {
    await this.#host.request<unknown>({ method: "DELETE", path: path`/workflows/${id}` });
  }

  /**
   * The one POST both {@linkcode create} and {@linkcode update} go through.
   *
   * Private, and shared rather than duplicated, because the precondition
   * header has a rule that is easy to get subtly wrong twice: it is sent only
   * when a value was actually given, NEVER as an empty or `"null"` string. The
   * server parses whatever arrives and answers `400 invalid_precondition` for
   * a value it cannot read, so a stray header turns a fine save into an error
   * that names something the caller never asked for.
   *
   * @param body - The complete definition, id already resolved.
   * @param options - The write options as given by the public method.
   * @returns The server's save result, verbatim.
   */
  async #save(
    body: WorkflowDefinition,
    options?: WorkflowWriteOptions,
  ): Promise<WorkflowSaveResult> {
    const res = await this.#host.request<WorkflowSaveResult>({
      method: "POST",
      path: "/workflows",
      query: { project: options?.project ?? this.#host.config.project ?? undefined },
      body,
      ...(options?.ifUnmodifiedSince
        ? { headers: { [PRECONDITION_HEADER]: options.ifUnmodifiedSince } }
        : {}),
    });
    return res.body;
  }
}
