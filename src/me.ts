/**
 * `client.me()` — who the caller is, and what answered.
 *
 * One GET, no envelope. The response body is **flat** — `{tenant, subject,
 * account, role, versions?}` — because `/api/me` is an alias of the host's
 * existing identity handler rather than a second one (`docs/endpoints.md` §1,
 * D15). There is therefore nothing for `unwrap` to do here, and this is the one
 * read operation in the package that does not call it.
 *
 * **`status: "planned"`** in `endpoints.json`: the identity half is served today
 * at a different path, and `/api/me` itself lands with T4.2.1 (fenced by BLK-1).
 * The wrapper targets the contracted path now; against a server that has not
 * mounted it yet the call is a `404`, which is the correct failure and is not
 * worked around here.
 *
 * The one thing this module adds to the body is `versions.wrapper`, which the
 * server cannot know — it is this package's own published version. It is a
 * **fill, never an overwrite**: a key the server supplied wins, including
 * `wrapper` itself, so a future host that has a better answer is not silently
 * overruled by the client.
 *
 * It is deliberately not a namespace class. `endpoints.json` names this
 * operation `client.me()`, a method on the client itself, so the module exports
 * a function over a narrow host interface and `W6wClient` delegates to it —
 * same layering as the namespaces, without inventing a `client.me.me()`.
 *
 * @module
 */

import { ApiError } from "./errors.ts";
import type { HttpResponse, RequestOptions } from "./http.ts";
import type { Me } from "./types.ts";
import { VERSION } from "./version.ts";

/**
 * The slice of `W6wClient` this operation needs: the transport, and nothing
 * else. Structural rather than a concrete client type, so it stays
 * independently callable in a test and this module never imports the client
 * back.
 */
export interface MeHost {
  /** Perform one request. */
  request<T>(options: RequestOptions): Promise<HttpResponse<T>>;
}

/**
 * Fetch the caller's identity and the component versions behind it.
 *
 * The identity fields are returned exactly as they arrived — unknown ones
 * included, since the return is an interface and not a closed schema.
 * `versions` is normalised to always exist and to always carry a `wrapper`
 * entry, so a caller printing a version banner never has to branch on whether
 * the server sent the block at all.
 *
 * @param host - The client this operation issues its request through.
 * @returns The caller's identity, with `versions.wrapper` filled in.
 * @throws {ApiError} On any non-2xx, e.g. `401` when the token is not accepted.
 * @throws {ApiError} `bad_response` when a 2xx body is not a plain object — an
 * array included, since `typeof [] === "object"` and a spread array yields
 * character-indexed keys rather than identity fields.
 */
export async function fetchMe(host: MeHost): Promise<Me> {
  const res = await host.request<Me>({ method: "GET", path: "/me" });
  const body = res.body;
  // A body that is not an object cannot be identity data. Raise rather than
  // spread it — the same `bad_response` class the envelope reader uses for the
  // keyed routes — so a proxy answering `200 "ok"` fails here instead of
  // returning a `Me` whose only populated field is the one this client just
  // added.
  //
  // `Array.isArray` is load-bearing, not belt-and-braces: `typeof [] === "object"`
  // and `[] !== null`, so without it a `200 []` spread into exactly the degenerate
  // value described above — measured, `{"versions":{"wrapper":"0.1.0"}}` — and
  // `200 [{...}]` produced character-indexed keys. It also keeps this lane in step
  // with python, whose natural `isinstance(body, dict)` excludes a list already.
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new ApiError(
      res.status,
      "bad_response",
      `Server returned a ${res.status} whose body is not an identity object.`,
      body,
    );
  }
  // Same reasoning one level down: `versions` is typed `Record<string, string>`,
  // but the wire can carry anything, and spreading a string produces
  // character-indexed junk (`"1.2.3"` → `{"0":"1","1":".",…}`) that satisfies the
  // type and so is invisible to the compiler. A `versions` that is not a plain
  // object is dropped in favour of the client's own fill rather than merged —
  // this operation reports identity, and inventing keys out of a malformed block
  // would be worse than reporting only what this client actually knows.
  const versions = body.versions;
  const merged = typeof versions === "object" && versions !== null && !Array.isArray(versions)
    ? versions
    : undefined;
  return {
    ...body,
    // Spread order is the policy: the wrapper's own version is the DEFAULT and
    // every key the server sent lands on top of it, `wrapper` included.
    versions: { wrapper: VERSION, ...merged },
  };
}
