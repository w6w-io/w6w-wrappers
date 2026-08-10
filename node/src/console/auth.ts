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
 * `getMe` is deliberately NOT modeled here: `client.me()` already exists
 * (`../me.ts`, base surface) and covers `GET /auth/me` exactly.
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
 * The slice of `W6wClient` this namespace needs: the transport, and nothing
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
 * The `console.auth` namespace on a `W6wClient`.
 *
 * @example
 * ```ts
 * const { token } = await client.console.auth.login("user", "pass");
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
}
