/**
 * `client.console.subscriptions.*` — (trigger → workflow) bindings, relocated
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
 * Seven methods, relocated from `packages/studio/src/api/client.ts:253-286`'s
 * single `// Subscriptions` comment block — field-for-field, not redesigned:
 * `listSubscriptions` → `list`, `listSubscriptionsForWorkflow` →
 * `listForWorkflow`, `getSubscription` → `get`, `createSubscription` →
 * `create`, `deleteSubscription` → `delete`, `listSubscriptionEvents` →
 * `listEvents`, `requeueTriggerEvent` → `requeueEvent`.
 *
 * **Four of these seven have zero callers anywhere in studio or `@w6w/ui`**
 * (`listForWorkflow`, `get`, `listEvents`, `requeueEvent`) — HITL-4's pinned
 * default, re-confirmed this pass. They are still built to full type
 * fidelity (real implementation, JSDoc, `@throws`) for SDK/wrapper coverage;
 * only the test bar for them is deliberately lighter, mirroring
 * `console.apps`'s/`console.functions`' identical treatment of their own
 * zero-caller methods.
 *
 * **`webhookUrl` is a real server-side field this module deliberately does
 * NOT model.** For a subscription whose `appId === "@w6w/webhook"`, the
 * server enriches the response with a `webhookUrl` field computed from a
 * config value genuinely distinct from studio's own `apiBaseUrl()`
 * (`internal-triggers.ts:123-127`, `config.ts:27,259`). Studio's current
 * `Subscription` type never modeled this and no in-boundary code reads it
 * (`SubscriptionsPage.tsx` computes its own webhook URL client-side
 * independently) — this is a deliberate, verified omission, not an
 * oversight: whatever extra field the server sends is silently ignored,
 * exactly as today.
 *
 * Subscriptions are account-level, never scoped by `project` — so
 * `SubscriptionsHost` needs only the transport, mirroring `VarsHost`/
 * `ProjectsHost`, not `DocumentsHost`.
 *
 * @module
 */

import { type HttpResponse, path, type RequestOptions } from "../http.ts";
import { unwrap } from "../types.ts";

/**
 * The slice of `W6wClient` this namespace needs: the transport, and nothing
 * else. Structural rather than a concrete client type, so the namespace stays
 * independently constructible in a test and this module never imports the
 * client back — mirrors `VarsHost` in `../vars.ts`.
 */
export interface SubscriptionsHost {
  /** Perform one request. */
  request<T>(options: RequestOptions): Promise<HttpResponse<T>>;
}

/**
 * A (trigger → workflow) binding. Field-for-field per
 * `packages/studio/src/api/types.ts:72-83` — this module does not redesign
 * the shape, only gives it a second home. Deliberately does NOT carry
 * `webhookUrl` — see this module's header.
 */
export interface Subscription {
  id: string;
  appId: string;
  triggerKey: string;
  connectionId: string | null;
  workflowId: string;
  params: Record<string, unknown>;
  state: Record<string, unknown>;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * The body of `create`, forwarded verbatim as the whole POST body.
 * Field-for-field per `packages/studio/src/api/client.ts:267-271`.
 */
export interface SubscriptionCreateInput {
  workflowId: string;
  connectionId?: string | null;
  params?: Record<string, unknown>;
}

/** The lifecycle a delivered trigger event can be in. */
export type TriggerEventStatus = "received" | "dispatching" | "dispatched" | "failed";

/**
 * Metadata-only view of a delivered trigger event. Field-for-field per
 * `packages/studio/src/api/types.ts:85-96`.
 */
export interface TriggerEventSummary {
  id: string;
  subscriptionId: string;
  status: TriggerEventStatus;
  attempts: number;
  receivedAt: string;
  dispatchedAt: string | null;
  runId: string | null;
}

/**
 * The `console.subscriptions` namespace on a `W6wClient`.
 *
 * @example
 * ```ts
 * const subs = await client.console.subscriptions.list();
 * const sub = await client.console.subscriptions.create("app_x", "new-message", {
 *   workflowId: "wf_1",
 * });
 * await client.console.subscriptions.delete(sub.id);
 * ```
 */
export class SubscriptionsApi {
  readonly #host: SubscriptionsHost;

  /**
   * @param host - The client this namespace issues requests through.
   */
  constructor(host: SubscriptionsHost) {
    this.#host = host;
  }

  /**
   * List every subscription the caller can see.
   *
   * @returns The subscriptions, unwrapped from the `subscriptions` envelope.
   * @throws {ApiError} On any non-2xx.
   */
  async list(): Promise<Subscription[]> {
    const res = await this.#host.request<unknown>({
      method: "GET",
      path: "/subscriptions",
    });
    return unwrap<Subscription[]>(res, "subscriptions");
  }

  /**
   * List the subscriptions bound to one workflow.
   *
   * **Dead code (HITL-4)** — zero call sites anywhere in studio or
   * `@w6w/ui`. Built for SDK completeness only; see this module's header.
   *
   * @param workflowId - The `wf_…` id.
   * @returns The subscriptions, unwrapped from the `subscriptions` envelope.
   * @throws {ApiError} On any non-2xx.
   */
  async listForWorkflow(workflowId: string): Promise<Subscription[]> {
    const res = await this.#host.request<unknown>({
      method: "GET",
      path: path`/workflows/${workflowId}/subscriptions`,
    });
    return unwrap<Subscription[]>(res, "subscriptions");
  }

  /**
   * Fetch one subscription.
   *
   * **Dead code (HITL-4)** — zero call sites anywhere in studio or
   * `@w6w/ui`. Built for SDK completeness only; see this module's header.
   * Unlike `console.schedules.get`, this method throws `ApiError` on a 404
   * rather than resolving `null` — there is no precedent on this domain to
   * preserve, and this package's default `get` behavior is to throw.
   *
   * @param id - The `sub_…` id.
   * @returns The subscription, unwrapped from the `subscription` envelope.
   * @throws {ApiError} `404 unknown_subscription` when there is no such id.
   */
  async get(id: string): Promise<Subscription> {
    const res = await this.#host.request<unknown>({
      method: "GET",
      path: path`/subscriptions/${id}`,
    });
    return unwrap<Subscription>(res, "subscription");
  }

  /**
   * Bind a trigger to a workflow.
   *
   * @param appId - The app declaring the trigger.
   * @param triggerKey - The trigger's key, as declared by the app's manifest.
   * @param input - The subscription to create; forwarded verbatim as the whole body.
   * @returns The created subscription, unwrapped from the `subscription` envelope (the server answers `201`).
   * @throws {ApiError} `404 unknown_trigger`/`unknown_workflow` on a bad app/trigger/workflow id.
   */
  async create(
    appId: string,
    triggerKey: string,
    input: SubscriptionCreateInput,
  ): Promise<Subscription> {
    const res = await this.#host.request<unknown>({
      method: "POST",
      path: path`/apps/${appId}/triggers/${triggerKey}/subscriptions`,
      body: input,
    });
    return unwrap<Subscription>(res, "subscription");
  }

  /**
   * Remove a subscription.
   *
   * Returns nothing: the server's `{ok: true}` carries no information a
   * caller can use, mirroring `projects.delete`/`schedules.delete`'s
   * established discard-to-void convention (not `apps.delete`'s
   * informative-`{removed: number}` exception).
   *
   * @param id - The `sub_…` id.
   * @throws {ApiError} `404 unknown_subscription` when there is no such id.
   */
  async delete(id: string): Promise<void> {
    await this.#host.request<unknown>({
      method: "DELETE",
      path: path`/subscriptions/${id}`,
    });
  }

  /**
   * List a subscription's delivered trigger events, newest first.
   *
   * **Dead code (HITL-4)** — zero call sites anywhere in studio or
   * `@w6w/ui`. Built for SDK completeness only; see this module's header. No
   * `limit` parameter is exposed — the server applies its own default of 50
   * (`trigger-manager.ts:109`) and no studio caller ever sent one.
   *
   * @param id - The `sub_…` id.
   * @returns The events, unwrapped from the `events` envelope.
   * @throws {ApiError} On any non-2xx.
   */
  async listEvents(id: string): Promise<TriggerEventSummary[]> {
    const res = await this.#host.request<unknown>({
      method: "GET",
      path: path`/subscriptions/${id}/events`,
    });
    return unwrap<TriggerEventSummary[]>(res, "events");
  }

  /**
   * Re-queue a `failed`-status trigger event for another delivery attempt —
   * a dead-letter re-dispatch.
   *
   * **Dead code (HITL-4)** — zero call sites anywhere in studio or
   * `@w6w/ui`. Built for SDK completeness only; see this module's header.
   * Returns nothing: the server's `{ok: true}` carries no information a
   * caller can use, mirroring `projects.delete`/`schedules.delete`'s
   * established discard-to-void convention.
   *
   * @param eventId - The trigger event's id.
   * @throws {ApiError} `404 requeue_failed` when the event doesn't exist or isn't in `failed` status.
   */
  async requeueEvent(eventId: string): Promise<void> {
    await this.#host.request<unknown>({
      method: "POST",
      path: path`/trigger-events/${eventId}/requeue`,
    });
  }
}
