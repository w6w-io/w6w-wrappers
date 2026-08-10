/**
 * `client.console.tokens.*` — long-lived API tokens for programmatic access
 * (list, create, disable, enable, revoke), relocated from the studio's own
 * API client.
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
 * **`create`'s plaintext-once invariant is the mechanism this whole domain
 * rests on.** `POST /tokens` is the ONLY response in this entire package that
 * returns a token's plaintext — there is no reveal-later route. That is why
 * {@linkcode CreateTokenResponse} is a SEPARATE type from {@linkcode ApiToken}
 * rather than an optional `secret?` field bolted onto it: `ApiToken` — the
 * return type of every other method here (`list`/`disable`/`enable`/`revoke`)
 * — structurally cannot carry a `secret`, which makes "nothing reachable
 * through those four methods can ever carry a secret" a compile-time fact,
 * not a runtime convention. The server's own `toWire()` doc comment states
 * the same invariant server-side: "never carries the secret, the hash, or
 * internals."
 *
 * Five methods relocate from the studio's own `// API tokens` comment block
 * (`packages/studio/src/api/client.ts:280-303` on the current merged tree) —
 * field-for-field, not redesigned. Studio never sends `account` or
 * `includeRevoked` on `list` (the server's list default already excludes
 * revoked) — per HITL-4's own philosophy ("SDK completeness tracks studio's
 * actual call surface, not the server's full route surface"), neither is
 * added here.
 *
 * None of these methods take a `project` scoping parameter — tokens are
 * account-scoped via the credential alone — so `TokensHost` needs only the
 * transport, mirroring `VarsHost`/`ConnectionsHost`, not `DocumentsHost`.
 *
 * @module
 */

import { type HttpResponse, path, type RequestOptions } from "../http.ts";
import { unwrap } from "../types.ts";

/**
 * The slice of `W6wClient` this namespace needs: the transport, and nothing
 * else. Structural rather than a concrete client type, so the namespace stays
 * independently constructible in a test and this module never imports the
 * client back — mirrors `ConnectionsHost` in `./connections.ts`.
 */
export interface TokensHost {
  /** Perform one request. */
  request<T>(options: RequestOptions): Promise<HttpResponse<T>>;
}

/** Lifecycle status of an API token. `revoked` is terminal; `disabled` is reversible. */
export type ApiTokenStatus = "active" | "disabled" | "revoked";

/**
 * A long-lived API token for programmatic access — distinct from the studio's
 * own session JWT. **Never carries `secret`** — the server's `toWire()` never
 * puts it on the wire for this shape, and neither does this type. The
 * plaintext is reachable only once, from {@linkcode CreateTokenResponse}.
 */
export interface ApiToken {
  /** Server-issued id. */
  id: string;
  /** The account this token authenticates as. */
  account: string;
  /** Caller-chosen label. */
  name: string;
  /** Lifecycle status. */
  status: ApiTokenStatus;
  /** ISO-8601 timestamp. */
  createdAt: string;
  /** ISO-8601 timestamp. */
  updatedAt: string;
  /** ISO-8601 timestamp of revocation, or `null` while active/disabled. */
  revokedAt: string | null;
}

/**
 * `create`'s result — the token's metadata plus its plaintext secret, shown
 * exactly ONCE. Defined as a type **separate** from {@linkcode ApiToken}, not
 * an optional field on it — see this module's header comment for why that
 * separation is load-bearing rather than a style choice. There is no
 * reveal-later route: if the caller does not capture `secret` here, it is
 * gone.
 */
export interface CreateTokenResponse {
  /** The created token's metadata. Never carries the secret. */
  token: ApiToken;
  /** The plaintext credential. Shown exactly once — never logged, never re-fetchable. */
  secret: string;
}

/**
 * The `console.tokens` namespace on a `W6wClient`.
 *
 * @example
 * ```ts
 * const tokens = await client.console.tokens.list();
 * const { token, secret } = await client.console.tokens.create("ci-deploy");
 * console.log(secret); // shown exactly once — capture it now or it is gone
 * await client.console.tokens.disable(token.id);
 * await client.console.tokens.enable(token.id);
 * await client.console.tokens.revoke(token.id);
 * ```
 */
export class TokensApi {
  readonly #host: TokensHost;

  /**
   * @param host - The client this namespace issues requests through.
   */
  constructor(host: TokensHost) {
    this.#host = host;
  }

  /**
   * List the account's tokens. Excludes revoked tokens (the server's default);
   * this method does not expose a parameter to include them, matching
   * studio's own call surface.
   *
   * @returns The tokens, unwrapped from the `tokens` envelope. Never carries `secret`.
   */
  async list(): Promise<ApiToken[]> {
    const res = await this.#host.request<unknown>({ method: "GET", path: "/tokens" });
    return unwrap<ApiToken[]>(res, "tokens");
  }

  /**
   * Create a token. **Returns the plaintext secret exactly once** — there is
   * no reveal-later route, so a caller that does not capture it here has
   * permanently lost it.
   *
   * **No envelope key to peel — the whole body IS `{token, secret}`.** Typed
   * directly as `request<CreateTokenResponse>(...)`, returning `res.body`,
   * mirroring `console.connections.test`'s/`console.reliability.list`'s
   * established "no envelope key" pattern. `unwrap()` is deliberately not
   * called here: there is no single key to unwrap.
   *
   * @param name - Caller-chosen label.
   * @returns The created token's metadata plus its one-time plaintext secret.
   * @throws {ApiError} `400 invalid_name`.
   */
  async create(name: string): Promise<CreateTokenResponse> {
    const res = await this.#host.request<CreateTokenResponse>({
      method: "POST",
      path: "/tokens",
      body: { name },
    });
    return res.body;
  }

  /**
   * Disable a token. Reversible — see {@linkcode enable}.
   *
   * @param id - The token id.
   * @returns The updated token, unwrapped from the `token` envelope. Never carries `secret`.
   * @throws {ApiError} `404 unknown_token`/`unknown_account`.
   */
  async disable(id: string): Promise<ApiToken> {
    const res = await this.#host.request<unknown>({
      method: "POST",
      path: path`/tokens/${id}/disable`,
      body: {},
    });
    return unwrap<ApiToken>(res, "token");
  }

  /**
   * Re-enable a disabled token.
   *
   * @param id - The token id.
   * @returns The updated token, unwrapped from the `token` envelope. Never carries `secret`.
   * @throws {ApiError} `404 unknown_token`/`unknown_account`; `409 invalid_transition` when the
   * token is revoked (revoke is terminal).
   */
  async enable(id: string): Promise<ApiToken> {
    const res = await this.#host.request<unknown>({
      method: "POST",
      path: path`/tokens/${id}/enable`,
      body: {},
    });
    return unwrap<ApiToken>(res, "token");
  }

  /**
   * Revoke a token. Terminal — a revoked token cannot be re-enabled.
   *
   * @param id - The token id.
   * @returns The updated token, unwrapped from the `token` envelope. Never carries `secret`.
   * @throws {ApiError} `404 unknown_token`/`unknown_account`.
   */
  async revoke(id: string): Promise<ApiToken> {
    const res = await this.#host.request<unknown>({
      method: "POST",
      path: path`/tokens/${id}/revoke`,
      body: {},
    });
    return unwrap<ApiToken>(res, "token");
  }
}
