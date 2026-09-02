/**
 * `client.connections.list()` and `client.workflows.list()`, against an
 * injected fake `fetch`.
 *
 * The two discovery operations share a file because they share a job: they are
 * how a caller finds a `conn_…` / `wf_…` id to pass to `run` (D4). Each case
 * asserts the request the wrapper *made* — method, full resolved URL including
 * any `?project=`, bearer — **and** the value it returned, which is always the
 * unwrapped array and never the server's envelope.
 *
 * No case here needs a live server (`docs/implementation.md` §9), even though
 * both routes are served today.
 */

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { W6WClient } from "../src/client.ts";
import type { FetchLike } from "../src/config.ts";
import { ApiError } from "../src/errors.ts";
import type { ConnectionSummary, WorkflowSummary } from "../src/types.ts";

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

function json(body: unknown, status = 200, statusText?: string): Response {
  return new Response(JSON.stringify(body), {
    status,
    statusText,
    headers: { "content-type": "application/json" },
  });
}

/** A client wired to a fake transport. `project` seeds the client-level default. */
function client(
  respond: (call: Call) => Response,
  project?: string,
): { client: W6WClient; calls: Call[] } {
  const fake = fakeFetch(respond);
  return {
    client: new W6WClient({
      baseUrl: "https://api.example.com",
      token: "tok_1",
      project,
      fetch: fake.fetch,
    }),
    calls: fake.calls,
  };
}

/**
 * A connection exactly as the list route projects it. Typed as
 * `ConnectionSummary` on purpose: the stored record's secret and its
 * last-refresh timestamp are redacted server-side, so if the type ever grew
 * either field this literal would stop compiling for want of it.
 */
const CONNECTION: ConnectionSummary = {
  id: "conn_01HQ",
  appId: "sendgrid",
  authKey: "api_key",
  owner: "user_01HQ",
  displayName: "Marketing SendGrid",
  state: "connected",
  profile: {},
  lastTestOk: true,
  lastTestedAt: "2026-07-20T09:14:00.000Z",
  createdAt: "2026-07-01T12:00:00.000Z",
  updatedAt: "2026-07-20T09:14:00.000Z",
};

const WORKFLOW: WorkflowSummary = {
  id: "wf_01HQ",
  key: null,
  name: "welcome-email",
  displayName: "Welcome Email",
  description: "Sends a welcome email on signup.",
  status: "active",
  tags: ["onboarding"],
  runCount: 412,
  updatedAt: "2026-07-22T18:03:00.000Z",
};

Deno.test("discovery: both list operations are functions on a constructed client", () => {
  // A runtime assertion, not a type-level one: a namespace that silently lost
  // its only method would still typecheck in every other case in this file,
  // because they all call through the same object.
  const c = new W6WClient({ baseUrl: "https://api.example.com", token: "t" });
  assertEquals(typeof c.connections.list, "function", "connections.list is missing");
  assertEquals(typeof c.workflows.list, "function", "workflows.list is missing");
  assertEquals(typeof c.me, "function", "me is missing");
});

Deno.test("connections.list unwraps the envelope and returns the array", async () => {
  const c = client(() => json({ connections: [CONNECTION] }));

  const connections = await c.client.connections.list();

  // The array itself, not {connections: […]} — the caller never sees the wrapper.
  assertEquals(connections, [CONNECTION]);
  assertEquals(c.calls.length, 1);
  assertEquals(c.calls[0].method, "GET");
  assertEquals(c.calls[0].url, "https://api.example.com/connections");
  assertEquals(c.calls[0].headers.get("authorization"), "Bearer tok_1");
});

Deno.test("connections.list returns an empty array, and carries no query string", async () => {
  // An empty result is DATA, not an error and not a null: a caller iterating it
  // must not have to branch. Built with a client-level default project on
  // purpose — connections are scoped by the credential, not by project, so
  // forwarding that default would send an argument the server ignores.
  const c = client(() => json({ connections: [] }), "prj_default");

  const connections = await c.client.connections.list();

  assertEquals(connections, []);
  assertEquals(c.calls[0].url, "https://api.example.com/connections");
});

Deno.test("workflows.list unwraps the envelope, and is empty-safe", async () => {
  const c = client(() => json({ workflows: [WORKFLOW] }));

  const workflows = await c.client.workflows.list();

  assertEquals(workflows, [WORKFLOW]);
  assertEquals(c.calls[0].method, "GET");
  assertEquals(c.calls[0].url, "https://api.example.com/workflows");

  const empty = client(() => json({ workflows: [] }));
  assertEquals(await empty.client.workflows.list(), []);
});

Deno.test("workflows.list sends ?project= from the client default, overridable per call", async () => {
  const c = client(() => json({ workflows: [] }), "prj_default");

  await c.client.workflows.list();
  assertEquals(c.calls[0].url, "https://api.example.com/workflows?project=prj_default");

  // Per-call wins over the client default…
  await c.client.workflows.list({ project: "prj_other" });
  assertEquals(c.calls[1].url, "https://api.example.com/workflows?project=prj_other");

  // …and with nothing configured anywhere the parameter is omitted entirely.
  // An empty `?project=` would be a different, and wrong, request.
  const unscoped = client(() => json({ workflows: [] }));
  await unscoped.client.workflows.list();
  assertEquals(unscoped.calls[0].url, "https://api.example.com/workflows");
});

Deno.test("discovery: an error envelope reaches the caller as an ApiError", async () => {
  const conns = client(() =>
    json({ error: { code: "unauthorized", message: "Invalid token." } }, 401, "Unauthorized")
  );
  const connErr = await assertRejects(() => conns.client.connections.list(), ApiError);
  assertEquals(connErr.status, 401);
  assertEquals(connErr.code, "unauthorized");

  const flows = client(() =>
    json({ error: { code: "unknown_project", message: "No such project." } }, 400, "Bad Request")
  );
  const flowErr = await assertRejects(
    () => flows.client.workflows.list({ project: "prj_missing" }),
    ApiError,
  );
  assertEquals(flowErr.status, 400);
  assertEquals(flowErr.code, "unknown_project");
  assertEquals(flowErr.message, "No such project.");
});

Deno.test("discovery: a 200 missing its envelope key is bad_response, not undefined", async () => {
  // A server regression must fail here, loudly, rather than returning undefined
  // and surfacing as a TypeError somewhere in the caller minutes later.
  const conns = client(() => json({ unexpected: true }));
  const connErr = await assertRejects(() => conns.client.connections.list(), ApiError);
  assertEquals(connErr.code, "bad_response");
  assertEquals(connErr.status, 200);
  assertStringIncludes(connErr.message, '"connections"');

  const flows = client(() => json({ unexpected: true }));
  const flowErr = await assertRejects(() => flows.client.workflows.list(), ApiError);
  assertEquals(flowErr.code, "bad_response");
  assertStringIncludes(flowErr.message, '"workflows"');
});
