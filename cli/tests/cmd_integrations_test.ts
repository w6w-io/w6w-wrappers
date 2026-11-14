/**
 * `connections get|delete`, `apps by-ids`, `dashboard stats`, `projects list`
 * and `reliability list|members`, driven through the dispatcher against a stub
 * fetch. Wire requests are pinned as literals; a void op prints `null` under
 * `--json`; a 4xx exits 2 with the server's message on stderr.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import type { FetchLike } from "@w6w/sdk";
import { main } from "../mod.ts";
import type { EnvReader } from "../mod.ts";
import { COMMANDS } from "../src/commands/index.ts";

const BASE = "https://api.example.test";
const ENV: EnvReader = (name) => ({ W6W_BASE_URL: BASE, W6W_TOKEN: "t_cli" })[name];

interface Recorded {
  url: string;
  method: string;
  body: unknown;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function w6w(argv: string[], reply: (call: Recorded) => Response = () => json(200, {})) {
  const calls: Recorded[] = [];
  const stdout: string[] = [];
  const stderr: string[] = [];
  const fetch: FetchLike = (url, init) => {
    const call: Recorded = {
      url,
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    return Promise.resolve(reply(call));
  };
  const code = await main(argv, {
    stdout: (text) => stdout.push(text),
    stderr: (text) => stderr.push(text),
  }, { env: ENV, fetch, commands: COMMANDS });
  return { code, stdout: stdout.join("\n"), stderr: stderr.join("\n"), calls };
}

Deno.test("connections get: GET /connections/<id>, unwrapped under --json", async () => {
  const conn = { id: "conn_1", appId: "sendgrid", displayName: "Mail", state: "connected" };
  const r = await w6w(["connections", "get", "conn_1", "--json"], (call) => {
    assertEquals(call.method, "GET");
    assertEquals(call.url, `${BASE}/connections/conn_1`);
    return json(200, { connection: conn });
  });
  assertEquals(r.code, 0, r.stderr);
  assertEquals(JSON.parse(r.stdout), conn);
});

Deno.test("connections get: keep-alive fields reach --json and the human view", async () => {
  const conn = {
    id: "conn_1",
    appId: "sendgrid",
    displayName: "Mail",
    state: "broken",
    autoRefresh: true,
    lastRefreshedAt: "2026-11-01T10:00:00.000Z",
    refreshFailingSince: "2026-11-02T10:00:00.000Z",
  };
  const asJson = await w6w(
    ["connections", "get", "conn_1", "--json"],
    () => json(200, { connection: conn }),
  );
  assertEquals(asJson.code, 0, asJson.stderr);
  assertEquals(JSON.parse(asJson.stdout), conn);
  const human = await w6w(["connections", "get", "conn_1"], () => json(200, { connection: conn }));
  assertEquals(human.code, 0, human.stderr);
  assertStringIncludes(human.stdout, '"refreshFailingSince": "2026-11-02T10:00:00.000Z"');
  assertStringIncludes(human.stdout, '"autoRefresh": true');
});

Deno.test("connections delete: DELETE /connections/<id>; --json is null", async () => {
  const r = await w6w(["connections", "delete", "conn_1", "--json"], (call) => {
    assertEquals(call.method, "DELETE");
    assertEquals(call.url, `${BASE}/connections/conn_1`);
    return json(200, { ok: true });
  });
  assertEquals(r.code, 0, r.stderr);
  assertEquals(JSON.parse(r.stdout), null);
});

Deno.test("connections delete --force: DELETE /connections/<id>?force=true", async () => {
  const r = await w6w(["connections", "delete", "conn_1", "--force", "--json"], (call) => {
    assertEquals(call.method, "DELETE");
    assertEquals(call.url, `${BASE}/connections/conn_1?force=true`);
    return json(200, { ok: true, disabled: [] });
  });
  assertEquals(r.code, 0, r.stderr);
  assertEquals(JSON.parse(r.stdout), null);
});

Deno.test("connections delete: a 409 connection_in_use lists dependents on stderr and exits 2", async () => {
  const r = await w6w(["connections", "delete", "conn_1"], () =>
    json(409, {
      error: {
        code: "connection_in_use",
        message: "connection is in use",
        dependents: {
          callables: [
            { id: "fn_1", kind: "function", key: "send", displayName: "Send mail", enabled: true },
            { id: "ep_2", kind: "endpoint", key: "hook", displayName: "Hook", enabled: true },
          ],
          subscriptions: [],
        },
      },
    }));
  assertEquals(r.code, 2, r.stdout);
  assertStringIncludes(r.stderr, "function Send mail (fn_1)");
  assertStringIncludes(r.stderr, "endpoint Hook (ep_2)");
  assertStringIncludes(r.stderr, "--force");
  assertEquals(r.stdout, "");
});

Deno.test("connections delete: a 404 exits 2 with the server message", async () => {
  const r = await w6w(
    ["connections", "delete", "conn_x"],
    () => json(404, { error: { code: "not_found", message: "no such connection" } }),
  );
  assertEquals(r.code, 2, r.stdout);
  assertStringIncludes(r.stderr, "no such connection");
});

Deno.test("connections get: a 404 exits 2", async () => {
  const r = await w6w(
    ["connections", "get", "conn_x"],
    () => json(404, { error: { code: "not_found", message: "no such connection" } }),
  );
  assertEquals(r.code, 2, r.stdout);
  assertStringIncludes(r.stderr, "no such connection");
});

Deno.test("apps by-ids: GET /apps?ids=a,b with the ids joined", async () => {
  const apps = [{ id: "sendgrid", displayName: "SendGrid", version: "1.0.0" }];
  const r = await w6w(["apps", "by-ids", "sendgrid,slack", "--json"], (call) => {
    assertEquals(call.method, "GET");
    assertEquals(call.url, `${BASE}/apps?ids=sendgrid%2Cslack`);
    return json(200, { apps });
  });
  assertEquals(r.code, 0, r.stderr);
  assertEquals(JSON.parse(r.stdout), apps);
});

Deno.test("apps by-ids: a 400 exits 2 with the server message", async () => {
  const r = await w6w(
    ["apps", "by-ids", "x"],
    () => json(400, { error: { code: "bad_request", message: "too many ids" } }),
  );
  assertEquals(r.code, 2);
  assertStringIncludes(r.stderr, "too many ids");
});

Deno.test("dashboard stats: GET /dashboard/stats, query sent only when given", async () => {
  const stats = {
    range: { from: "a", to: "b", bucket: "week" },
    headline: { workflowRuns: 3, succeeded: 2, failed: 1 },
    series: [],
    recent: [],
  };
  const plain = await w6w(["dashboard", "stats", "--json"], (call) => {
    assertEquals(call.url, `${BASE}/dashboard/stats`);
    return json(200, stats);
  });
  assertEquals(plain.code, 0, plain.stderr);
  assertEquals(JSON.parse(plain.stdout), stats);

  const full = await w6w(
    [
      "dashboard",
      "stats",
      "--from",
      "2026-10-01T00:00:00Z",
      "--to",
      "2026-10-08T00:00:00Z",
      "--bucket",
      "week",
    ],
    (call) => {
      const url = new URL(call.url);
      assertEquals(url.pathname, "/dashboard/stats");
      assertEquals(url.searchParams.get("from"), "2026-10-01T00:00:00Z");
      assertEquals(url.searchParams.get("to"), "2026-10-08T00:00:00Z");
      assertEquals(url.searchParams.get("bucket"), "week");
      return json(200, stats);
    },
  );
  assertEquals(full.code, 0, full.stderr);
  assertStringIncludes(full.stdout, "failed: 1");
});

Deno.test("projects list: GET /projects, envelope unwrapped", async () => {
  const projects = [{ id: "prj_1", name: "Default", isDefault: true, status: "active" }];
  const r = await w6w(["projects", "list", "--json"], (call) => {
    assertEquals(call.method, "GET");
    assertEquals(call.url, `${BASE}/projects`);
    return json(200, { projects });
  });
  assertEquals(r.code, 0, r.stderr);
  assertEquals(JSON.parse(r.stdout), projects);
});

const WINDOW = { from: "a", to: "b", days: 7 };

Deno.test("reliability list: GET /reliability/services with project, apps, days, limit", async () => {
  const body = { account: "acct", window: WINDOW, services: [] };
  const r = await w6w(
    [
      "reliability",
      "list",
      "--project",
      "prj_1",
      "--apps",
      "sendgrid,slack",
      "--days",
      "7",
      "--limit",
      "5",
      "--json",
    ],
    (call) => {
      const url = new URL(call.url);
      assertEquals(url.pathname, "/reliability/services");
      assertEquals(url.searchParams.get("project"), "prj_1");
      assertEquals(url.searchParams.get("apps"), "sendgrid,slack");
      assertEquals(url.searchParams.get("days"), "7");
      assertEquals(url.searchParams.get("limit"), "5");
      return json(200, body);
    },
  );
  assertEquals(r.code, 0, r.stderr);
  assertEquals(JSON.parse(r.stdout), body);
});

Deno.test("reliability list: missing --apps or a bad --days is a usage error, no request", async () => {
  const noApps = await w6w(["reliability", "list", "--project", "prj_1"]);
  assertEquals(noApps.code, 1, noApps.stderr);
  const badDays = await w6w([
    "reliability",
    "list",
    "--project",
    "p",
    "--apps",
    "a",
    "--days",
    "x",
  ]);
  assertEquals(badDays.code, 1, badDays.stderr);
  assertEquals(noApps.calls.length + badDays.calls.length, 0);
});

Deno.test("reliability list: the server's >10 apps error reaches stderr, exit 2", async () => {
  const r = await w6w(
    ["reliability", "list", "--project", "p", "--apps", "a,b"],
    () => json(400, { error: { code: "too_many_apps", message: "at most 10 apps" } }),
  );
  assertEquals(r.code, 2);
  assertStringIncludes(r.stderr, "at most 10 apps");
});

Deno.test("reliability members: GET /reliability/services/members", async () => {
  const body = { account: "acct", window: WINDOW, appIds: ["sendgrid"] };
  const r = await w6w(["reliability", "members", "--project", "prj_1", "--json"], (call) => {
    const url = new URL(call.url);
    assertEquals(url.pathname, "/reliability/services/members");
    assertEquals(url.searchParams.get("project"), "prj_1");
    assertEquals(url.searchParams.has("days"), false);
    return json(200, body);
  });
  assertEquals(r.code, 0, r.stderr);
  assertEquals(JSON.parse(r.stdout), body);
});
