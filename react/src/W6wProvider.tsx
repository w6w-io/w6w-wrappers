/**
 * `<W6wProvider>` — one `W6wClient` per `baseUrl`, with per-request token
 * freshness (C-4).
 *
 * `@w6w/sdk`'s `W6wClientOptions.token` (`node/src/config.ts:41-63`) is
 * resolved ONCE, at construction, into `readonly` instance state
 * (`node/src/client.ts:59`) — there is no supplier form. A naive
 * `new W6wClient({ token })` therefore captures whatever `token` was at mount
 * time and never sees a later rotation.
 *
 * The fix lives at the `fetch`-injection seam, not the `token` seam.
 * `node/src/http.ts`'s `request()` builds `headers = new Headers(options.headers)`
 * and then unconditionally `headers.set("authorization", ...)` BEFORE calling
 * the injected `fetchImpl(url, {method, headers, body})` — `Headers.set`
 * REPLACES, so a custom `fetch` passed to `new W6wClient({ fetch })` can read
 * the CURRENT token and overwrite `authorization` on the `Headers` object it
 * receives, immediately before delegating to the real transport. This
 * provider therefore constructs its `W6wClient` ONCE, with a non-blank
 * placeholder token (any non-blank string satisfies `requireToken`,
 * `config.ts:229-237` — it is never actually sent, since the injected `fetch`
 * always overwrites it first) and an injected `fetch` that resolves the
 * current `token` prop (calling it, if it is a supplier) on every call.
 *
 * **Do not key the outer `useMemo` on `token`.** `packages/studio/src/api/apiClient.tsx`
 * rebuilds its client whenever the token STRING changes — the right policy for
 * studio's own state-variable token, and the wrong one here: a supplier
 * function has a stable identity across renders, so keying on the supplier
 * would never rebuild AND never read a fresh value, while keying on the
 * token's resolved value would tear the client down and rebuild it on every
 * rotation — exactly what C-4 says not to do ("without tearing down"). The
 * memo below depends on `[baseUrl, project]` only; `token` and `fetch` are
 * read through "latest" refs, updated every render but never a dependency, so
 * a rotating token is read fresh per request without ever rebuilding the
 * client.
 *
 * @module
 */
import { type FetchLike, W6wClient } from "@w6w/sdk";
import { type ReactNode, createContext, useContext, useMemo, useRef } from "react";

/** A static bearer token, or a supplier read fresh on every request. */
export type TokenSource = string | (() => string | null | undefined);

/**
 * Satisfies `requireToken` at construction so the client never throws a
 * `ConfigError` for "no token" — this value is never actually sent on the
 * wire, since the injected `fetch` below always overwrites it first. See
 * this module's header.
 */
const PLACEHOLDER_TOKEN = "w6w-react-unused-placeholder-token";

export interface W6wProviderProps {
  /** The w6w server's origin, e.g. `"https://api.example.com"`. */
  baseUrl: string;
  /** A literal bearer token, or a supplier called fresh on every request. */
  token: TokenSource;
  /**
   * The real transport this provider's injected `fetch` delegates to, after
   * overwriting the `authorization` header. Defaults to `globalThis.fetch`.
   * Mainly for tests — a caller wanting to record or stub outbound requests.
   */
  fetch?: FetchLike;
  /** Default project id for the project-scoped operations (`documents.*`, `workflows.list`). */
  project?: string;
  children: ReactNode;
}

const Ctx = createContext<W6wClient | null>(null);

/**
 * Provides one memoized `W6wClient` to every component under it. See this
 * module's header for the C-4 token-freshness mechanism.
 */
export function W6wProvider(props: W6wProviderProps): ReactNode {
  const { baseUrl, token, fetch: fetchOverride, project, children } = props;

  // "Latest ref" pattern: kept in sync on every render, but never a `useMemo`
  // dependency below — the injected `fetch` always reads the CURRENT prop
  // value through these, so a token rotation or a new `fetch` prop identity
  // never forces a client rebuild. Refs are stable across renders and are not
  // "reactive" values, so `useExhaustiveDependencies` correctly does not
  // require them in the memo's dependency array.
  const tokenRef = useRef(token);
  tokenRef.current = token;
  const fetchRef = useRef(fetchOverride);
  fetchRef.current = fetchOverride;

  const client = useMemo(() => {
    const injectedFetch: FetchLike = (input, init) => {
      const current =
        typeof tokenRef.current === "function" ? tokenRef.current() : tokenRef.current;
      const headers = new Headers(init?.headers);
      if (current) {
        headers.set("authorization", `Bearer ${current}`);
      }
      const transport: FetchLike =
        fetchRef.current ?? ((i: string, ii?: RequestInit) => globalThis.fetch(i, ii));
      return transport(input, { ...init, headers });
    };
    return new W6wClient({ baseUrl, token: PLACEHOLDER_TOKEN, project, fetch: injectedFetch });
  }, [baseUrl, project]);

  return <Ctx.Provider value={client}>{children}</Ctx.Provider>;
}

/**
 * Access the memoized `W6wClient`. Throws a helpful error if used outside a
 * `<W6wProvider>` (mirrors `packages/ui/src/provider.tsx:249-258`'s
 * `useW6wApi` shape — read-only reference, transcribed here, never imported).
 */
export function useW6wClient(): W6wClient {
  const client = useContext(Ctx);
  if (!client) {
    throw new Error(
      "useW6wClient must be used inside <W6wProvider>. " +
        'Wrap your app root with <W6wProvider baseUrl="..." token="...">...</W6wProvider>.',
    );
  }
  return client;
}
