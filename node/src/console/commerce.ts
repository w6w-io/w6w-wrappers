/**
 * `client.console.commerce.*` — the checked-in plan catalog, and the caller's
 * own resolved subscription.
 *
 * **Studio-internal, not the published partner contract.** This namespace
 * lives under the `console` subpath export (`@w6w/sdk/console`), excluded from
 * `endpoints.json` and from the root barrel (`mod.ts`) — see `docs/console.md`
 * and this task's contract. `@w6w/sdk`'s instance-state mechanism pin still
 * applies here exactly as it does to every other namespace
 * (`docs/implementation.md` §MECHANISM PIN — instance state, never globals):
 * this class holds no state of its own beyond the injected host, so two
 * clients in one process never share a credential.
 *
 * **The public/guarded split is per METHOD, not per file, exactly like
 * `console.auth`.** `plans()` is registered above the auth guard
 * (`packages/server/packages/api/commerce/plans-route.ts`'s own doc comment:
 * "PUBLIC: registered above the auth guard by `commerce/edge.ts`") and reads
 * nothing from the request, so it passes `requireAuth: false` and the
 * transport never even attempts to attach a bearer. `subscription()` derives
 * the account from the JWT (`subscription-route.ts`'s own doc comment:
 * "GUARDED") and uses the default, unconditional `requireAuth`.
 *
 * **Both responses carry an envelope key — unlike `console.dashboard`.** The
 * server answers `c.json({ plans: … })` (`plans-route.ts`) and
 * `c.json({ subscription: { plan, status, canUpgrade } })`
 * (`subscription-route.ts`), so both methods here call this package's
 * `unwrap()` helper rather than returning `res.body` verbatim.
 *
 * @module
 */

import type { HttpResponse, RequestOptions } from "../http.ts";
import { unwrap } from "../types.ts";

/**
 * The slice of `W6WClient` this namespace needs: the transport, and nothing
 * else. Structural rather than a concrete client type, so the namespace stays
 * independently constructible in a test and this module never imports the
 * client back — mirrors `ReliabilityHost` in `./reliability.ts`.
 */
export interface CommerceHost {
  /** Perform one request. */
  request<T>(options: RequestOptions): Promise<HttpResponse<T>>;
}

/** A quota on some countable resource, as `PlanQuotas`' fields each carry one. */
export type Quota =
  | { readonly kind: "unlimited" }
  | { readonly kind: "custom" }
  | { readonly kind: "capped"; readonly included: number }
  | {
    readonly kind: "metered";
    readonly included: number;
    readonly per: number;
    readonly unitAmount: number;
  };

/** The monitor-cadence limit: how often a health check may run. */
export interface MonitorLimit {
  readonly quota: Quota;
  readonly minCadenceMinutes: number | "custom";
}

/** How long check-run bodies and metadata are retained. */
export interface RetentionLimit {
  readonly bodiesDays: number | "custom";
  readonly metadataDays: number | "custom";
}

/** Every countable resource a plan bounds. */
export interface PlanQuotas {
  readonly connections: Quota;
  readonly runs: Quota;
  readonly monitors: MonitorLimit;
  readonly checkRuns: Quota;
  readonly retention: RetentionLimit;
  readonly projects: Quota;
  readonly seats: Quota;
}

/** Whether a plan may self-host, and the annual surcharge if so. */
export interface SelfHostLicence {
  readonly available: boolean;
  readonly annualSurcharge: number | null;
}

/** The feature toggles a plan grants. */
export interface PlanCapabilities {
  readonly catalogImport: boolean;
  readonly privateRegistry: boolean;
  readonly implSwapAndConfig: boolean;
  readonly versionPinsAndBlocks: boolean;
  readonly egressCaptureExport: boolean;
  readonly embeddedWhiteLabel: boolean;
  readonly selfHostLicence: SelfHostLicence;
}

/** A plan's support tier. */
export type SupportLevel = "community" | "email" | "slack-1-business-day" | "sla-named-contact-dpa";

/** Everything a plan bounds or grants: quotas, capabilities, and support level. */
export interface PlanLimits {
  readonly quotas: PlanQuotas;
  readonly capabilities: PlanCapabilities;
  readonly support: SupportLevel;
}

/**
 * The `price` arm of a plan — exactly the eight fields `plans-route.ts`'s
 * `toWirePlan` allowlists. Never `productId`/`base`/`metered`: the rail
 * (Stripe) is an implementation detail and the product id / lookup key are
 * server configuration, not published pricing.
 */
export type PlanPrice =
  | { readonly kind: "none" }
  | { readonly kind: "contact-sales" }
  | {
    readonly kind: "billable";
    readonly unitAmount: number;
    readonly currency: "usd";
    readonly interval: "month";
  };

/** One entry in the checked-in plan catalog, as `GET /commerce/plans` returns it. */
export interface Plan {
  /** `"free" | "team" | "business" | "enterprise"` today, typed `string` on the wire. */
  readonly key: string;
  readonly name: string;
  readonly description: string;
  readonly rank: number;
  readonly retired: boolean;
  readonly features: readonly string[];
  readonly limits: PlanLimits;
  readonly price: PlanPrice;
}

/**
 * The caller's resolved subscription, as `GET /commerce/subscription`
 * returns it. `status` is the SUBSCRIPTION's status, never a vendor/HTTP
 * status; `plan` is a catalog key, not a display name. Named
 * `CommerceSubscription` rather than the bare `Subscription` — that name is
 * already taken by `console/subscriptions.ts` (webhook-trigger
 * subscriptions, an unrelated domain despite the shared word).
 */
export interface CommerceSubscription {
  readonly plan: string;
  readonly status: string;
  readonly canUpgrade: boolean;
}

/**
 * The `console.commerce` namespace on a `W6WClient`.
 *
 * @example
 * ```ts
 * const plans = await client.console.commerce.plans();
 * const { canUpgrade } = await client.console.commerce.subscription();
 * ```
 */
export class CommerceApi {
  readonly #host: CommerceHost;

  /**
   * @param host - The client this namespace issues requests through.
   */
  constructor(host: CommerceHost) {
    this.#host = host;
  }

  /**
   * Fetch the checked-in plan catalog.
   *
   * PUBLIC — sends no bearer, even on a client that already holds one
   * (`requireAuth: false`): the route reads nothing from the request and its
   * output is byte-identical for every caller.
   *
   * @returns The catalog, unwrapped from the `plans` envelope.
   * @throws {ApiError} On any non-2xx.
   */
  async plans(): Promise<Plan[]> {
    const res = await this.#host.request<{ plans: Plan[] }>({
      method: "GET",
      path: "/commerce/plans",
      requireAuth: false,
    });
    return unwrap<Plan[]>(res, "plans");
  }

  /**
   * Fetch the caller's own resolved subscription.
   *
   * AUTHENTICATED — the default `requireAuth` applies: the account is
   * derived server-side from the principal.
   *
   * @returns The subscription, unwrapped from the `subscription` envelope.
   * @throws {ApiError} On any non-2xx, e.g. `409` when the resolved plan key
   *   is not in the catalog or is ambiguous.
   */
  async subscription(): Promise<CommerceSubscription> {
    const res = await this.#host.request<{ subscription: CommerceSubscription }>({
      method: "GET",
      path: "/commerce/subscription",
    });
    return unwrap<CommerceSubscription>(res, "subscription");
  }
}
