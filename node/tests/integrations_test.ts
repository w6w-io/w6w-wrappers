/**
 * The integration/dashboard operations promoted from the console namespace to the
 * root client — `connections.get/delete`, `apps.byIds`, `dashboard.stats`,
 * `projects.list`, `reliability.list/members` — against an injected fake `fetch`.
 *
 * Every request is pinned against a LITERAL URL/method, never one rebuilt from
 * the code under test.
 */

import { assertEquals, assertRejects } from "@std/assert";
import { W6WClient } from "../src/client.ts";
import type { FetchLike } from "../src/config.ts";
import { ApiError } from "../src/errors.ts";

interface Call {
  url: string;
  method: string | undefined;
  signal: AbortSignal | null | undefined;
  body: string | null;
}

function client(respond: (call: Call) => Response): { client: W6WClient; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: FetchLike = (input, init) => {
    calls.push({
      url: input,
      method: init?.method,
      signal: init?.signal,
      body: typeof init?.body === "string" ? init.body : null,
    });
    return Promise.resolve(respond(calls[calls.length - 1]));
  };
  return {
    client: new W6WClient({
      baseUrl: "https://api.example.com",
      token: "tok_1",
      project: "prj_default",
      fetch,
    }),
    calls,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const CONN = { id: "conn_1", appId: "sendgrid", displayName: "Mail" };

Deno.test("connections.get: GET /connections/:id, unwraps `connection`, no project", async () => {
  const c = client(() => json({ connection: CONN }));
  const got = await c.client.connections.get("conn_1");
  assertEquals([got.id, got.appId, got.displayName], ["conn_1", "sendgrid", "Mail"]);
  assertEquals(c.calls.length, 1);
  assertEquals(c.calls[0].url, "https://api.example.com/connections/conn_1");
  assertEquals(c.calls[0].method, "GET");
});

Deno.test("connections.get: the id is path-encoded and signal reaches fetch", async () => {
  const c = client(() => json({ connection: CONN }));
  const ac = new AbortController();
  await c.client.connections.get("a/b c", { signal: ac.signal });
  assertEquals(c.calls[0].url, "https://api.example.com/connections/a%2Fb%20c");
  assertEquals(c.calls[0].signal, ac.signal);
});

Deno.test("connections.get: a 404 surfaces as ApiError intact", async () => {
  const c = client(() =>
    json({ error: { code: "unknown_connection", message: "Connection not found." } }, 404)
  );
  const err = await assertRejects(() => c.client.connections.get("zerocred:x"), ApiError);
  assertEquals(err.status, 404);
  assertEquals(err.code, "unknown_connection");
});

Deno.test("connections.delete: DELETE /connections/:id, resolves to undefined", async () => {
  const c = client(() => json({ ok: true }));
  assertEquals(await c.client.connections.delete("conn_1"), undefined);
  assertEquals(c.calls[0].url, "https://api.example.com/connections/conn_1");
  assertEquals(c.calls[0].method, "DELETE");
  assertEquals(c.calls[0].body, null);
});

Deno.test("connections.delete: another account's / built-in id is a 404 ApiError", async () => {
  const c = client(() =>
    json({ error: { code: "unknown_connection", message: "Connection not found." } }, 404)
  );
  const err = await assertRejects(() => c.client.connections.delete("conn_other"), ApiError);
  assertEquals(err.status, 404);
});

Deno.test("connections.list: a builtIn row is typed and passed through", async () => {
  const c = client(() => json({ connections: [{ ...CONN, id: "zerocred:x", builtIn: true }] }));
  const rows = await c.client.connections.list();
  assertEquals(rows[0].builtIn, true);
});

function app(id: string) {
  return { id, displayName: id };
}

Deno.test("apps.byIds: [] resolves to [] with ZERO requests", async () => {
  const c = client(() => json({ apps: [] }));
  assertEquals(await c.client.apps.byIds([]), []);
  assertEquals(c.calls.length, 0);
});

Deno.test("apps.byIds: one request, ids CSV, apps returned", async () => {
  const c = client(() => json({ apps: [app("a"), app("b")] }));
  const out = await c.client.apps.byIds(["a", "b"]);
  assertEquals(out.map((a) => a.id), ["a", "b"]);
  assertEquals(c.calls.length, 1);
  assertEquals(c.calls[0].url, "https://api.example.com/apps?ids=a%2Cb");
  assertEquals(c.calls[0].method, "GET");
});

Deno.test("apps.byIds: 150 ids -> 2 requests of <=100, union in chunk order", async () => {
  const ids = Array.from({ length: 150 }, (_, i) => `app${i}`);
  const c = client((call) => {
    const csv = decodeURIComponent(new URL(call.url).searchParams.get("ids") ?? "");
    return json({ apps: csv.split(",").map(app) });
  });
  const out = await c.client.apps.byIds(ids);
  assertEquals(c.calls.length, 2);
  const sizes = c.calls.map((x) =>
    (new URL(x.url).searchParams.get("ids") ?? "").split(",").length
  );
  assertEquals(sizes, [100, 50]);
  assertEquals(out.map((a) => a.id), ids);
});

Deno.test("apps.byIds: exactly 100 ids is ONE request", async () => {
  const ids = Array.from({ length: 100 }, (_, i) => `app${i}`);
  const c = client(() => json({ apps: [] }));
  await c.client.apps.byIds(ids);
  assertEquals(c.calls.length, 1);
});

Deno.test("apps.byIds: duplicates are collapsed before chunking", async () => {
  const c = client(() => json({ apps: [] }));
  await c.client.apps.byIds(["a", "b", "a", "b", "a"]);
  assertEquals(c.calls.length, 1);
  assertEquals(c.calls[0].url, "https://api.example.com/apps?ids=a%2Cb");
});

Deno.test("apps.byIds: signal reaches fetch on every chunk; a 400 is an ApiError", async () => {
  const ac = new AbortController();
  const c = client(() => json({ apps: [] }));
  await c.client.apps.byIds(Array.from({ length: 101 }, (_, i) => `x${i}`), { signal: ac.signal });
  assertEquals(c.calls.map((x) => x.signal), [ac.signal, ac.signal]);

  const bad = client(() => json({ error: { code: "too_many_ids", message: "no" } }, 400));
  const err = await assertRejects(() => bad.client.apps.byIds(["a"]), ApiError);
  assertEquals(err.code, "too_many_ids");
});

Deno.test("dashboard.stats: GET /dashboard/stats, no params -> no query, body returned as is", async () => {
  const stats = {
    range: { from: "a", to: "b", bucket: "day" as const },
    headline: { workflowRuns: 1, succeeded: 1, failed: 0 },
    series: [],
    recent: [],
  };
  const c = client(() => json(stats));
  assertEquals(await c.client.dashboard.stats(), stats);
  assertEquals(c.calls[0].url, "https://api.example.com/dashboard/stats");
  assertEquals(c.calls[0].method, "GET");
});

Deno.test("dashboard.stats: from/to/bucket forwarded; the default project is NOT", async () => {
  const c = client(() => json({}));
  const ac = new AbortController();
  await c.client.dashboard.stats({
    from: "2026-01-01",
    to: "2026-02-01",
    bucket: "week",
    signal: ac.signal,
  });
  assertEquals(
    c.calls[0].url,
    "https://api.example.com/dashboard/stats?from=2026-01-01&to=2026-02-01&bucket=week",
  );
  assertEquals(c.calls[0].signal, ac.signal);
});

Deno.test("projects.list: GET /projects, unwraps the array (not the envelope)", async () => {
  const p = { id: "prj_1", isDefault: true, name: "Default" };
  const c = client(() => json({ projects: [p] }));
  assertEquals(await c.client.projects.list(), [p]);
  assertEquals(c.calls[0].url, "https://api.example.com/projects");
  assertEquals(c.calls[0].method, "GET");
});

Deno.test("reliability.list: project + apps CSV on the wire, days/limit only when given", async () => {
  const c = client(() => json({ services: [] }));
  await c.client.reliability.list("prj_1", ["a", "b"]);
  assertEquals(
    c.calls[0].url,
    "https://api.example.com/reliability/services?project=prj_1&apps=a%2Cb",
  );
  await c.client.reliability.list("prj_1", ["a"], { days: 7, limit: 3 });
  assertEquals(
    c.calls[1].url,
    "https://api.example.com/reliability/services?project=prj_1&apps=a&days=7&limit=3",
  );
});

Deno.test("reliability.list: more than ten ids are sent as-is and the server's 400 survives", async () => {
  const ids = Array.from({ length: 11 }, (_, i) => `a${i}`);
  const c = client(() => json({ error: { code: "invalid_app_filter", message: "max 10" } }, 400));
  const err = await assertRejects(() => c.client.reliability.list("prj_1", ids), ApiError);
  assertEquals(err.status, 400);
  assertEquals(err.code, "invalid_app_filter");
  assertEquals(c.calls.length, 1, "no client-side batching");
});

Deno.test("reliability.members: GET /reliability/services/members", async () => {
  const body = { appIds: ["a"] };
  const c = client(() => json(body));
  assertEquals(await c.client.reliability.members("prj_1"), body);
  assertEquals(
    c.calls[0].url,
    "https://api.example.com/reliability/services/members?project=prj_1",
  );
  const ac = new AbortController();
  await c.client.reliability.members("prj_1", { days: 30, signal: ac.signal });
  assertEquals(
    c.calls[1].url,
    "https://api.example.com/reliability/services/members?project=prj_1&days=30",
  );
  assertEquals(c.calls[1].signal, ac.signal);
});

Deno.test("connections.delete: force sends ?force=true only when true", async () => {
  const c = client(() => json({ ok: true, disabled: [] }));
  assertEquals(await c.client.connections.delete("conn_1", { force: true }), undefined);
  await c.client.connections.delete("conn_1", { force: false });
  await c.client.connections.delete("conn_1", {});
  assertEquals(c.calls[0].url, "https://api.example.com/connections/conn_1?force=true");
  assertEquals(c.calls[1].url, "https://api.example.com/connections/conn_1");
  assertEquals(c.calls[2].url, "https://api.example.com/connections/conn_1");
});

Deno.test("connections.delete: 409 connection_in_use carries dependents on the ApiError", async () => {
  const dependents = { callables: [{ id: "fn_1", kind: "function", key: "k" }], subscriptions: [] };
  const c = client(() =>
    json({ error: { code: "connection_in_use", message: "in use", dependents } }, 409)
  );
  const err = await assertRejects(() => c.client.connections.delete("conn_1"), ApiError);
  assertEquals(err.status, 409);
  assertEquals(err.code, "connection_in_use");
  assertEquals(
    (err.raw as { error: { dependents: unknown } }).error.dependents,
    dependents,
  );
});

Deno.test("connections.list/get: keep-alive fields pass through; an older server's rows lack them", async () => {
  const keepAlive = {
    autoRefresh: false,
    lastRefreshedAt: "2026-11-01T10:00:00.000Z",
    refreshFailingSince: "2026-11-02T10:00:00.000Z",
  };
  const c = client(() => json({ connections: [{ ...CONN, ...keepAlive, state: "broken" }, CONN] }));
  const [current, older] = await c.client.connections.list();
  assertEquals(current.autoRefresh, false);
  assertEquals(current.lastRefreshedAt, "2026-11-01T10:00:00.000Z");
  assertEquals(current.refreshFailingSince, "2026-11-02T10:00:00.000Z");
  assertEquals(current.state, "broken");
  assertEquals(older.autoRefresh, undefined);
  assertEquals(older.lastRefreshedAt, undefined);
  assertEquals(older.refreshFailingSince, undefined);

  const g = client(() =>
    json({
      connection: { ...CONN, autoRefresh: true, lastRefreshedAt: null, refreshFailingSince: null },
    })
  );
  const one = await g.client.connections.get("conn_1");
  assertEquals(one.autoRefresh, true);
  assertEquals(one.lastRefreshedAt, null);
  assertEquals(one.refreshFailingSince, null);
});
