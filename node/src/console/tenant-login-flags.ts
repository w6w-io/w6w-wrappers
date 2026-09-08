/**
 * `client.console.tenantLoginFlags.*` — a tenant administrator's own
 * password/OTP sign-in toggles (T2.1.3).
 *
 * **Studio-internal, not the published partner contract.** This namespace
 * lives under the `console` subpath export (`@w6w/sdk/console`), excluded from
 * `endpoints.json` and from the root barrel (`mod.ts`) — see `docs/console.md`.
 * `@w6w/sdk`'s instance-state mechanism pin still applies here exactly as it
 * does to every other namespace (`docs/implementation.md` §MECHANISM PIN —
 * instance state, never globals): this class holds no state of its own beyond
 * the injected host, so two clients in one process never share a credential.
 *
 * **The tenant is never a parameter here** — mirrors `console.tenantOAuthApps`
 * exactly: both routes are scoped by the caller's own credential (the tenant
 * claim on the bearer) plus a server-side `requireTenantAdmin` check
 * (T2.1.1's wire pin), never by an id this client sends.
 *
 * **`put`'s body is built by OMISSION, key by key — absence means "leave
 * whatever is stored alone".** T2.1.1's wire pin states it directly: "absent
 * means preserve, `null` is refused." Unlike
 * `console.tenantOAuthApps.SetTenantOAuthAppInput`, neither field here ever
 * accepts `null` — both are plain optional booleans — so {@linkcode toSetBody}
 * is the simpler of the two omission builders, but the discipline (never
 * `JSON.stringify`'s own `undefined`-dropping behaviour, an explicit
 * allowlist of exactly two keys) is the same one for the same reason: a
 * caller-widened input type must not be able to smuggle a third key onto the
 * wire from here.
 *
 * **The one refusal this domain can produce, `409 no_fallback_login`, is not
 * caught here.** Disabling password with OTP off (or vice versa) would leave
 * the tenant with no way in at all; the server refuses it and this method
 * propagates the `ApiError` unchanged, exactly like every other write in this
 * package — the caller (`packages/studio/src/pages/TenantSettingsPage.tsx`)
 * is what turns the code into a sentence.
 *
 * @module
 */

import { type HttpResponse, type RequestOptions } from "../http.ts";

/**
 * The slice of `W6WClient` this namespace needs: the transport, and nothing
 * else. Structural rather than a concrete client type, so the namespace stays
 * independently constructible in a test and this module never imports the
 * client back — mirrors `TenantOAuthAppsHost` in `./tenant-oauth-apps.ts`.
 */
export interface TenantLoginFlagsHost {
  /** Perform one request. */
  request<T>(options: RequestOptions): Promise<HttpResponse<T>>;
}

/** The tenant's current sign-in configuration — `GET`/`PUT /tenant/login-flags` (T2.1.1's wire pin). */
export interface TenantLoginFlags {
  /** Whether email one-time-code sign-in is turned on for this tenant. */
  otpEnabled: boolean;
  /** Whether password sign-in is turned OFF for this tenant. */
  passwordDisabled: boolean;
}

/**
 * The body `put` sends — built by OMISSION, key by key. Both fields are
 * optional; an omitted field is left untouched server-side. See this
 * module's header for why neither ever carries `null` (unlike
 * `console.tenantOAuthApps.SetTenantOAuthAppInput`).
 */
export interface SetTenantLoginFlagsInput {
  otpEnabled?: boolean;
  passwordDisabled?: boolean;
}

/**
 * Serialise {@linkcode SetTenantLoginFlagsInput} for the wire: **only the
 * keys actually present.** Written as explicit `!== undefined` tests rather
 * than a spread, mirroring `./tenant-oauth-apps.ts`'s `toSetBody` — it keeps
 * `undefined` off the wire without relying on `JSON.stringify` to drop it,
 * and it is an allowlist: a caller that widens the input type cannot get a
 * third key onto the wire from here.
 *
 * @param input - The caller's partial update.
 * @returns A body carrying exactly the keys `input` set.
 */
function toSetBody(input: SetTenantLoginFlagsInput): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (input.otpEnabled !== undefined) body.otpEnabled = input.otpEnabled;
  if (input.passwordDisabled !== undefined) body.passwordDisabled = input.passwordDisabled;
  return body;
}

/**
 * The `console.tenantLoginFlags` namespace on a `W6WClient` — the caller's
 * own tenant, never a tenant of its choosing.
 *
 * @example
 * ```ts
 * const flags = await client.console.tenantLoginFlags.get();
 * await client.console.tenantLoginFlags.put({ otpEnabled: true });
 * ```
 */
export class TenantLoginFlagsApi {
  readonly #host: TenantLoginFlagsHost;

  /**
   * @param host - The client this namespace issues requests through.
   */
  constructor(host: TenantLoginFlagsHost) {
    this.#host = host;
  }

  /**
   * The caller's tenant's current sign-in flags.
   *
   * AUTHENTICATED, `requireTenantAdmin` — the default `requireAuth` applies.
   *
   * @returns `{ otpEnabled, passwordDisabled }`.
   * @throws {ApiError} `403` when the caller does not administer its tenant.
   */
  async get(): Promise<TenantLoginFlags> {
    const res = await this.#host.request<{ flags: TenantLoginFlags }>({
      method: "GET",
      path: "/tenant/login-flags",
    });
    return res.body.flags;
  }

  /**
   * Update the caller's tenant's sign-in flags, sending **only the fields
   * `input` sets**.
   *
   * AUTHENTICATED, `requireTenantAdmin` — the default `requireAuth` applies.
   *
   * @param input - The flags to set; an omitted field is left untouched server-side.
   * @returns The stored flags after the update.
   * @throws {ApiError} `403` when the caller does not administer its tenant;
   *   `400 invalid_body` for a non-boolean present value; `409
   *   no_fallback_login` when the change would leave the tenant with no way
   *   in — NOT caught here, propagated unchanged (see this module's header).
   */
  async put(input: SetTenantLoginFlagsInput): Promise<TenantLoginFlags> {
    const res = await this.#host.request<{ flags: TenantLoginFlags }>({
      method: "PUT",
      path: "/tenant/login-flags",
      body: toSetBody(input),
    });
    return res.body.flags;
  }
}
