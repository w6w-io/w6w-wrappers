/**
 * `client.console.passkeys.*` — WebAuthn passkey management and login for
 * self-serve Studio users (T1.1.5).
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
 * **Who this is for (HITL-3).** Passkeys belong to self-serve Studio users
 * only; a partner-tenant user's IdP owns its identity. No eligibility logic
 * lives here — the server enforces it (`PasskeyNotEligibleError`), and this
 * module is a plain transport shim over whatever it decides.
 *
 * **Two routes, four methods, split by who is authenticated.** The management
 * quartet (`registrationOptions`, `registrationVerify`, `list`, `revoke`) is
 * GUARDED, mirroring `packages/server/packages/api/data/passkeys.ts`'s own
 * doc comment ("Registered BELOW the auth guard"). The login pair
 * (`authenticationOptions`, `authenticationVerify`) is PUBLIC, mirroring
 * `packages/server/packages/api/id/passkey-login.ts`'s own doc comment ("BOTH
 * routes are PUBLIC and UNAUTHENTICATED by construction") — discoverable
 * credentials, no identifier in the request body (P1). Each of those two
 * methods passes `requireAuth: false`, the same mechanism
 * `console.auth.login`/`signup`/`checkAccountSlug` rely on: without it a
 * tokenless client (the normal case at the login screen, before any session
 * exists) would hit `requireToken`'s `ConfigError` before `fetch` is ever
 * called.
 *
 * **`authenticationVerify` mints a session, the same way `login` does
 * (HITL-5).** A verified passkey assertion is a standalone alternative to a
 * password, not a second factor — so its response is token-bearing, exactly
 * like `console.auth.login`'s. It is a SEPARATE type from `LoginResponse`
 * (`./auth.ts`), not a reuse: the server route is byte-shape-identical to
 * `user-login.ts`'s login body (`id/passkey-login.ts`'s own doc comment) which
 * carries `role`, `tenant` and `emailVerified` on `user` — fields
 * `console.auth`'s `LoginResponse.user` does not declare.
 *
 * **WebAuthn ceremony payloads (`options`/`response`) are opaque JSON, typed
 * as `Record<string, unknown>`, never as `@simplewebauthn/*` types.** This
 * package has no dependency on `@simplewebauthn` (browser or server) and
 * adding one only to type two pass-through fields would be a new dependency
 * for zero behavioural gain — `inputs.touch` for this task explicitly
 * excludes `package.json`. A caller passes the browser's own
 * `PublicKeyCredentialCreationOptionsJSON`/`...RequestOptionsJSON` (from
 * `options`) into `navigator.credentials.create()`/`.get()` (or a helper such
 * as `@simplewebauthn/browser`'s `startRegistration`/`startAuthentication`)
 * and forwards what comes back as `response` — this module never inspects
 * either shape, only relays it.
 *
 * @module
 */

import { type HttpResponse, path, type RequestOptions } from "../http.ts";
import { unwrap } from "../types.ts";

/**
 * The slice of `W6WClient` this namespace needs: the transport, and nothing
 * else. Structural rather than a concrete client type, so the namespace stays
 * independently constructible in a test and this module never imports the
 * client back — mirrors `TokensHost` in `./tokens.ts`.
 */
export interface PasskeysHost {
  /** Perform one request. */
  request<T>(options: RequestOptions): Promise<HttpResponse<T>>;
}

/**
 * A stored passkey, as the server exposes it. **Never the public key or the
 * counter** — `packages/server/packages/api/data/passkeys.ts`'s own
 * `WirePasskey`/`toWirePasskey()` state the identical invariant server-side.
 */
export interface Passkey {
  /** Server-issued id. */
  id: string;
  /** Caller-chosen label (empty string when none was given at registration). */
  label: string;
  /** ISO-8601 timestamp. */
  createdAt: string;
  /** ISO-8601 timestamp of the credential's last successful authentication, or `null`. */
  lastUsedAt: string | null;
  /** WebAuthn transport hints reported at registration (e.g. `"internal"`, `"hybrid"`). */
  transports: string[];
}

/**
 * A fresh WebAuthn ceremony challenge — the shared result shape of
 * `POST /me/passkeys/options` (`data/passkeys.ts:118-130`) and
 * `POST /auth/passkey/options` (`id/passkey-login.ts:63-71`). Flat, no
 * envelope key.
 */
export interface PasskeyCeremonyOptions {
  /**
   * WebAuthn ceremony options, opaque JSON forwarded verbatim to
   * `navigator.credentials.create()`/`.get()` (or a browser WebAuthn helper).
   * This package never inspects its shape — see this module's header.
   */
  options: Record<string, unknown>;
  /** Single-use challenge token. Echo it back on the paired verify call. */
  challengeToken: string;
}

/** The body `registrationVerify` sends (`POST /me/passkeys`, `data/passkeys.ts:132-164`). */
export interface RegistrationVerifyInput {
  /** The token returned by the paired `registrationOptions()` call. */
  challengeToken: string;
  /**
   * The browser's `RegistrationResponseJSON`, opaque JSON — see this
   * module's header.
   */
  response: Record<string, unknown>;
  /** Caller-chosen label for the new passkey. */
  label?: string;
}

/** The body `authenticationVerify` sends (`POST /auth/passkey/verify`, `id/passkey-login.ts:73-110`). */
export interface AuthenticationVerifyInput {
  /** The token returned by the paired `authenticationOptions()` call. */
  challengeToken: string;
  /**
   * The browser's `AuthenticationResponseJSON`, opaque JSON — see this
   * module's header.
   */
  response: Record<string, unknown>;
}

/**
 * The user identity `authenticationVerify` mints a session for, as
 * `id/passkey-login.ts` returns it — BYTE-SHAPE IDENTICAL to
 * `console.auth`'s `LoginResponse.user`'s sibling in `user-login.ts`, but
 * carrying more fields (`role`, `tenant`, `emailVerified`), which is why this
 * is a separate type rather than a reuse of `./auth.ts`'s `User`.
 */
export interface PasskeyUser {
  /** The user's email, or its `userId` when no email is on file. */
  username: string;
  /** Always `"user"` for a passkey login (`id/passkey-login.ts:100`). */
  role: string;
  /** The tenant the session is minted in. */
  tenant: string;
  emailVerified: boolean;
}

/**
 * `POST /auth/passkey/verify` → 200 (`id/passkey-login.ts:96-105`). Mints a
 * session exactly like `console.auth.login` does (HITL-5) — a verified
 * passkey assertion is a standalone alternative to a password, not a second
 * factor.
 */
export interface PasskeyAuthenticationVerifyResponse {
  token: string;
  user: PasskeyUser;
  expiresIn: number;
}

/**
 * The `console.passkeys` namespace on a `W6WClient`.
 *
 * @example
 * ```ts
 * // Registration (authenticated).
 * const { options, challengeToken } = await client.console.passkeys.registrationOptions();
 * const response = await startRegistration({ optionsJSON: options }); // e.g. @simplewebauthn/browser
 * const passkey = await client.console.passkeys.registrationVerify({ challengeToken, response });
 *
 * // Login (public — works on a tokenless client).
 * const opts = await client.console.passkeys.authenticationOptions();
 * const assertion = await startAuthentication({ optionsJSON: opts.options });
 * const { token } = await client.console.passkeys.authenticationVerify({
 *   challengeToken: opts.challengeToken,
 *   response: assertion,
 * });
 * ```
 */
export class PasskeysApi {
  readonly #host: PasskeysHost;

  /**
   * @param host - The client this namespace issues requests through.
   */
  constructor(host: PasskeysHost) {
    this.#host = host;
  }

  /**
   * A fresh registration challenge, scoped to the caller's own identity.
   *
   * AUTHENTICATED — the default `requireAuth` applies.
   *
   * @returns The ceremony options and a single-use challenge token.
   * @throws {ApiError} `400 passkey_not_configured`, `403 passkey_not_eligible`.
   */
  async registrationOptions(): Promise<PasskeyCeremonyOptions> {
    const res = await this.#host.request<PasskeyCeremonyOptions>({
      method: "POST",
      path: "/me/passkeys/options",
      body: {},
    });
    return res.body;
  }

  /**
   * Verify a registration ceremony and store the credential.
   *
   * AUTHENTICATED — the default `requireAuth` applies.
   *
   * @param input - The challenge token from `registrationOptions()`, the browser's ceremony
   *   response, and an optional caller-chosen label.
   * @returns The stored passkey's metadata, unwrapped from the `passkey` envelope.
   * @throws {ApiError} `400 passkey_registration_failed`, `403 passkey_not_eligible`,
   *   `409 passkey_already_registered`.
   */
  async registrationVerify(input: RegistrationVerifyInput): Promise<Passkey> {
    const res = await this.#host.request<unknown>({
      method: "POST",
      path: "/me/passkeys",
      body: input,
    });
    return unwrap<Passkey>(res, "passkey");
  }

  /**
   * A fresh authentication challenge. No identifier is sent or accepted —
   * discoverable credentials only (P1): the owner is resolved server-side
   * from the assertion itself, never from anything this call sends.
   *
   * PUBLIC — sends no bearer, even on a client that already holds one
   * (`requireAuth: false`). Without it, the login screen (the normal case:
   * no session exists yet) could never call this method at all — a tokenless
   * client would hit `requireToken`'s `ConfigError` before `fetch` is ever
   * called.
   *
   * @returns The ceremony options and a single-use challenge token.
   * @throws {ApiError} `400 passkey_not_configured`.
   */
  async authenticationOptions(): Promise<PasskeyCeremonyOptions> {
    const res = await this.#host.request<PasskeyCeremonyOptions>({
      method: "POST",
      path: "/auth/passkey/options",
      body: {},
      requireAuth: false,
    });
    return res.body;
  }

  /**
   * Verify an authentication (login) ceremony and mint a session — the same
   * way `console.auth.login` does (HITL-5).
   *
   * PUBLIC — sends no bearer, even on a client that already holds one
   * (`requireAuth: false`). Every failure mode past a malformed body is the
   * same `401 passkey_rejected` (P9): unknown credential, revoked credential,
   * wrong kind, bad signature, counter regression, and a spent/invalid
   * challenge are indistinguishable to the caller.
   *
   * @param input - The challenge token from `authenticationOptions()` and the browser's ceremony
   *   response.
   * @returns The token, the caller's identity, and the token's lifetime.
   * @throws {ApiError} `401 passkey_rejected` on any verification failure.
   */
  async authenticationVerify(
    input: AuthenticationVerifyInput,
  ): Promise<PasskeyAuthenticationVerifyResponse> {
    const res = await this.#host.request<PasskeyAuthenticationVerifyResponse>({
      method: "POST",
      path: "/auth/passkey/verify",
      body: input,
      requireAuth: false,
    });
    return res.body;
  }

  /**
   * List the caller's own passkeys.
   *
   * AUTHENTICATED — the default `requireAuth` applies.
   *
   * @returns The caller's passkeys, unwrapped from the `passkeys` envelope. Never the empty array
   *   collapsed to `undefined` — an empty account gets `[]`.
   */
  async list(): Promise<Passkey[]> {
    const res = await this.#host.request<unknown>({ method: "GET", path: "/me/passkeys" });
    return unwrap<Passkey[]>(res, "passkeys");
  }

  /**
   * Revoke (delete) one of the caller's own passkeys.
   *
   * AUTHENTICATED — the default `requireAuth` applies.
   *
   * @param id - The passkey id.
   * @returns Nothing: the server answers `204` with no body.
   * @throws {ApiError} `404 passkey_not_found`.
   */
  async revoke(id: string): Promise<void> {
    await this.#host.request<unknown>({ method: "DELETE", path: path`/me/passkeys/${id}` });
  }
}
