/**
 * The transport: one `request()`, three failure modes, no policy.
 *
 * Everything the operation modules do goes through {@linkcode request}. It
 * attaches the bearer, serialises a JSON body, reads the response exactly once,
 * parses it guardedly, and raises one of the three failure modes pinned in
 * `docs/implementation.md` §3 — and nothing else. In particular it does **not**
 * retry, does **not** refresh a token, does **not** poll, and does **not**
 * inspect an error code to decide on a side effect. A `401` raises and stops.
 *
 * It also returns the **HTTP status** alongside the parsed body, because a
 * `202` is a normal outcome on this API (a queued workflow run), not an error —
 * and a signature that dropped the status would leave the run operations unable
 * to tell "finished" from "queued" (§4).
 *
 * @module
 */

import { type FetchLike, requireToken, type ResolvedConfig } from "./config.ts";
import { ApiError } from "./errors.ts";

/** HTTP methods this surface uses. */
export type HttpMethod = "GET" | "POST" | "PATCH" | "DELETE";

/**
 * Query parameters. `undefined` values are dropped, so an optional argument
 * can be forwarded without a conditional at the call site. Values are
 * percent-encoded by `URLSearchParams`.
 */
export type QueryParams = Record<string, string | number | boolean | undefined>;

/** One request, fully described. */
export interface RequestOptions {
  /** HTTP method. */
  method: HttpMethod;
  /**
   * Base-relative path with a leading slash, e.g. `/documents`. Build it with
   * the {@linkcode path} tag whenever any part of it comes from the caller.
   */
  path: string;
  /** Query parameters, if any. */
  query?: QueryParams;
  /** Request body. Serialised as JSON when present; omit it for a bodiless request. */
  body?: unknown;
  /**
   * Extra headers to send with this request. Applied as the **base** the
   * transport builds on, never the other way around: the bearer
   * (`authorization`) and, when a body is present, `content-type` are set
   * *after* this base, so a caller-supplied entry with either of those names
   * can never override what this transport sets. Any other header name passes
   * through untouched.
   */
  headers?: Record<string, string>;
}

/**
 * A successful response: the parsed body plus the status that carried it.
 *
 * `body` is `null` for an empty body — a `204`-style response must not crash a
 * caller, and the server's `{ok:true}` deletes carry nothing an operation needs.
 */
export interface HttpResponse<T> {
  status: number;
  body: T;
}

/**
 * Build a base-relative path, percent-encoding every interpolated value.
 *
 * ```ts
 * path`/documents/by-key/${key}`   // key "a/b" → "/documents/by-key/a%2Fb"
 * ```
 *
 * **Use this tag for every path that contains a caller-supplied value**, per the
 * encoding pin in `docs/implementation.md` §2. It exists as a tag rather than a
 * helper function because the encoding then happens at the point of
 * interpolation and cannot be forgotten one call site at a time: there is no way
 * to write the template and skip it.
 *
 * Why it matters, in one line: the server accepts any non-empty key up to 128
 * characters, so `".."` is a key a user can legitimately create — and
 * `` `/documents/by-key/${".."}` `` naively concatenated resolves to the
 * **list** route, returning every document with a `200` and no error anywhere.
 *
 * This is encoding, never validation. A key the server accepts is sent as-is
 * (encoded); the wrapper does not reject, canonicalise or rewrite it. A
 * character policy for keys is business logic, and it lives in the server.
 *
 * The one case encoding cannot fix is a dot-only segment: `.` is unreserved in
 * RFC 3986, and the URL parser behind `fetch` removes dot segments regardless of
 * how they are spelled. `"."` and `".."` are therefore not addressable through a
 * path segment from this runtime — encode and send anyway, and let the server
 * decide what it means.
 *
 * @param strings - Template literal fragments (author-controlled, not encoded).
 * @param values - Interpolated values (caller-controlled, each percent-encoded).
 * @returns The assembled path.
 */
export function path(strings: TemplateStringsArray, ...values: string[]): string {
  return strings.reduce(
    (acc, fragment, i) =>
      i === 0 ? fragment : `${acc}${encodeURIComponent(values[i - 1])}${fragment}`,
    "",
  );
}

/**
 * Assemble the full request URL from a resolved base, a path and query params.
 *
 * The base is already joined with the API base path by `src/config.ts`; the
 * path is appended verbatim (it is expected to be encoded already — see
 * {@linkcode path}), and the query string is built with `URLSearchParams`,
 * which encodes both names and values.
 *
 * @param config - The resolved configuration.
 * @param options - The request being built.
 * @returns The absolute URL to fetch.
 */
export function buildUrl(config: ResolvedConfig, options: RequestOptions): string {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined) params.set(name, String(value));
  }
  const query = params.toString();
  return `${config.baseUrl}${options.path}${query ? `?${query}` : ""}`;
}

/**
 * Perform one request and map its outcome.
 *
 * Returns `{status, body}` on any `2xx`. Raises {@linkcode ApiError} in exactly
 * three cases, transcribed from the studio's client, which has these three and
 * no others:
 *
 * 1. **Transport failure** — `fetch` itself rejected: server down, DNS, TLS,
 *    connection refused. `status` `0`, code `network_error`, and the message
 *    names the **method and full URL** plus the underlying message, because a
 *    bare `TypeError: Failed to fetch` says nothing a user can act on.
 * 2. **Non-JSON body on a non-OK status** — a proxy or Cloudflare HTML error
 *    page. `code` `bad_response`, message carrying a ≤200-character snippet;
 *    reporting it as an opaque `SyntaxError` would throw away the only
 *    diagnostic present. A non-JSON body on an **OK** status is not an error.
 * 3. **Envelope error** — a non-OK status with a JSON body. `code` from
 *    `body.error.code` (else `"error"`), `message` from `body.error.message`
 *    (else the status text), and `raw` = the parsed body, which carries the
 *    fields an invoke failure rides alongside (`logs`, `apiCalls`).
 *
 * A `424` lands in case 3 like any other non-OK JSON status: it means the
 * target app or its upstream vendor failed during execute, and it is
 * deliberately a 4xx so Cloudflare cannot swallow it. It is never a transport
 * error and is never normalised into a 5xx.
 *
 * @param config - Resolved configuration (base URL and credential).
 * @param fetchImpl - The transport to use; injected, never read from a module global.
 * @param options - The request.
 * @returns The status and parsed body.
 * @throws {ConfigError} When no token is configured.
 * @throws {ApiError} On any of the three failure modes above.
 */
export async function request<T>(
  config: ResolvedConfig,
  fetchImpl: FetchLike,
  options: RequestOptions,
): Promise<HttpResponse<T>> {
  const url = buildUrl(config, options);
  // The caller-supplied headers are the BASE the transport builds on, never the
  // reverse: `authorization` and `content-type` are set below, after this base,
  // so nothing a caller passes here can shadow the bearer this transport
  // attaches or the content-type it advertises for a JSON body.
  const headers = new Headers(options.headers);
  // Resolved per request rather than at construction: a client with no token is
  // constructible (so a CLI's --help works offline) and fails here instead.
  headers.set("authorization", `Bearer ${requireToken(config)}`);

  const hasBody = options.body !== undefined;
  if (hasBody) headers.set("content-type", "application/json");

  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: options.method,
      headers,
      body: hasBody ? JSON.stringify(options.body) : undefined,
    });
  } catch (err) {
    throw new ApiError(
      0,
      "network_error",
      `Could not reach the w6w server (${options.method} ${url}). ` +
        `It may be down or unreachable. (${err instanceof Error ? err.message : String(err)})`,
    );
  }

  // Read the body exactly once, as text, then parse it guardedly — a response
  // body is a single-use stream, and `res.json()` on an HTML error page throws
  // an opaque SyntaxError that loses the page.
  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      if (!res.ok) {
        throw new ApiError(
          res.status,
          "bad_response",
          `Server returned a non-JSON ${res.status} response: ${text.slice(0, 200)}`,
        );
      }
    }
  }

  if (!res.ok) {
    const envelope = (data as { error?: { code?: string; message?: string } } | null)?.error ?? {};
    throw new ApiError(
      res.status,
      envelope.code ?? "error",
      envelope.message ?? res.statusText,
      data,
    );
  }

  return { status: res.status, body: data as T };
}
