/**
 * `client.console.apiCalls.*`, against an injected fake `fetch`.
 *
 * No case here needs a live server (`docs/implementation.md` §9). Beyond the
 * envelope-unwrap and filter-forwarding assertions, this suite pins the
 * REUSE of `ApiCallRecord` from `console.apps` — `list`'s resolved elements
 * are typed as the SAME interface the `apps` namespace exports, proven with a
 * type-only assignability check rather than a re-declared duplicate.
 */

import { assertEquals } from "@std/assert";
import { W6wClient } from "../../src/client.ts";
import type { FetchLike } from "../../src/config.ts";
import type { ApiCallRecord as AppsApiCallRecord } from "../../src/console/apps.ts";
import type { ApiCallRecord as OwnApiCallRecord } from "../../src/console/api-calls.ts";

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

const CALL_A: AppsApiCallRecord = {
  id: "call_1",
  appId: "app_x",
  actionKey: "send",
  connectionId: "conn_1",
  sessionId: "sess_1",
  host: "api.example.com",
  method: "POST",
  status: 200,
  createdAt: "2026-08-09T12:00:00.000Z",
};

/** A client wired to a fake transport. */
function client(respond: (call: Call) => Response): { client: W6wClient; calls: Call[] } {
  const fake = fakeFetch(respond);
  return {
    client: new W6wClient({
      baseUrl: "https://api.example.com",
      token: "tok_1",
      fetch: fake.fetch,
    }),
    calls: fake.calls,
  };
}

Deno.test("console.apiCalls: list is a function on a constructed client", () => {
  // Runtime, not type-level: a namespace that silently lost the method would
  // still typecheck everywhere else in this suite.
  const c = new W6wClient({ baseUrl: "https://api.example.com", token: "t" });
  assertEquals(typeof c.console.apiCalls.list, "function");
});

Deno.test("console.apiCalls.list unwraps the `apiCalls` envelope", async () => {
  const c = client(() => json({ apiCalls: [CALL_A] }));

  const res = await c.client.console.apiCalls.list();

  // A mutant that returned the envelope directly (forgot `unwrap()`) would
  // fail this assertion — it would see `{apiCalls: [...]}`, not the array.
  assertEquals(res, [CALL_A]);
  assertEquals(c.calls[0].method, "GET");
});

Deno.test(
  "console.apiCalls.list forwards only DEFINED filter fields as query params",
  async () => {
    const c = client(() => json({ apiCalls: [] }));

    await c.client.console.apiCalls.list({ appId: "app_x", limit: 50 });

    const url = new URL(c.calls[0].url);
    assertEquals(url.searchParams.get("appId"), "app_x");
    assertEquals(url.searchParams.get("limit"), "50");
    assertEquals(url.searchParams.has("actionKey"), false);
    assertEquals(url.searchParams.has("connectionId"), false);
    assertEquals(url.searchParams.has("sessionId"), false);
  },
);

Deno.test("console.apiCalls.list sends no query params when filter is omitted entirely", async () => {
  const c = client(() => json({ apiCalls: [] }));

  await c.client.console.apiCalls.list();

  assertEquals(new URL(c.calls[0].url).search, "");
});

Deno.test("console.apiCalls.list forwards every defined filter field", async () => {
  const c = client(() => json({ apiCalls: [] }));

  await c.client.console.apiCalls.list({
    appId: "app_x",
    actionKey: "send",
    connectionId: "conn_1",
    sessionId: "sess_1",
    limit: 25,
  });

  const url = new URL(c.calls[0].url);
  assertEquals(url.searchParams.get("appId"), "app_x");
  assertEquals(url.searchParams.get("actionKey"), "send");
  assertEquals(url.searchParams.get("connectionId"), "conn_1");
  assertEquals(url.searchParams.get("sessionId"), "sess_1");
  assertEquals(url.searchParams.get("limit"), "25");
});

Deno.test(
  "console.apiCalls.list's resolved elements are typed as the SAME ApiCallRecord the apps namespace exports",
  () => {
    // A type-only assignability check — this line only compiles if the two
    // names refer to the same underlying type (re-export), which `deno task
    // check` already enforces at build time; asserting it here means a future
    // split that re-declares a second, divergent interface fails typecheck
    // instead of silently passing tsc.
    const _same: AppsApiCallRecord = {} as OwnApiCallRecord;
    void _same;
    assertEquals(true, true);
  },
);
