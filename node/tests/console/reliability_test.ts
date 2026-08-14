/**
 * `client.console.reliability.*`, against an injected fake `fetch`.
 *
 * No case here needs a live server (`docs/implementation.md` §9). Beyond the
 * per-operation assertions, this suite pins the one thing that differs from
 * every other namespace: the server's `GET /reliability/services` response has
 * **no envelope key**, so `list` must return the body verbatim rather than
 * calling this package's `unwrap()` (which would look for a `"reliability"`
 * key the server never sends and raise `bad_response` on every real call).
 */

import { assertEquals, assertMatch } from "@std/assert";
import { W6WClient } from "../../src/client.ts";
import type { FetchLike } from "../../src/config.ts";
import type { ReliabilityServices } from "../../src/console/reliability.ts";

/** One recorded call to the fake transport. */
interface Call {
  url: string;
  method: string | undefined;
  headers: Headers;
  body: string | null;
}

/** A `fetch`-shaped fake; `respond` produces the `Response` to hand back. */
function fakeFetch(respond: (call: Call) => Response): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: FetchLike = (input, init) => {
    calls.push({
      url: input,
      method: init?.method,
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? init.body : null,
    });
    return Promise.resolve(respond(calls[calls.length - 1]));
  };
  return { fetch, calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A realistic board, top-level, no wrapper key. */
const BOARD: ReliabilityServices = {
  account: "acct_1",
  window: { from: "2026-07-10T00:00:00.000Z", to: "2026-08-09T00:00:00.000Z", days: 30 },
  uptimeMeans: "Percentage of calls that succeeded.",
  definition: { id: "default", version: "1", source: "built-in" },
  services: [],
};

/** A client wired to a fake transport. */
function client(respond: (call: Call) => Response): { client: W6WClient; calls: Call[] } {
  const fake = fakeFetch(respond);
  return {
    client: new W6WClient({
      baseUrl: "https://api.example.com",
      token: "tok_1",
      fetch: fake.fetch,
    }),
    calls: fake.calls,
  };
}

Deno.test("console.reliability: list is a function on a constructed client", () => {
  // Runtime, not type-level: a namespace that silently lost the method would
  // still typecheck everywhere else in this suite.
  const c = new W6WClient({ baseUrl: "https://api.example.com", token: "t" });
  assertEquals(typeof c.console.reliability.list, "function");
});

Deno.test(
  "console.reliability.list resolves with the payload VERBATIM — no unwrap()",
  async () => {
    const c = client(() => json(BOARD));

    const board = await c.client.console.reliability.list(30, 5);

    // Deep-equals the mocked payload exactly: a tree that wrongly called
    // unwrap(res, "reliability") would reject instead of resolving here, since
    // the mocked body carries no "reliability" key — this assertion is on
    // promise RESOLUTION as much as on shape.
    assertEquals(board, BOARD);
    assertEquals(c.calls.length, 1);
    assertMatch(
      c.calls[0].url,
      /^https:\/\/api\.example\.com\/reliability\/services\?days=30&limit=5$/,
    );
  },
);

Deno.test("console.reliability.list omits `limit` entirely when not given", async () => {
  const c = client(() => json(BOARD));

  await c.client.console.reliability.list(30);

  assertEquals(c.calls[0].url, "https://api.example.com/reliability/services?days=30");
  assertEquals(c.calls[0].url.includes("limit"), false);
});

Deno.test("console.reliability.list with no arguments sends no query string", async () => {
  const c = client(() => json(BOARD));

  await c.client.console.reliability.list();

  assertEquals(c.calls[0].url, "https://api.example.com/reliability/services");
});

Deno.test("console.reliability.list sends the bearer like any other request", async () => {
  const c = client(() => json(BOARD));

  await c.client.console.reliability.list();

  assertEquals(c.calls[0].method, "GET");
  assertEquals(c.calls[0].headers.get("authorization"), "Bearer tok_1");
});
