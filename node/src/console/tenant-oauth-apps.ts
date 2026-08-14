/**
 * `client.console.tenantOAuthApps.*` — a tenant administrator's own OAuth
 * client overrides (list, upsert, remove) for the apps their tenant connects
 * to.
 *
 * **Studio-internal, not the published partner contract.** This namespace
 * lives under the `console` subpath export (`@w6w/sdk/console`), excluded from
 * `endpoints.json` and from the root barrel (`mod.ts`) — see `docs/console.md`.
 * `@w6w/sdk`'s instance-state mechanism pin still applies here exactly as it
 * does to every other namespace (`docs/implementation.md` §MECHANISM PIN —
 * instance state, never globals): this class holds no state of its own beyond
 * the injected host, so two clients in one process never share a credential.
 *
 * **The tenant is never a parameter here.** These three routes are scoped by
 * the caller's own credential (the tenant claim on the bearer) plus a
 * server-side tenant-admin check — unlike the operator family
 * (`GET/PUT/DELETE /tenants/:id/oauth-app…`, `api/admin/tenants.ts:307-309`),
 * which takes the tenant in the path and requires an operator. A `tenant`
 * argument on any method below would be a tenant-selection affordance the
 * server does not offer, so there is none.
 *
 * **Nothing here can read a client secret back.** {@linkcode
 * TenantOAuthAppSummary} carries `hasClientSecret: boolean` and no secret
 * field, mirroring the server's own summary projection
 * (`packages/server/packages/db/repos/tenant_oauth_app.ts:26-37`, whose
 * decrypting sibling `TenantOAuthApp` is entitled to exactly one caller in the
 * BLL). That makes "no method on this namespace can ever resolve a stored
 * secret" a compile-time fact rather than a runtime convention.
 *
 * **Response shapes are flat, no envelope key to peel with `unwrap()`** —
 * mirroring `console/auth.ts:29-32` for this whole family. `list` returns the
 * whole body deliberately, because `callbackUrl` rides beside `configs` and an
 * `unwrap(res, "configs")` would silently drop it; `put` reaches one level in
 * for `body.config`, which is the shape the server answers with (W4).
 *
 * **Wire shapes are planner pins, not reverse-engineered from a merged route.**
 * `plan-B.md` § WIRE PINS W3–W5 fix `GET /tenant/oauth-apps`,
 * `PUT /tenant/oauth-app/:app/:authKey` and
 * `DELETE /tenant/oauth-app/:app/:authKey`; the tenant-scoped handlers are
 * added by a sibling node on the server, against the same pins. The domain
 * rules those handlers enforce already exist and are readable today in
 * `packages/server/packages/bll/tenant-oauth-app.ts` — in particular
 * `effectiveRow` (`:281-296`), which is what makes {@linkcode
 * SetTenantOAuthAppInput}'s omission rule load-bearing rather than cosmetic.
 * See {@linkcode SetTenantOAuthAppInput}.
 *
 * @module
 */

import { type HttpResponse, path, type RequestOptions } from "../http.ts";

/**
 * The slice of `W6WClient` this namespace needs: the transport, and nothing
 * else. Structural rather than a concrete client type, so the namespace stays
 * independently constructible in a test and this module never imports the
 * client back — mirrors `AuthHost` in `./auth.ts`.
 */
export interface TenantOAuthAppsHost {
  /** Perform one request. */
  request<T>(options: RequestOptions): Promise<HttpResponse<T>>;
}

/**
 * One tenant OAuth client override, as the tenant-scoped routes project it
 * (W3/W4). A summary only: it names whether a secret is stored, never the
 * secret — the server's own summary row has no `clientSecret` column on it
 * either (`db/repos/tenant_oauth_app.ts:26-37`).
 */
export interface TenantOAuthAppSummary {
  /** The app this override applies to. */
  appId: string;
  /** The app manifest's `oauth2` auth method key. */
  authKey: string;
  /** The tenant's OAuth client id, or `null` when never set / cleared. */
  clientId: string | null;
  /**
   * The redirect URI registered with the provider, as stored **server-side**.
   * Read-only here: it is derived by the server, never sent by this client —
   * {@linkcode SetTenantOAuthAppInput} carries no `redirectUri` key.
   */
  redirectUri: string | null;
  /** Provider-specific extras (scopes, audience, …). `{}` when none. */
  extra: Record<string, unknown>;
  /** Whether a client secret is stored. **Never the secret itself.** */
  hasClientSecret: boolean;
  /** Whether the override is switched off (the host's own client is used instead). */
  disabled: boolean;
}

/** `GET /tenant/oauth-apps` → 200 (W3). */
export interface TenantOAuthAppsResponse {
  /** Every override this tenant has, in the server's order. */
  configs: TenantOAuthAppSummary[];
  /** This host's OAuth callback, derived SERVER-SIDE. Display it; never assemble it. */
  callbackUrl: string;
}

/**
 * The body `put` sends (W4) — **built by OMISSION, key by key.**
 *
 * Every field is optional and every one of them means "set this field to this
 * value", including `null`, which means "clear it". Absence means "leave
 * whatever is stored alone": the server merges the request over the stored row
 * (`bll/tenant-oauth-app.ts:281-296`'s `effectiveRow`, which tests each field
 * with `!== undefined`), so a key that is not sent is a key that is not
 * touched.
 *
 * **Sending a key you did not mean to set is destructive, and one of them is
 * destructive SILENTLY.** `hasClientSecret` is computed as
 * `input.clientSecret !== null` (`:291-293`), so an empty-string
 * `clientSecret: ""` satisfies the enabled-override invariant at `:332` and the
 * stored ciphertext is overwritten with an empty secret — no error anywhere.
 * The neighbouring fields fail loudly instead (`clientId: ""` at `:324`,
 * `redirectUri` at `:313-322`). That asymmetry is the entire reason this type
 * has no required field and this module builds the body key by key: omit what
 * the user did not touch, never send `""`.
 *
 * **No `redirectUri` and no `force`.** Neither exists on this surface — the
 * callback URL is derived server-side (W3's `callbackUrl`) and the operator's
 * `?force` affordance is not offered to a tenant admin (W4). A field the SDK
 * declares is a field a form will fill, so neither is declared, and
 * {@linkcode toSetBody} additionally refuses to forward either at runtime.
 */
export interface SetTenantOAuthAppInput {
  /** The OAuth client id. `null` clears it. */
  clientId?: string | null;
  /**
   * The OAuth client secret, write-only. `null` clears it. Sending `""` IS
   * carried to the wire and IS destructive (silently overwrites the stored
   * secret) — omit this key instead of sending `""` when not changing it.
   */
  clientSecret?: string | null;
  /** Provider-specific extras. `null` clears them to `{}`. */
  extra?: Record<string, unknown> | null;
  /** Whether to switch the override off. */
  disabled?: boolean;
}

/**
 * Serialise {@linkcode SetTenantOAuthAppInput} for the wire: **only the keys
 * actually present**, with `null` preserved as a real value.
 *
 * Written as four explicit `!== undefined` tests rather than a spread or an
 * `Object.entries` loop, for two reasons. It keeps `undefined` off the wire
 * without relying on `JSON.stringify` dropping it (a serializer that
 * normalised `undefined` to `null` would silently wipe a stored credential —
 * see {@linkcode SetTenantOAuthAppInput}), and it is an allowlist: a caller
 * that widens the input type and passes `redirectUri` or `force` cannot get
 * either onto the wire from here, at runtime as well as at compile time.
 *
 * @param input - The caller's partial update.
 * @returns A body carrying exactly the keys `input` set.
 */
function toSetBody(input: SetTenantOAuthAppInput): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (input.clientId !== undefined) body.clientId = input.clientId;
  if (input.clientSecret !== undefined) body.clientSecret = input.clientSecret;
  if (input.extra !== undefined) body.extra = input.extra;
  if (input.disabled !== undefined) body.disabled = input.disabled;
  return body;
}

/**
 * The `console.tenantOAuthApps` namespace on a `W6WClient` — the caller's own
 * tenant, never a tenant of its choosing.
 *
 * @example
 * ```ts
 * const { configs, callbackUrl } = await client.console.tenantOAuthApps.list();
 * // Register `callbackUrl` with the provider — never assemble it client-side.
 * await client.console.tenantOAuthApps.put("sendgrid", "oauth2", { clientId: "abc" });
 * await client.console.tenantOAuthApps.remove("sendgrid", "oauth2");
 * ```
 */
export class TenantOAuthAppsApi {
  readonly #host: TenantOAuthAppsHost;

  /**
   * @param host - The client this namespace issues requests through.
   */
  constructor(host: TenantOAuthAppsHost) {
    this.#host = host;
  }

  /**
   * List the caller's tenant's OAuth overrides, plus this host's callback URL.
   *
   * Returns the body VERBATIM rather than unwrapping `configs`: `callbackUrl`
   * rides beside it and is the one value a caller cannot compute for itself.
   *
   * @returns Every override for this tenant, and the server-derived callback URL.
   * @throws {ApiError} `403` when the caller does not administer its tenant.
   */
  async list(): Promise<TenantOAuthAppsResponse> {
    const res = await this.#host.request<TenantOAuthAppsResponse>({
      method: "GET",
      path: "/tenant/oauth-apps",
    });
    return res.body;
  }

  /**
   * Create or update one override, sending **only the fields `input` sets**.
   *
   * @param appId - The app id.
   * @param authKey - The app manifest's `oauth2` auth method key.
   * @param input - The fields to set; an omitted field is left untouched server-side.
   * @returns The stored summary (the server answers `201 { config }`). Never carries a secret.
   * @throws {ApiError} `403` when the caller does not administer its tenant;
   * `404 unknown_app` when the app does not exist or does not support a tenant
   * OAuth client; `400 invalid_config`/`invalid_redirect_uri` when the merged
   * row would be an enabled override missing a required field.
   */
  async put(
    appId: string,
    authKey: string,
    input: SetTenantOAuthAppInput,
  ): Promise<TenantOAuthAppSummary> {
    const res = await this.#host.request<{ config: TenantOAuthAppSummary }>({
      method: "PUT",
      path: path`/tenant/oauth-app/${appId}/${authKey}`,
      body: toSetBody(input),
    });
    return res.body.config;
  }

  /**
   * Remove one override; the tenant falls back to the host's own OAuth client.
   *
   * Resolves `void`, discarding the server's uninformative `{ok: true}` —
   * mirroring `projects.delete`/`schedules.delete`, not `apps.delete` (which
   * keeps a genuinely informative count).
   *
   * @param appId - The app id.
   * @param authKey - The app manifest's `oauth2` auth method key.
   * @throws {ApiError} `403` when the caller does not administer its tenant;
   * `404 unknown_tenant_oauth_app` when there is no override to remove.
   */
  async remove(appId: string, authKey: string): Promise<void> {
    await this.#host.request<unknown>({
      method: "DELETE",
      path: path`/tenant/oauth-app/${appId}/${authKey}`,
    });
  }
}
