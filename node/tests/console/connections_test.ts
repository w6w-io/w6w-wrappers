/**
 * `client.console.connections.*`, against an injected fake `fetch`.
 *
 * No case here needs a live server (`docs/implementation.md` §9). Beyond the
 * per-operation envelope assertions (`listForApp`/`get`/`create`/`update` all
 * unwrap; `test` never does — the OPPOSITE failure mode), the case that
 * matters most is `test`'s failed-test-is-data rule: a `200` body with
 * `ok: false` must RESOLVE, not reject — the exact same rule `client.run()`/
 * `workflows.run()` already document for a failed run — while a genuine
 * non-2xx must still reject. Two mutation-discriminating pairs pin that:
 * "resolves, does not throw" on `ok: false`/`untested: true`, and "still
 * throws" on a real `404`.
 */

import { assertEquals, assertRejects } from "@std/assert";
import { W6WClient } from "../../src/client.ts";
import type { FetchLike } from "../../src/config.ts";
import { ApiError } from "../../src/errors.ts";
import type { ConnectionTestResult } from "../../src/console/connections.ts";
import type { ConnectionSummary } from "../../src/types.ts";

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

const CONN_A: ConnectionSummary = {
  id: "conn_1",
  appId: "sendgrid",
  authKey: "apiKey",
  tenant: "default",
  subject: "usr_1",
  displayName: "Prod",
  state: "connected",
  profile: {},
  lastTestOk: true,
  lastTestedAt: "2026-08-09T00:00:00.000Z",
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-09T00:00:00.000Z",
  credentialId: "cred_1",
};

const CONN_B: ConnectionSummary = {
  id: "conn_2",
  appId: "sendgrid",
  authKey: "apiKey",
  tenant: "default",
  subject: "usr_1",
  displayName: "Staging",
  state: "pending",
  profile: {},
  lastTestOk: null,
  lastTestedAt: null,
  createdAt: "2026-08-02T00:00:00.000Z",
  updatedAt: "2026-08-02T00:00:00.000Z",
  credentialId: null,
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

Deno.test(
  "console.connections: listForApp/get/create/update/test/delete are functions on a constructed client, base connections.list untouched",
  () => {
    // Runtime, not type-level: a namespace that silently lost a method would
    // still typecheck everywhere else in this suite.
    const c = new W6WClient({ baseUrl: "https://api.example.com", token: "t" });
    assertEquals(typeof c.console.connections.listForApp, "function");
    assertEquals(typeof c.console.connections.get, "function");
    assertEquals(typeof c.console.connections.create, "function");
    assertEquals(typeof c.console.connections.update, "function");
    assertEquals(typeof c.console.connections.test, "function");
    assertEquals(typeof c.console.connections.delete, "function");
    // Regression-proofs this task didn't accidentally remove or shadow the
    // base method it deliberately leaves alone.
    assertEquals(typeof c.connections.list, "function");
  },
);

Deno.test("console.connections.listForApp unwraps the connections envelope", async () => {
  const c = client(() => json({ connections: [CONN_A, CONN_B] }));

  const res = await c.client.console.connections.listForApp("acme");

  // A mutant that forgot to call unwrap() would resolve the envelope object
  // itself, not the array it wraps.
  assertEquals(res, [CONN_A, CONN_B]);
  assertEquals(c.calls[0].method, "GET");
  assertEquals(c.calls[0].url, "https://api.example.com/apps/acme/connections");
});

Deno.test("console.connections.get unwraps the connection envelope", async () => {
  const c = client(() => json({ connection: CONN_A }));

  const res = await c.client.console.connections.get("conn_1");

  assertEquals(res, CONN_A);
  assertEquals(c.calls[0].method, "GET");
  assertEquals(c.calls[0].url, "https://api.example.com/connections/conn_1");
});

Deno.test("console.connections.get propagates a 404 as ApiError — no special-casing, unlike console.schedules.get", async () => {
  const c = client(() =>
    json({ error: { code: "unknown_connection", message: "Not found." } }, 404)
  );

  const err = await assertRejects(
    () => c.client.console.connections.get("conn_missing"),
    ApiError,
  );

  assertEquals(err.status, 404);
  assertEquals(err.code, "unknown_connection");
});

Deno.test("console.connections.create sends the body verbatim (credential included, untouched) and unwraps the envelope", async () => {
  const c = client(() => json({ connection: CONN_A }, 201));

  const res = await c.client.console.connections.create("acme", {
    authKey: "apiKey",
    credential: { key: "sk_live_abc123" },
    displayName: "Prod",
  });

  assertEquals(res, CONN_A);
  assertEquals(c.calls[0].method, "POST");
  assertEquals(c.calls[0].url, "https://api.example.com/apps/acme/connections");
  assertEquals(JSON.parse(c.calls[0].body ?? "null"), {
    authKey: "apiKey",
    credential: { key: "sk_live_abc123" },
    displayName: "Prod",
  });
});

Deno.test("console.connections.update sends the body verbatim, no extra keys injected, and unwraps the envelope", async () => {
  const c = client(() => json({ connection: CONN_A }));

  const res = await c.client.console.connections.update("conn_1", {
    credential: { key: "sk_new" },
  });

  assertEquals(res, CONN_A);
  assertEquals(c.calls[0].method, "PATCH");
  assertEquals(c.calls[0].url, "https://api.example.com/connections/conn_1");
  // Exact body — no extra keys, no `displayName: undefined` serialized.
  assertEquals(JSON.parse(c.calls[0].body ?? "null"), { credential: { key: "sk_new" } });
});

Deno.test("console.connections.test does NOT unwrap — the whole body IS the result", async () => {
  const c = client(() => json({ ok: true, actionKey: "get-greeting" }));

  const res = await c.client.console.connections.test("conn_1");

  // A mutant that wrapped this result in unwrap(res, "connection") would
  // reject instead of resolving here, since there is no such key.
  assertEquals(res, { ok: true, actionKey: "get-greeting" });
  assertEquals(c.calls[0].method, "POST");
  assertEquals(c.calls[0].url, "https://api.example.com/connections/conn_1/test");
});

Deno.test("console.connections.test resolves (does not throw) on a 200 ok:false failed-test body — a failed test is data", async () => {
  const c = client(() =>
    json({ ok: false, actionKey: "send", error: { message: "Invalid credential." } }, 200)
  );

  const res: ConnectionTestResult = await c.client.console.connections.test("conn_1");

  assertEquals(res.ok, false);
  assertEquals(res.error?.message, "Invalid credential.");
});

Deno.test("console.connections.test resolves (does not throw) on the untested:true shape", async () => {
  const c = client(() =>
    json({ ok: true, untested: true, message: "No safe probe action exists." }, 200)
  );

  const res: ConnectionTestResult = await c.client.console.connections.test("conn_1");

  assertEquals(res.ok, true);
  assertEquals(res.untested, true);
  assertEquals(res.message, "No safe probe action exists.");
});

Deno.test("console.connections.test still throws on a genuine non-2xx — real errors are not swallowed into a resolved result", async () => {
  const c = client(() =>
    json({ error: { code: "unknown_connection", message: "Not found." } }, 404)
  );

  const err = await assertRejects(
    () => c.client.console.connections.test("conn_missing"),
    ApiError,
  );

  assertEquals(err.status, 404);
  assertEquals(err.code, "unknown_connection");
});

Deno.test("console.connections.delete sends DELETE to the right path and resolves void, discarding {ok:true}", async () => {
  const c = client(() => json({ ok: true }));

  const res = await c.client.console.connections.delete("conn_1");

  assertEquals(res, undefined);
  assertEquals(c.calls[0].method, "DELETE");
  assertEquals(c.calls[0].url, "https://api.example.com/connections/conn_1");
  assertEquals(c.calls[0].body, null);
});

Deno.test("console.connections.delete does not swallow a 404", async () => {
  const c = client(() =>
    json({ error: { code: "unknown_connection", message: "Not found." } }, 404)
  );

  const err = await assertRejects(
    () => c.client.console.connections.delete("conn_missing"),
    ApiError,
  );

  assertEquals(err.status, 404);
  assertEquals(err.code, "unknown_connection");
});

Deno.test("console.connections.listForApp percent-encodes appId via the `path` tag", async () => {
  const c = client(() => json({ connections: [] }));

  await c.client.console.connections.listForApp("app/x");

  assertEquals(c.calls[0].url, "https://api.example.com/apps/app%2Fx/connections");
});

Deno.test("console.connections.get percent-encodes id via the `path` tag", async () => {
  const c = client(() => json({ connection: CONN_A }));

  await c.client.console.connections.get("conn 1");

  assertEquals(c.calls[0].url, "https://api.example.com/connections/conn%201");
});

Deno.test("console.connections.delete percent-encodes id via the `path` tag", async () => {
  const c = client(() => json({ ok: true }));

  await c.client.console.connections.delete("conn 1");

  assertEquals(c.calls[0].url, "https://api.example.com/connections/conn%201");
});

Deno.test("console.connections.delete: force sends ?force=true only when true", async () => {
  const c = client(() => json({ ok: true, disabled: [] }));
  await c.client.console.connections.delete("conn_1", { force: true });
  await c.client.console.connections.delete("conn_1", { force: false });
  await c.client.console.connections.delete("conn_1");
  assertEquals(c.calls[0].url, "https://api.example.com/connections/conn_1?force=true");
  assertEquals(c.calls[1].url, "https://api.example.com/connections/conn_1");
  assertEquals(c.calls[2].url, "https://api.example.com/connections/conn_1");
});

Deno.test("console.connections.dependents: GET /connections/:id/dependents unwraps {dependents}", async () => {
  const dependents = {
    callables: [],
    subscriptions: [{ id: "s", appId: "a", triggerKey: "t", workflowId: "w" }],
  };
  const c = client(() => json({ dependents }));
  const res = await c.client.console.connections.dependents("conn 1");
  assertEquals(res, dependents);
  assertEquals(c.calls[0].method, "GET");
  assertEquals(c.calls[0].url, "https://api.example.com/connections/conn%201/dependents");
});

Deno.test("console.connections.create forwards an attach-by-id body verbatim", async () => {
  const c = client(() => json({ connection: CONN_A }, 201));
  const input = {
    authKey: "serviceAccount",
    credentialId: "cred_1",
    binding: { scopes: ["a.readonly"], delegatedUser: "u@example.com", settings: { n: 1 } },
    displayName: "SA",
  };

  const res = await c.client.console.connections.create("gmail", input);

  assertEquals(res, CONN_A);
  assertEquals(c.calls[0].method, "POST");
  assertEquals(c.calls[0].url, "https://api.example.com/apps/gmail/connections");
  assertEquals(c.calls[0].body, JSON.stringify(input));
});

Deno.test("console.connections.create: the legacy inline form still compiles and is verbatim", async () => {
  const c = client(() => json({ connection: CONN_A }, 201));
  const input = { authKey: "apiKey", credential: { key: "k" }, displayName: "D" };

  await c.client.console.connections.create("sendgrid", input);

  assertEquals(c.calls[0].body, JSON.stringify(input));
});

Deno.test("console.connections.create: a body carrying both forms is a compile error", () => {
  const c = new W6WClient({ baseUrl: "https://api.example.com", token: "t" });
  // Never invoked: this pins the type, `deno check` is the assertion.
  const _never = () =>
    // @ts-expect-error credential and credentialId are mutually exclusive
    c.console.connections.create("sendgrid", {
      authKey: "apiKey",
      credential: { key: "k" },
      credentialId: "cred_1",
    });
  assertEquals(typeof _never, "function");
});

Deno.test("console.connections.update forwards binding + credentialId verbatim", async () => {
  const c = client(() => json({ connection: CONN_A }));
  const patch = { binding: { delegatedUser: "u@example.com" }, credentialId: "cred_2" };

  await c.client.console.connections.update("conn_1", patch);

  assertEquals(c.calls[0].method, "PATCH");
  assertEquals(c.calls[0].url, "https://api.example.com/connections/conn_1");
  assertEquals(c.calls[0].body, JSON.stringify(patch));
});

Deno.test("console.connections.create forwards accessScope only when defined", async () => {
  const c = client(() => json({ connection: CONN_A }, 201));
  await c.client.console.connections.create("openai", {
    authKey: "apiKey",
    credentialId: "cred_1",
    accessScope: "user",
  });
  assertEquals(JSON.parse(c.calls[0].body ?? "null"), {
    authKey: "apiKey",
    credentialId: "cred_1",
    accessScope: "user",
  });
  await c.client.console.connections.create("openai", {
    authKey: "apiKey",
    credentialId: "cred_1",
    accessScope: undefined,
  });
  assertEquals(c.calls[1].body, JSON.stringify({ authKey: "apiKey", credentialId: "cred_1" }));
});

Deno.test("console.connections.create sends autoRefresh on both arms only when given", async () => {
  const c = client(() => json({ connection: { ...CONN_A, autoRefresh: false } }, 201));
  const created = await c.client.console.connections.create("sendgrid", {
    authKey: "apiKey",
    credential: { key: "k" },
    autoRefresh: false,
  });
  assertEquals(JSON.parse(c.calls[0].body ?? "null"), {
    authKey: "apiKey",
    credential: { key: "k" },
    autoRefresh: false,
  });
  assertEquals(created.autoRefresh, false);
  await c.client.console.connections.create("sendgrid", {
    authKey: "apiKey",
    credentialId: "cred_1",
    autoRefresh: true,
  });
  assertEquals(JSON.parse(c.calls[1].body ?? "null"), {
    authKey: "apiKey",
    credentialId: "cred_1",
    autoRefresh: true,
  });
  await c.client.console.connections.create("sendgrid", {
    authKey: "apiKey",
    credentialId: "cred_1",
  });
  assertEquals(c.calls[2].body, JSON.stringify({ authKey: "apiKey", credentialId: "cred_1" }));
});

Deno.test("console.connections.update sends autoRefresh alone and returns the keep-alive fields", async () => {
  const updated = {
    ...CONN_A,
    autoRefresh: false,
    lastRefreshedAt: "2026-11-01T10:00:00.000Z",
    refreshFailingSince: null,
  };
  const c = client(() => json({ connection: updated }));
  const res = await c.client.console.connections.update("conn_1", { autoRefresh: false });
  assertEquals(c.calls[0].method, "PATCH");
  assertEquals(c.calls[0].body, JSON.stringify({ autoRefresh: false }));
  assertEquals(res.autoRefresh, false);
  assertEquals(res.lastRefreshedAt, "2026-11-01T10:00:00.000Z");
  assertEquals(res.refreshFailingSince, null);
});

Deno.test("console.connections.create: a refused sign-in is a 422 with hookCode on raw", async () => {
  const body = {
    error: {
      code: "credential_invalid",
      message: "Sign-in failed.",
      hookCode: "invalid_credentials",
    },
  };
  const c = client(() => json(body, 422));
  const err = await assertRejects(
    () =>
      c.client.console.connections.create("app_1", {
        authKey: "login",
        credential: { email: "a@example.com", password: "p" },
      }),
    ApiError,
  );
  assertEquals(err.status, 422);
  assertEquals(err.code, "credential_invalid");
  assertEquals((err.raw as typeof body).error.hookCode, "invalid_credentials");
});
