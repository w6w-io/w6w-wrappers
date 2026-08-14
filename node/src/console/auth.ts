/**
 * `client.console.auth.*` — self-serve login and signup, relocated from the
 * studio's own API client.
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
 * **The public/authenticated split is per-method, not per-file.** `login`,
 * `signup` and `checkAccountSlug` are registered server-side ABOVE
 * `app.use("*", authGuard)` (`packages/server/packages/api/data/signup.ts:23-41`
 * and `id/auth.ts:22-55`) and must never read a principal — any bearer a
 * caller sends is inert on these three routes, so each passes
 * `requireAuth: false` and the transport never even attempts to attach one
 * (`../http.ts`, HITL-9). `createAccount` is the authenticated counterpart
 * (`id/signup.ts:33-78`) and uses the default, unconditional `requireAuth`.
 * `login` is how a caller gets a token in the first place — without
 * `requireAuth: false` it could never be called by a tokenless client, since
 * `requireToken` would raise before the request ever reached `fetch`.
 *
 * **`getMe` IS modeled here now — that changed, and this is why.** This file
 * previously said it was deliberately not modeled, because `client.me()`
 * (`../me.ts`, base surface) covered `GET /auth/me` exactly. It no longer does.
 * The route answers additively with a **studio-internal capability field**,
 * `tenantAdmin` (`plan-B.md` § WIRE PINS W1/W9), and the published `Me`
 * (`../types.ts:104-123`) deliberately does not carry it: `Me` is part of the
 * published partner contract — `endpoints.json` names it as the `me`
 * operation's `returns` — so declaring a field there would be a
 * publish-in-lockstep change across every language wrapper (CLAUDE.md), for
 * what is a studio-only authorization hint. The console surface is exactly the
 * place a studio-only projection belongs, so the capability is typed on
 * {@linkcode ConsoleMe} instead, and `client.me()` stays untouched and keeps
 * returning the published shape. Both read the same route; they differ only in
 * what they promise about the body.
 *
 * **Response shapes are flat, no envelope key**, mirroring
 * `console/reliability.ts`'s own pattern (verified against the server route
 * handlers, not assumed) — every method here returns `res.body` directly and
 * never calls this package's `unwrap()` helper.
 *
 * @module
 */

import type { HttpResponse, RequestOptions } from "../http.ts";

/**
 * The slice of `W6WClient` this namespace needs: the transport, and nothing
 * else. Structural rather than a concrete client type, so the namespace stays
 * independently constructible in a test and this module never imports the
 * client back — mirrors `ReliabilityHost` in `./reliability.ts`.
 */
export interface AuthHost {
  /** Perform one request. */
  request<T>(options: RequestOptions): Promise<HttpResponse<T>>;
}

/** The authenticated user, as `POST /auth/login` returns it (`id/auth.ts:49-53`). */
export interface User {
  username: string;
}

/** `POST /auth/login` → 200 (`id/auth.ts:49-53`). */
export interface LoginResponse {
  token: string;
  user: User;
  expiresIn: number;
}

/** The signed-up user, as `POST /auth/signup` returns it (`data/signup.ts:147-152`). */
export interface SignupUser {
  id: string;
  email: string;
  displayName: string;
  /** Derived server-side from `email_verified_at`; signup never waits on it. */
  emailVerified: boolean;
  tenant: string;
}

/** An account, as the signup family returns it (`data/signup.ts` / `id/signup.ts`). */
export interface AccountWire {
  id: string;
  tenant: string;
  name: string;
  slug: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

/** The body `signup` sends. `inviteToken` is accepted server-side (`data/signup.ts:129-134`)
 * even though the studio's own client never sends it — modeled here for a future caller. */
export interface SignupInput {
  email: string;
  password: string;
  displayName?: string;
  inviteToken?: string;
}

/**
 * `POST /auth/signup` → 201 (`data/signup.ts:147-152`). `account` is the
 * invite's account, else `null` — a signup with no `inviteToken` always gets
 * `null` here.
 */
export interface SignupResponse {
  token: string;
  expiresIn: number;
  user: SignupUser;
  account: AccountWire | null;
}

/** `GET /auth/signup/slug-available?name=` → 200 (`data/signup.ts:170`). */
export interface SlugAvailabilityResponse {
  slug: string;
  available: boolean;
  suggestions: string[];
}

/** `POST /accounts` → 201 (`id/signup.ts:69-73`). The token re-issues the session
 * with the new account's claim on it. */
export interface CreateAccountResponse {
  account: AccountWire;
  token: string;
  expiresIn: number;
}

/**
 * `GET /auth/me` as the console reads it (W1/W9) — a **superset** of the
 * published `Me` (`../types.ts:104-123`), carrying the studio-internal
 * capability field that shape deliberately does not declare. See this module's
 * header for why the field lives here and not there.
 *
 * The published contract already requires clients to tolerate unknown keys on
 * this route, so widening it server-side broke no partner; this type simply
 * names one of those keys for the one client that acts on it.
 */
export interface ConsoleMe {
  /** Tenant the caller belongs to. */
  tenant: string;
  /** The authenticated subject (a user or a machine principal). */
  subject: string;
  /** Account the caller is acting in. */
  account: string;
  /** The caller's role within that account. */
  role: string;
  /** The base callable URLs are rendered against. Present on this host; do not derive URLs from it. */
  invokeBaseUrl?: string;
  /**
   * Server-decided: may this caller administer its tenant? Studio-internal;
   * not on the published `Me`.
   *
   * **Required, not optional, on purpose.** A client forced to branch on
   * `undefined` is a client that will branch wrong; an older server that omits
   * the key yields `undefined` at runtime, which is falsy, so every
   * `if (me.tenantAdmin)` fails CLOSED — the capability is denied, never
   * accidentally granted.
   */
  tenantAdmin: boolean;
  /** Component versions, as the published `Me` documents them. Optional and open. */
  versions?: Record<string, string>;
}

/**
 * The `console.auth` namespace on a `W6WClient`.
 *
 * @example
 * ```ts
 * const { token } = await client.console.auth.login("user", "pass");
 * const me = await client.console.auth.getMe();
 * if (me.tenantAdmin) { // tenant-admin surface
 * }
 * ```
 */
export class AuthApi {
  readonly #host: AuthHost;

  /**
   * @param host - The client this namespace issues requests through.
   */
  constructor(host: AuthHost) {
    this.#host = host;
  }

  /**
   * Authenticate with the configured credential and mint a session token.
   *
   * PUBLIC — sends no bearer, even on a client that already holds one
   * (`requireAuth: false`).
   *
   * @param username - The account username.
   * @param password - The account password.
   * @returns The token, the caller's identity, and the token's lifetime.
   * @throws {ApiError} On any non-2xx, e.g. `401` for invalid credentials.
   */
  async login(username: string, password: string): Promise<LoginResponse> {
    const res = await this.#host.request<LoginResponse>({
      method: "POST",
      path: "/auth/login",
      body: { username, password },
      requireAuth: false,
    });
    return res.body;
  }

  /**
   * Self-serve signup: creates the user and mints a `role: "user"` session.
   *
   * PUBLIC — sends no bearer, even on a client that already holds one
   * (`requireAuth: false`).
   *
   * @param input - Email, password, and the optional displayName/inviteToken.
   * @returns The token, its lifetime, the created user, and the invite's account (else `null`).
   * @throws {ApiError} On any non-2xx, e.g. `409` when the email is taken.
   */
  async signup(input: SignupInput): Promise<SignupResponse> {
    const res = await this.#host.request<SignupResponse>({
      method: "POST",
      path: "/auth/signup",
      body: input,
      requireAuth: false,
    });
    return res.body;
  }

  /**
   * Check whether an account slug is free, and get free alternatives if not.
   *
   * PUBLIC — sends no bearer, even on a client that already holds one
   * (`requireAuth: false`). Advisory only: the unique index decides at create
   * time, so a `409` from `createAccount` is a normal outcome, not a
   * contradiction of what this returned.
   *
   * @param name - The slug (or candidate name) to check.
   * @returns The server's normalization of `name`, whether it is available, and up to five alternatives.
   * @throws {ApiError} On any non-2xx.
   */
  async checkAccountSlug(name: string): Promise<SlugAvailabilityResponse> {
    const res = await this.#host.request<SlugAvailabilityResponse>({
      method: "GET",
      path: "/auth/signup/slug-available",
      query: { name },
      requireAuth: false,
    });
    return res.body;
  }

  /**
   * Create an account for the caller and re-issue the session with its claim.
   *
   * AUTHENTICATED — the default `requireAuth` applies. NOTE the returned
   * token is minted `role: "user"` unconditionally (`id/auth.ts:112`), so
   * adopting it downgrades an operator; this method never writes the session
   * itself, the caller decides.
   *
   * @param name - The account's display name.
   * @param slug - The account's slug.
   * @returns The created account, a re-issued token carrying its claim, and the token's lifetime.
   * @throws {ApiError} On any non-2xx, e.g. `409` when the slug is taken.
   */
  async createAccount(name: string, slug: string): Promise<CreateAccountResponse> {
    const res = await this.#host.request<CreateAccountResponse>({
      method: "POST",
      path: "/accounts",
      body: { name, slug },
    });
    return res.body;
  }

  /**
   * Read the caller's identity **and its tenant-admin capability**.
   *
   * AUTHENTICATED — the default `requireAuth` applies, unlike `login`,
   * `signup` and `checkAccountSlug`. `/auth/me` reads the principal, so a
   * request without a bearer is a `401`, and a tokenless client raises
   * `ConfigError` before `fetch` is ever called.
   *
   * Same route as the base surface's `client.me()`; this one promises the
   * console projection ({@linkcode ConsoleMe}) instead of the published `Me`.
   * Unlike `client.me()` it does **not** fill in a `versions.wrapper` entry
   * from this package's own `VERSION` (`../me.ts` does that): what this returns
   * is the server's body, verbatim.
   *
   * @returns The caller's identity, plus `tenantAdmin`.
   * @throws {ApiError} On any non-2xx, e.g. `401` when the bearer is missing or expired.
   */
  async getMe(): Promise<ConsoleMe> {
    const res = await this.#host.request<ConsoleMe>({
      method: "GET",
      path: "/auth/me",
    });
    return res.body;
  }
}
