/**
 * Configuration resolution: what server, what credential, what project.
 *
 * This module turns whatever the caller supplied — plus the environment, read
 * through the single seam in `src/env.ts` — into one plain {@linkcode
 * ResolvedConfig} value. It is resolved **once, at client construction**, and
 * handed to the transport; nothing downstream re-reads the environment.
 *
 * @module
 */

import { ENV_BASE_URL, ENV_TOKEN, readEnv } from "./env.ts";
import { ConfigError } from "./errors.ts";

/**
 * The API's base path, from the shared contract's `basePath`
 * (`packages/wrappers/endpoints.json`). It is appended to the configured
 * origin by {@linkcode joinBaseUrl}; users never type it.
 */
export const BASE_PATH = "/api";

/**
 * A `fetch`-shaped function.
 *
 * This is the injection seam every test in this package runs against: no test
 * may require a live server (`docs/implementation.md` §9). It is
 * constructor-injected for the same reason the credential is — a module-patched
 * global cannot be exercised two different ways in one process.
 *
 * `globalThis.fetch` satisfies it (a wider parameter type is assignable to a
 * narrower one), while a fake only has to accept a URL string.
 */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Constructor options for a client. Every field is optional. */
export interface W6wClientOptions {
  /**
   * The **origin** of the w6w server, e.g. `https://api.example.com`. The base
   * path (`/api`) is appended for you and is never doubled. Overrides
   * `W6W_BASE_URL`.
   */
  baseUrl?: string;
  /** Bearer token, sent on every request. Overrides `W6W_TOKEN`. */
  token?: string;
  /**
   * Default project id for the project-scoped operations (`documents.*`).
   * Omitted, the server resolves the account's default project. There is no
   * environment variable for this and no `project` on any `vars.*` operation —
   * vars are not project-scoped (`docs/implementation.md` §7).
   */
  project?: string;
  /** Transport override. Defaults to `globalThis.fetch`. */
  fetch?: FetchLike;
}

/**
 * Configuration after resolution — the value the transport actually runs on.
 *
 * Held as **instance** state on the client, never in a module-level variable:
 * two clients in one process must be able to hold different credentials and
 * point at different servers with no interference (`docs/implementation.md` §2).
 */
export interface ResolvedConfig {
  /** Fully joined base, e.g. `https://api.example.com/api`. Never trailing-slashed. */
  readonly baseUrl: string;
  /** The bearer token, or `null` when none was configured. */
  readonly token: string | null;
  /** Default project id, or `null`. */
  readonly project: string | null;
}

/**
 * Join a configured origin with the API base path.
 *
 * The rule is pinned by `docs/implementation.md` §2 and mirrors the house
 * helper that the operator console already uses against this same API, so all
 * clients agree on what `W6W_BASE_URL` means:
 *
 * 1. strip **all** trailing slashes;
 * 2. if the result already ends with the base path, use it as-is — **never
 *    double it**;
 * 3. otherwise append the base path.
 *
 * ```
 * https://api.example.com      → https://api.example.com/api
 * https://api.example.com/     → https://api.example.com/api
 * https://api.example.com///   → https://api.example.com/api
 * https://api.example.com/api  → https://api.example.com/api
 * https://api.example.com/api/ → https://api.example.com/api
 * ```
 *
 * @param origin - The configured origin. Trailing slashes are tolerated.
 * @returns The joined base URL.
 */
export function joinBaseUrl(origin: string): string {
  const trimmed = origin.replace(/\/+$/, "");
  return trimmed.endsWith(BASE_PATH) ? trimmed : `${trimmed}${BASE_PATH}`;
}

/**
 * Resolve constructor options and the environment into one config value.
 *
 * Precedence is **explicit argument > environment variable**, always; there is
 * no default base URL. An explicitly passed empty string is an *explicit*
 * value, not "unset" — it does not fall through to the environment, and an
 * empty base URL is a configuration error either way. Only an absent
 * (`undefined`) argument consults the environment.
 *
 * An **empty or whitespace-only environment variable is absent** and falls
 * through (see `src/env.ts`), so `W6W_BASE_URL=`, `W6W_BASE_URL="  "` and an
 * unset `W6W_BASE_URL` all end here, in the same configuration error — never in
 * a relative `"/api"`.
 *
 * @param options - Constructor options; `fetch` is ignored here (the client owns it).
 * @returns The resolved configuration.
 * @throws {ConfigError} When no usable base URL was supplied, naming `W6W_BASE_URL`.
 */
export function resolveConfig(options: W6wClientOptions = {}): ResolvedConfig {
  const rawBaseUrl = options.baseUrl ?? readEnv(ENV_BASE_URL) ?? "";
  // Surrounding whitespace is stripped before the emptiness test so a blank
  // explicit argument fails the same way a blank environment variable does — an
  // env file's stray "\n" must not become part of the origin.
  const trimmed = rawBaseUrl.trim().replace(/\/+$/, "");
  if (trimmed.length === 0) {
    throw new ConfigError(
      "No w6w base URL is configured. Pass one to the client " +
        '(new W6wClient({ baseUrl: "https://api.example.com" })) or set the ' +
        `${ENV_BASE_URL} environment variable. It holds the server's origin — the ` +
        `${BASE_PATH} base path is appended for you.`,
    );
  }

  return {
    baseUrl: joinBaseUrl(trimmed),
    token: options.token ?? readEnv(ENV_TOKEN) ?? null,
    project: options.project ?? null,
  };
}

/**
 * The token, or a {@linkcode ConfigError} naming `W6W_TOKEN`.
 *
 * A client may be *constructed* without a token so that a CLI's `--help` and
 * `--version` work offline; the error surfaces on the first request instead.
 * There are no anonymous operations in this surface
 * (`docs/implementation.md` §2).
 *
 * A blank token counts as no token, for the same reason a blank base URL does:
 * `W6W_TOKEN=` is how a shell or a Dockerfile spells "I meant to set this and
 * did not", and `Authorization: Bearer ` would turn that into an opaque 401
 * instead of the one message that explains it.
 *
 * @param config - The resolved configuration.
 * @returns The configured token, verbatim.
 * @throws {ConfigError} When no non-blank token is configured.
 */
export function requireToken(config: ResolvedConfig): string {
  if (config.token === null || config.token.trim().length === 0) {
    throw new ConfigError(
      "No w6w API token is configured. Pass one to the client " +
        '(new W6wClient({ token: "…" })) or set the ' +
        `${ENV_TOKEN} environment variable. Every w6w API operation is authenticated.`,
    );
  }
  return config.token;
}
