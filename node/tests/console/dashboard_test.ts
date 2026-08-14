/**
 * `client.console.dashboard.*`, against an injected fake `fetch`.
 *
 * No case here needs a live server (`docs/implementation.md` §9). Beyond the
 * per-operation assertions, this suite pins the two things that matter most:
 * the server's `GET /dashboard/stats` response has **no envelope key**, so
 * `stats` must return the body verbatim rather than calling `unwrap()`; and
 * it is AUTHENTICATED, so — unlike `console.auth.login`/`signup`/
 * `checkAccountSlug` — it must send the bearer like any other request
 * (`RequestOptions.requireAuth` defaults `true`).
 */

import { assertEquals } from "@std/assert";
import { W6WClient } from "../../src/client.ts";
import type { FetchLike } from "../../src/config.ts";
import type { DashboardStats } from "../../src/console/dashboard.ts";

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

/** A realistic rollup, top-level, no wrapper key. */
const STATS: DashboardStats = {
  range: { from: "2026-08-02T00:00:00.000Z", to: "2026-08-09T00:00:00.000Z", bucket: "day" },
  headline: { workflowRuns: 12, succeeded: 10, failed: 2 },
  series: [
    { bucket: "2026-08-02", kind: "workflow", ok: true, count: 5 },
    { bucket: "2026-08-03", kind: "workflow", ok: false, count: 1 },
  ],
  recent: [
    {
      id: "run_1",
      kind: "workflow",
      ok: true,
      summary: "ok",
      occurredAt: "2026-08-09T01:00:00.000Z",
      workflowId: "wf_1",
    },
    {
      id: "run_2",
      kind: "workflow",
      ok: null,
      summary: null,
      occurredAt: "2026-08-09T00:30:00.000Z",
      workflowId: null,
    },
  ],
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

Deno.test("console.dashboard: stats is a function on a constructed client", () => {
  // Runtime, not type-level: a namespace that silently lost the method would
  // still typecheck everywhere else in this suite.
  const c = new W6WClient({ baseUrl: "https://api.example.com", token: "t" });
  assertEquals(typeof c.console.dashboard.stats, "function");
});

Deno.test("console.dashboard.stats resolves with the payload VERBATIM — no unwrap()", async () => {
  const c = client(() => json(STATS));

  const res = await c.client.console.dashboard.stats();

  // Deep-equals the mocked payload exactly: a tree that wrongly called
  // unwrap(res, "…") would reject instead of resolving here, since the mocked
  // body carries no such key — this assertion is on promise RESOLUTION as
  // much as on shape.
  assertEquals(res, STATS);
  assertEquals(c.calls.length, 1);
  assertEquals(c.calls[0].method, "GET");
});

Deno.test("console.dashboard.stats forwards from/to/bucket as query params", async () => {
  const c = client(() => json(STATS));

  await c.client.console.dashboard.stats({
    from: "2026-08-01T00:00:00.000Z",
    to: "2026-08-09T00:00:00.000Z",
    bucket: "week",
  });

  assertEquals(
    c.calls[0].url,
    "https://api.example.com/dashboard/stats" +
      "?from=2026-08-01T00%3A00%3A00.000Z&to=2026-08-09T00%3A00%3A00.000Z&bucket=week",
  );
});

Deno.test("console.dashboard.stats with no params sends no query string", async () => {
  const c = client(() => json(STATS));

  await c.client.console.dashboard.stats();

  assertEquals(c.calls[0].url, "https://api.example.com/dashboard/stats");
});

Deno.test(
  "console.dashboard.stats DOES send the bearer — it is authenticated, unlike console.auth's public trio",
  async () => {
    const c = client(() => json(STATS));

    await c.client.console.dashboard.stats();

    assertEquals(c.calls[0].headers.get("authorization"), "Bearer tok_1");
  },
);
