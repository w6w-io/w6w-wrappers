/**
 * `client.run({urn, action, payload})` — run anything a URN addresses.
 *
 * One POST, one kind-tagged body, no envelope key. The URN resolves over the
 * four runnable arms — `conn_…`, `wf_…`, `fn_…`, `ep_…` (D16) — and the answer
 * says which one it hit:
 *
 * | `kind` | Field | HTTP |
 * |---|---|---|
 * | `"action"` | `value` | `200` |
 * | `"function"` | `output` | `200` |
 * | `"workflow"` | `runId` + `status` | `202` |
 *
 * `value` and `output` are **deliberately different names** and are never
 * normalised into one field: the discrimination is the whole point of the
 * operation (D3). `202` on the workflow arm is **success** — the run is queued
 * and `runId` is how the caller follows it.
 *
 * ── The unknown fourth kind ──
 * A `kind` this release has never heard of is **returned verbatim**, never
 * raised (`docs/implementation.md` §5). `run` dispatches on whatever a URN
 * resolves to, and the server can grow a new kind before the wrappers do — a
 * purely additive change. Raising would turn that into a hard breakage for every
 * installed client on the one operation whose entire job is dispatch, and would
 * leave the caller with an exception instead of a payload this module had
 * already parsed and held. Callers discriminate with `isActionRun`,
 * `isFunctionRun` and `isWorkflowRun` (`src/types.ts`), which narrow properly —
 * a bare `env.kind === "action"` check does not, because the union is open.
 *
 * `POST /api/run` (verified live 2026-07-28): the URN resolver dispatches to
 * the same runner each dedicated route already uses — no new execution path.
 *
 * ── Why this is not folded into `workflows.run` ──
 * D4: `?wait=`, `variables` and `trigger` have no slot in the three-field
 * `{urn, action, payload}` shape, and a workflow has no `action`. The two
 * operations ship side by side — this one dispatches, `workflows.run` is the
 * typed path.
 *
 * Like `me`, this is a function over a narrow host interface rather than a
 * namespace class, because `endpoints.json` names the symbol `client.run(input)`
 * — a method on the client itself, not a `client.run.run()`.
 *
 * @module
 */

import { ApiError } from "./errors.ts";
import type { HttpResponse, RequestOptions } from "./http.ts";
import type { RunEnvelope } from "./types.ts";

/**
 * The slice of `W6wClient` this operation needs: the transport, and nothing
 * else. Structural rather than a concrete client type, so it stays
 * independently callable in a test and this module never imports the client
 * back.
 */
export interface RunHost {
  /** Perform one request. */
  request<T>(options: RequestOptions): Promise<HttpResponse<T>>;
}

/**
 * The body of `client.run()`.
 *
 * All three fields travel in the **request body**, so none of them is
 * percent-encoded: `/run` is a fixed path with no interpolation, and a URN in
 * JSON needs no escaping. (The `path` tag is for path segments — `workflows.run`
 * uses it for its `wf_…` id.)
 */
export interface RunInput {
  /** What to run: `conn_…`, `wf_…`, `fn_…` or `ep_…`. */
  urn: string;
  /**
   * Which action to invoke. Optional, because a workflow, function or endpoint
   * URN has no action; required in practice for a `conn_…` URN, and the server
   * is what says so — this client does not second-guess the URN's arm.
   */
  action?: string;
  /** Input to the run. Defaults to `{}`. Opaque pass-through. */
  payload?: Record<string, unknown>;
}

/**
 * Run whatever a URN addresses.
 *
 * @param host - The client this operation issues its request through.
 * @param input - The URN, the optional action, and the payload.
 * @returns The kind-tagged envelope, with `kind` and the arm's field verbatim.
 * @throws {ApiError} On any non-2xx — `404` for an unresolvable URN, `424` when
 * the app or its upstream vendor failed during execute (a 4xx on purpose, so
 * Cloudflare cannot swallow the message; never normalised into a transport
 * error).
 * @throws {ApiError} `bad_response` when a success body carries no `kind` at all
 * — that is a malformed dispatch response, not a new arm, and it is the one
 * shape a caller cannot do anything with.
 */
export async function runUrn(host: RunHost, input: RunInput): Promise<RunEnvelope> {
  const res = await host.request<unknown>({
    method: "POST",
    path: "/run",
    body: {
      urn: input.urn,
      action: input.action,
      // Defaulted rather than omitted: the server's parameter schemas are
      // written against an object, and `{}` says "no input" where an absent key
      // says "I forgot".
      payload: input.payload ?? {},
    },
  });

  const body = res.body;
  if (
    typeof body !== "object" || body === null ||
    typeof (body as { kind?: unknown }).kind !== "string"
  ) {
    throw new ApiError(
      res.status,
      "bad_response",
      `Server returned a ${res.status} with no "kind" in the response body.`,
      body,
    );
  }
  // Returned as it arrived — no rebuild, no field renaming, no per-arm
  // destructure. An unknown `kind` therefore reaches the caller with every
  // sibling field intact.
  return body as RunEnvelope;
}
