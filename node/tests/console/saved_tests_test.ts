/**
 * `client.console.savedTests.*`, against an injected fake `fetch`.
 *
 * No case here needs a live server (`docs/implementation.md` §9). Beyond the
 * per-operation envelope assertions (`list`/`create`/`update`/`listTestRuns`
 * all unwrap), the case that matters most is `recordTestRun`'s asymmetry
 * with `delete`: `recordTestRun` unwraps `run` and RETURNS the real row
 * (the opposite failure mode from every prior console `delete` in this
 * package, which discards to `void`), while `delete` genuinely discards the
 * true-boilerplate `{ok:true}` body. Two mutation-discriminating pairs pin
 * that asymmetry from opposite directions.
 */

import { assertEquals, assertRejects } from "@std/assert";
import { W6WClient } from "../../src/client.ts";
import type { FetchLike } from "../../src/config.ts";
import { ApiError } from "../../src/errors.ts";
import type { SavedTest, SavedTestRun, TestRunSummary } from "../../src/console/saved-tests.ts";

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

const ST_A: SavedTest = {
  id: "st_1",
  connectionId: "conn_1",
  appId: "sendgrid",
  actionKey: "send",
  name: "Happy path",
  values: { to: "a@b.com" },
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
  lastRunAt: null,
  lastRunOk: null,
  lastRunSummary: null,
};

const ST_B: SavedTest = {
  id: "st_2",
  connectionId: "conn_1",
  appId: "sendgrid",
  actionKey: "send",
  name: "Bad address",
  values: { to: "not-an-email" },
  createdAt: "2026-08-02T00:00:00.000Z",
  updatedAt: "2026-08-02T00:00:00.000Z",
  lastRunAt: "2026-08-09T00:00:00.000Z",
  lastRunOk: false,
  lastRunSummary: "Invalid recipient.",
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
  "console.savedTests: list/create/update/delete/recordTestRun/listTestRuns are functions on a constructed client",
  () => {
    // Runtime, not type-level: a namespace that silently lost a method would
    // still typecheck everywhere else in this suite.
    const c = new W6WClient({ baseUrl: "https://api.example.com", token: "t" });
    assertEquals(typeof c.console.savedTests.list, "function");
    assertEquals(typeof c.console.savedTests.create, "function");
    assertEquals(typeof c.console.savedTests.update, "function");
    assertEquals(typeof c.console.savedTests.delete, "function");
    assertEquals(typeof c.console.savedTests.recordTestRun, "function");
    assertEquals(typeof c.console.savedTests.listTestRuns, "function");
  },
);

Deno.test("console.savedTests.list unwraps the savedTests envelope", async () => {
  const c = client(() => json({ savedTests: [ST_A, ST_B] }));

  const res = await c.client.console.savedTests.list("conn_1");

  // A mutant that forgot to call unwrap() would resolve the envelope object
  // itself, not the array it wraps.
  assertEquals(res, [ST_A, ST_B]);
  assertEquals(c.calls[0].method, "GET");
  assertEquals(c.calls[0].url, "https://api.example.com/connections/conn_1/saved-tests");
});

Deno.test("console.savedTests.list propagates a 404 as ApiError", async () => {
  const c = client(() =>
    json({ error: { code: "unknown_connection", message: "Not found." } }, 404)
  );

  const err = await assertRejects(
    () => c.client.console.savedTests.list("conn_missing"),
    ApiError,
  );

  assertEquals(err.status, 404);
  assertEquals(err.code, "unknown_connection");
});

Deno.test("console.savedTests.create sends the body verbatim and unwraps the savedTest envelope", async () => {
  const c = client(() => json({ savedTest: ST_A }, 201));

  const res = await c.client.console.savedTests.create("conn_1", {
    actionKey: "send",
    name: "Happy path",
    values: { to: "a@b.com" },
  });

  assertEquals(res, ST_A);
  assertEquals(c.calls[0].method, "POST");
  assertEquals(c.calls[0].url, "https://api.example.com/connections/conn_1/saved-tests");
  assertEquals(JSON.parse(c.calls[0].body ?? "null"), {
    actionKey: "send",
    name: "Happy path",
    values: { to: "a@b.com" },
  });
});

Deno.test("console.savedTests.update sends the body verbatim, no extra keys injected, and unwraps the savedTest envelope", async () => {
  const c = client(() => json({ savedTest: ST_A }));

  const res = await c.client.console.savedTests.update("conn_1", "st_1", {
    name: "Renamed",
  });

  assertEquals(res, ST_A);
  assertEquals(c.calls[0].method, "PATCH");
  assertEquals(c.calls[0].url, "https://api.example.com/connections/conn_1/saved-tests/st_1");
  assertEquals(JSON.parse(c.calls[0].body ?? "null"), { name: "Renamed" });
});

Deno.test("console.savedTests.delete sends DELETE to the right path and resolves void, discarding {ok:true}", async () => {
  const c = client(() => json({ ok: true }));

  const res = await c.client.console.savedTests.delete("conn_1", "st_1");

  assertEquals(res, undefined);
  assertEquals(c.calls[0].method, "DELETE");
  assertEquals(c.calls[0].url, "https://api.example.com/connections/conn_1/saved-tests/st_1");
  assertEquals(c.calls[0].body, null);
});

Deno.test("console.savedTests.delete does not swallow a 404", async () => {
  const c = client(() =>
    json({ error: { code: "unknown_saved_test", message: "Not found." } }, 404)
  );

  const err = await assertRejects(
    () => c.client.console.savedTests.delete("conn_1", "st_missing"),
    ApiError,
  );

  assertEquals(err.status, 404);
  assertEquals(err.code, "unknown_saved_test");
});

Deno.test(
  "console.savedTests.recordTestRun unwraps `run` and RETURNS the real row — the opposite shape from delete",
  async () => {
    const RUN: SavedTestRun = {
      id: "strun_1",
      savedTestId: "st_1",
      connectionId: "conn_1",
      appId: "sendgrid",
      actionKey: "send",
      ok: true,
      summary: "sent",
      result: {},
      createdAt: "2026-01-01T00:00:00Z",
    };
    const c = client(() => json({ run: RUN }, 201));

    const run = await c.client.console.savedTests.recordTestRun("conn_1", {
      actionKey: "send",
      ok: true,
    });

    // A mutant that discarded this to void (mirroring delete) would resolve
    // undefined here instead of the real row.
    assertEquals(run.id, "strun_1");
    assertEquals(run.ok, true);
    assertEquals(run.savedTestId, "st_1");
    assertEquals(c.calls[0].method, "POST");
    assertEquals(c.calls[0].url, "https://api.example.com/connections/conn_1/test-runs");
  },
);

Deno.test("console.savedTests.recordTestRun sends the body verbatim, no extra keys injected", async () => {
  const c = client(() =>
    json(
      {
        run: {
          id: "strun_1",
          savedTestId: null,
          connectionId: "conn_1",
          appId: "sendgrid",
          actionKey: "send",
          ok: true,
          summary: null,
          result: null,
          createdAt: "2026-01-01T00:00:00Z",
        },
      },
      201,
    )
  );

  await c.client.console.savedTests.recordTestRun("conn_1", {
    actionKey: "send",
    ok: true,
  });

  assertEquals(JSON.parse(c.calls[0].body ?? "null"), { actionKey: "send", ok: true });
});

Deno.test("console.savedTests.recordTestRun propagates a 404 as ApiError", async () => {
  const c = client(() =>
    json({ error: { code: "unknown_connection", message: "Not found." } }, 404)
  );

  const err = await assertRejects(
    () =>
      c.client.console.savedTests.recordTestRun("conn_missing", { actionKey: "send", ok: true }),
    ApiError,
  );

  assertEquals(err.status, 404);
  assertEquals(err.code, "unknown_connection");
});

Deno.test("console.savedTests.listTestRuns unwraps the runs envelope (thin TestRunSummary projection)", async () => {
  const RUNS: TestRunSummary[] = [
    {
      id: "strun_2",
      actionKey: "send",
      ok: false,
      summary: "Invalid recipient.",
      occurredAt: "2026-08-09T00:00:00Z",
    },
    {
      id: "strun_1",
      actionKey: "send",
      ok: true,
      summary: "sent",
      occurredAt: "2026-08-01T00:00:00Z",
    },
  ];
  const c = client(() => json({ runs: RUNS }));

  const res = await c.client.console.savedTests.listTestRuns("conn_1");

  assertEquals(res, RUNS);
  assertEquals(c.calls[0].method, "GET");
  assertEquals(c.calls[0].url, "https://api.example.com/connections/conn_1/test-runs");
});

Deno.test("console.savedTests.list percent-encodes connectionId via the `path` tag", async () => {
  const c = client(() => json({ savedTests: [] }));

  await c.client.console.savedTests.list("conn 1");

  assertEquals(c.calls[0].url, "https://api.example.com/connections/conn%201/saved-tests");
});

Deno.test("console.savedTests.update percent-encodes connectionId and id via the `path` tag", async () => {
  const c = client(() => json({ savedTest: ST_A }));

  await c.client.console.savedTests.update("conn 1", "st 1", { name: "x" });

  assertEquals(
    c.calls[0].url,
    "https://api.example.com/connections/conn%201/saved-tests/st%201",
  );
});

Deno.test("console.savedTests.delete percent-encodes connectionId and id via the `path` tag", async () => {
  const c = client(() => json({ ok: true }));

  await c.client.console.savedTests.delete("conn 1", "st 1");

  assertEquals(
    c.calls[0].url,
    "https://api.example.com/connections/conn%201/saved-tests/st%201",
  );
});
