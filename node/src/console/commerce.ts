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

/** Which cadence a {@link PlanPricePoint} recurs on. */
export type BillingInterval = "month" | "year";

/**
 * One published price point. `unitAmount` is integer cents charged per ONE
 * `interval` — an annual point's amount is what is charged once a year, NOT a
 * monthly equivalent, so `$500/yr` arrives as `50000` beside a monthly `5000`.
 *
 * Both figures are authored server-side and neither is derived from the other.
 * A client may compute a saving percentage from the pair for DISPLAY; nothing
 * should reconstruct a price from one and a rate.
 */
export interface PlanPricePoint {
  readonly unitAmount: number;
  readonly interval: BillingInterval;
}

/**
 * The `price` arm of a plan — exactly what `plans-route.ts`'s `toWirePlan`
 * allowlists. Never `productId`/`lookupKey`/`metered`: the rail (Stripe) is an
 * implementation detail and the product id / lookup key are server
 * configuration, not published pricing.
 *
 * Only the `billable` arm carries price data. `none` (Free) and
 * `contact-sales` (Enterprise) carry no amount, no interval and no currency.
 */
export type PlanPrice =
  | { readonly kind: "none" }
  | { readonly kind: "contact-sales" }
  | {
    readonly kind: "billable";
    readonly currency: "usd";
    readonly monthly: PlanPricePoint;
    /** `null` when the plan is offered monthly only. */
    readonly annual: PlanPricePoint | null;
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

/** Which cadence a checkout is for — mirrors `PlanPrice`'s own `BillingInterval`. */
export type CheckoutInterval = "month" | "year";

/** `client.console.commerce.checkout()`'s input. */
export interface CheckoutInput {
  readonly planKey: string;
  readonly interval: CheckoutInterval;
}

/**
 * `POST /commerce/checkout`'s response — a hosted Stripe payment page URL,
 * and NOTHING else: never a raw Checkout Session id, price id or product id
 * (the server's own D-3 rule — no Stripe id crosses the wire in either
 * direction).
 */
export interface CheckoutResult {
  readonly url: string;
}

/** `client.console.commerce.confirmCheckout()`'s input — the `checkout_session_id` the browser was redirected back with. */
export interface ConfirmCheckoutInput {
  readonly sessionId: string;
}

/**
 * `POST /commerce/contact-sales`'s input. `account` is never sent by the
 * caller — the server stamps it from the bearer's own principal.
 */
export interface ContactSalesInput {
  readonly name: string;
  readonly email: string;
  readonly company?: string;
  readonly message: string;
}

/** `POST /commerce/contact-sales`'s response. */
export interface ContactSalesResult {
  readonly id: string;
}

/** `client.console.commerce.previewSubscriptionChange()` / `.changeSubscription()`'s shared input. */
export interface ChangeSubscriptionInput {
  readonly planKey: string;
  readonly interval: CheckoutInterval;
}

/**
 * `POST /commerce/subscription/preview`'s response — what Stripe would
 * charge (positive) or credit (negative) TODAY for this change, in integer
 * cents. Never a raw Stripe invoice object; never rounded/clamped — a large
 * negative value here is a large credit, expected when moving off a
 * part-used ANNUAL plan (Stripe carries the excess forward to future
 * invoices automatically — see the server's `SubscriptionChangeService`).
 */
export interface SubscriptionChangePreview {
  readonly amountDueCents: number;
  readonly currency: string;
}

/**
 * `POST /commerce/subscription/change`'s response. `subscription` here is
 * NARROWER than {@link CommerceSubscription} — no `canUpgrade` — the server
 * has no reason to recompute it against the wire's own move; re-fetch
 * `subscription()` if the caller needs it refreshed.
 */
export interface SubscriptionChangeResult {
  readonly subscription: { readonly plan: string; readonly status: string };
  readonly charge: SubscriptionChangePreview;
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

  /**
   * Open a live Stripe Checkout Session for a billable plan/interval.
   * AUTHENTICATED — the account is resolved server-side from the bearer.
   *
   * @returns The hosted payment page URL. Redirect the browser to it
   *   (`window.location.href = url`); do not fetch it.
   * @throws {ApiError} `409 plan_not_billable` for a `contact-sales`/`none`
   *   plan or an interval the plan doesn't offer; `409 price_not_synced` if
   *   the catalog says billable but Stripe has no matching active price yet.
   */
  async checkout(input: CheckoutInput): Promise<CheckoutResult> {
    const res = await this.#host.request<{ checkout: CheckoutResult }>({
      method: "POST",
      path: "/commerce/checkout",
      body: input,
    });
    return unwrap<CheckoutResult>(res, "checkout");
  }

  /**
   * Confirm a Checkout Session on return from Stripe (the
   * `checkout_session_id` query param `checkout()`'s success URL carries
   * back). Verified against Stripe itself, never trusted from the URL alone
   * — see the server's `CheckoutService` for what this deliberately does not
   * cover (no webhook yet: a session completed after the tab closed is
   * invisible to it).
   *
   * @returns The confirmed subscription.
   * @throws {ApiError} `404 checkout_session_not_found`; `403
   *   checkout_session_mismatch` if the session belongs to a different
   *   account; `409 checkout_not_paid` if payment hasn't completed yet.
   */
  async confirmCheckout(input: ConfirmCheckoutInput): Promise<CommerceSubscription> {
    const res = await this.#host.request<{ subscription: CommerceSubscription }>({
      method: "POST",
      path: "/commerce/checkout/confirm",
      body: { sessionId: input.sessionId },
    });
    return unwrap<CommerceSubscription>(res, "subscription");
  }

  /**
   * Submit an Enterprise "contact sales" lead. AUTHENTICATED — captured
   * durably server-side regardless of whether outbound mail is configured
   * (see the server's `ContactSalesService`).
   */
  async contactSales(input: ContactSalesInput): Promise<ContactSalesResult> {
    const res = await this.#host.request<{ lead: ContactSalesResult }>({
      method: "POST",
      path: "/commerce/contact-sales",
      body: input,
    });
    return unwrap<ContactSalesResult>(res, "lead");
  }

  /**
   * Preview what moving the CALLER'S OWN existing subscription to a
   * different plan/interval would charge or credit TODAY, without applying
   * anything. AUTHENTICATED.
   *
   * @throws {ApiError} `409 no_active_subscription` if the account has no
   *   active Stripe subscription to change — use {@link checkout} instead.
   */
  async previewSubscriptionChange(
    input: ChangeSubscriptionInput,
  ): Promise<SubscriptionChangePreview> {
    const res = await this.#host.request<{ preview: SubscriptionChangePreview }>({
      method: "POST",
      path: "/commerce/subscription/preview",
      body: input,
    });
    return unwrap<SubscriptionChangePreview>(res, "preview");
  }

  /**
   * Apply the change {@link previewSubscriptionChange} previewed — moves the
   * caller's existing Stripe subscription to the new plan/interval with
   * proration, and charges/credits the net difference immediately.
   * AUTHENTICATED.
   *
   * @throws {ApiError} `409 no_active_subscription` if the account has no
   *   active Stripe subscription to change — use {@link checkout} instead.
   */
  async changeSubscription(input: ChangeSubscriptionInput): Promise<SubscriptionChangeResult> {
    const res = await this.#host.request<SubscriptionChangeResult>({
      method: "POST",
      path: "/commerce/subscription/change",
      body: input,
    });
    return res.body;
  }
}
