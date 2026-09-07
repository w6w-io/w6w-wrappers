/**
 * `client.console.otp.*` — email one-time-code sign-in, a third standalone
 * login option beside password and passkey (T2.1.3).
 *
 * **Studio-internal, not the published partner contract.** This namespace
 * lives under the `console` subpath export (`@w6w/sdk/console`), excluded from
 * `endpoints.json` and from the root barrel (`mod.ts`) — see `docs/console.md`.
 * `@w6w/sdk`'s instance-state mechanism pin still applies here exactly as it
 * does to every other namespace (`docs/implementation.md` §MECHANISM PIN —
 * instance state, never globals): this class holds no state of its own beyond
 * the injected host, so two clients in one process never share a credential.
 *
 * **All three methods are PUBLIC — the login screen has no token.** Mirrors
 * `console.passkeys`'s login pair exactly: each passes `requireAuth: false`,
 * without which a tokenless client (the normal case at `/login`, before any
 * session exists) would hit `requireToken`'s `ConfigError` before `fetch` is
 * ever called. Wire pins are T2.1.1's contract §Wire pins, above its
 * `requireTenantAdmin`-guarded `/tenant/login-flags` pair (see
 * `./tenant-login-flags.ts`).
 *
 * **`OtpVerifyResponse` is a type ALIAS of `PasskeyAuthenticationVerifyResponse`,
 * not a second declaration of the same four fields.** The server's
 * `POST /auth/otp/verify` answers a byte-identical body to
 * `id/passkey-login.ts`'s own verify route (T2.1.1's wire pin: "byte-shape
 * identical to `id/user-login.ts`'s and `id/passkey-login.ts`'s"), and the
 * passkey names (`PasskeyUser`, `PasskeyAuthenticationVerifyResponse`) are
 * published and cannot be renamed — a third copy of the same shape would be a
 * third thing to drift out of sync with the other two.
 *
 * @module
 */

import { type HttpResponse, type RequestOptions } from "../http.ts";
import { unwrap } from "../types.ts";
import type { PasskeyAuthenticationVerifyResponse } from "./passkeys.ts";

/**
 * The slice of `W6WClient` this namespace needs: the transport, and nothing
 * else. Structural rather than a concrete client type, so the namespace stays
 * independently constructible in a test and this module never imports the
 * client back — mirrors `PasskeysHost` in `./passkeys.ts`.
 */
export interface OtpHost {
  /** Perform one request. */
  request<T>(options: RequestOptions): Promise<HttpResponse<T>>;
}

/**
 * Which sign-in methods this tenant currently offers — `GET
 * /auth/login-providers` (T2.1.1's wire pin). Read by `/login` to decide what
 * to render; see `packages/studio/src/lib/login-providers.ts`'s
 * `providerVisibility`, the one place that decision is made.
 */
export interface LoginProviders {
  password: boolean;
  passkey: boolean;
  otp: boolean;
}

/**
 * The user identity `verifyCode` mints a session for — the SAME shape
 * `PasskeyAuthenticationVerifyResponse` already declares (see this module's
 * header). A type alias, not a reuse of `console.auth`'s `LoginResponse`:
 * that type's `user` does not carry `role`/`tenant`/`emailVerified`.
 */
export type OtpVerifyResponse = PasskeyAuthenticationVerifyResponse;

/**
 * The `console.otp` namespace on a `W6WClient`.
 *
 * @example
 * ```ts
 * const client = new W6WClient({ baseUrl: "https://api.example.com" }); // no token — see below
 * const { providers } = { providers: await client.console.otp.loginProviders() };
 * if (providers.otp) {
 *   await client.console.otp.requestCode({ email: "alice@example.com" });
 *   const { token } = await client.console.otp.verifyCode({
 *     email: "alice@example.com",
 *     code: "123456",
 *   });
 * }
 * ```
 */
export class OtpApi {
  readonly #host: OtpHost;

  /**
   * @param host - The client this namespace issues requests through.
   */
  constructor(host: OtpHost) {
    this.#host = host;
  }

  /**
   * Which sign-in methods this tenant currently offers.
   *
   * PUBLIC — sends no bearer, even on a client that already holds one
   * (`requireAuth: false`). The `/login` screen calls this before any session
   * exists, so a tokenless client must be able to reach it.
   *
   * @returns `{ password, passkey, otp }`, unwrapped from the `providers` envelope.
   */
  async loginProviders(): Promise<LoginProviders> {
    const res = await this.#host.request<unknown>({
      method: "GET",
      path: "/auth/login-providers",
      requireAuth: false,
    });
    return unwrap<LoginProviders>(res, "providers");
  }

  /**
   * Request a one-time sign-in code by email.
   *
   * PUBLIC — sends no bearer (`requireAuth: false`). Answers `202 {ok: true}`
   * ALWAYS, whether or not a user exists with that email (T2.1.1's wire pin)
   * — this method discards that body and resolves `void`, since there is
   * nothing informative in it for the caller to act on.
   *
   * @param input - The email to send the code to.
   * @throws {ApiError} `403 otp_disabled` when the tenant's `otp_enabled` is
   *   false; `400 invalid_body` for a non-object/non-string body.
   */
  async requestCode(input: { email: string }): Promise<void> {
    await this.#host.request<unknown>({
      method: "POST",
      path: "/auth/otp/request",
      body: input,
      requireAuth: false,
    });
  }

  /**
   * Verify a one-time code and mint a session — a standalone alternative to
   * a password, not a second factor, exactly like `console.passkeys`'s
   * `authenticationVerify` (HITL-5 there).
   *
   * PUBLIC — sends no bearer (`requireAuth: false`).
   *
   * @param input - The email the code was requested for, and the code itself.
   * @returns The token, the caller's identity, and the token's lifetime.
   * @throws {ApiError} `401 otp_rejected` for every failure mode (T2.1.1's
   *   wire pin) — an unknown email, an expired code, a wrong code and a
   *   spent code are all indistinguishable to the caller.
   */
  async verifyCode(input: { email: string; code: string }): Promise<OtpVerifyResponse> {
    const res = await this.#host.request<OtpVerifyResponse>({
      method: "POST",
      path: "/auth/otp/verify",
      body: input,
      requireAuth: false,
    });
    return res.body;
  }
}
