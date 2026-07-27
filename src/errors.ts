/**
 * The package's error types.
 *
 * Two of them, and the split is deliberate:
 *
 * - {@linkcode ApiError} — the server answered (or could not be reached at all).
 *   Four fields, pinned identically in all three w6w wrappers by
 *   `docs/implementation.md` §3, and raised by exactly the three failure modes
 *   in `src/http.ts`.
 * - {@linkcode ConfigError} — the client was never in a position to make a
 *   request: no base URL, or no token. No HTTP exchange happened, so an
 *   `ApiError`'s `status` and `code` would have to be invented; `status: 0` in
 *   particular is already spoken for by `network_error`, and conflating "your
 *   server is unreachable" with "you have not configured a server" is exactly
 *   the diagnosis a user needs kept apart.
 *
 * Every public member carries an explicit type annotation. That is a
 * publishing requirement, not a preference: JSR publishes this file as
 * TypeScript source and rejects inferred public types ("no slow types",
 * `docs/implementation.md` §1).
 *
 * @module
 */

/**
 * An error raised by a w6w API call.
 *
 * `raw` is the **parsed response body** when the server sent one, otherwise
 * `null`. It is kept because an error body carries fields the message alone
 * drops — an invoke failure rides alongside `logs` and `apiCalls` — and because
 * a caller inspecting a server error should never have to re-issue the request
 * to see what came back.
 *
 * Classification is by {@linkcode status} plus a **prefix** of
 * {@linkcode code} — `unknown_*` (404), `invalid_*` (400), `*_exists` (409) —
 * never by an exhaustive list of code strings. The server mints codes freely
 * and a closed list in three wrappers would be stale within a release
 * (`docs/implementation.md` §3).
 *
 * One status deserves singling out: **`424` is an app/upstream failure in the
 * execute phase**, and it is a 4xx rather than a 5xx on purpose — Cloudflare
 * replaces an origin 5xx with its own CORS-less HTML page, which would strip
 * the real message. Do not normalise a 424 into a server error or into a
 * transport failure; pass it through with its code and body intact.
 *
 * @example
 * ```ts
 * try {
 *   await client.request({ method: "GET", path: "/vars/var_missing" });
 * } catch (err) {
 *   if (err instanceof ApiError && err.status === 404) {
 *     // err.code === "unknown_var", err.raw === { error: { … } }
 *   }
 * }
 * ```
 */
export class ApiError extends Error {
  /** HTTP status, or `0` when the request never produced a response. */
  readonly status: number;
  /** Server-minted error code, `"network_error"`, or `"bad_response"`. */
  readonly code: string;
  /** The parsed response body, when there was one; otherwise `null`. */
  readonly raw: unknown;

  constructor(status: number, code: string, message: string, raw: unknown = null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.raw = raw;
  }
}

/**
 * The client is not configured well enough to make a request.
 *
 * Raised at construction when there is no base URL, and on the first request
 * when there is no token — a client with no token can still be *built*, so a
 * CLI's `--help` and `--version` work offline (`docs/implementation.md` §2).
 *
 * The message always names the environment variable that would have supplied
 * the missing value, because "which variable?" is the only question a user has
 * at this point.
 */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}
