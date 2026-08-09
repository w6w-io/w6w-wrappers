/**
 * `client.console.workflows.*`, against an injected fake `fetch`.
 *
 * No case here needs a live server (`docs/implementation.md` §9). The cases
 * that matter most, beyond per-operation envelope shape:
 *
 * - `get`/`archive` return the body directly (no envelope key) while
 *   `listRuns`/`getRun` DO unwrap — two mutation-discriminating pairs that
 *   catch a mutant flipping either one to the other's behavior.
 * - `upsert` sends `x-w6w-if-unmodified-since` ONLY when `ifUnmodifiedSince`
 *   is supplied, never unconditionally, and never as `"undefined"`/`"null"`.
 * - `delete` does NOT catch `409 workflow_not_archived` — it must propagate.
 * - `get`/`listRuns`/`getRun` all still throw on a genuine non-2xx.
 * - Every id-taking method routes its id through the `path` tag (percent-encoding).
 */

import { assertEquals, assertRejects } from "@std/assert";
import { W6wClient } from "../../src/client.ts";
import type { FetchLike } from "../../src/config.ts";
import { ApiError } from "../../src/errors.ts";
import type { RunState, RunSummary } from "../../src/console/workflows.ts";

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

const RUN_STATE_A: RunState = {
  runId: "run_1",
  workflowId: "wf_1",
  status: "succeeded",
  variables: { a: 1 },
  steps: { nd_1: { output: "ok" } },
  output: { ok: true },
};

const RUN_SUMMARY_A: RunSummary = {
  runId: "run_1",
  status: "succeeded",
  trigger: "manual",
  startedAt: "2026-08-09T00:00:00.000Z",
  finishedAt: "2026-08-09T00:00:05.000Z",
};

const RUN_SUMMARY_B: RunSummary = {
  runId: "run_2",
  status: "running",
  trigger: "schedule",
  startedAt: "2026-08-09T01:00:00.000Z",
  finishedAt: null,
};

Deno.test(
  "console.workflows: get/upsert/archive/delete/listRuns/getRun are functions on a constructed client, base workflows.list/run untouched",
  () => {
    // Runtime, not type-level: a namespace that silently lost a method would
    // still typecheck everywhere else in this suite.
    const c = new W6wClient({ baseUrl: "https://api.example.com", token: "t" });
    assertEquals(typeof c.console.workflows.get, "function");
    assertEquals(typeof c.console.workflows.upsert, "function");
    assertEquals(typeof c.console.workflows.archive, "function");
    assertEquals(typeof c.console.workflows.delete, "function");
    assertEquals(typeof c.console.workflows.listRuns, "function");
    assertEquals(typeof c.console.workflows.getRun, "function");
    // Regression-proofs this task didn't accidentally remove or shadow the
    // base methods it deliberately leaves alone.
    assertEquals(typeof c.workflows.list, "function");
    assertEquals(typeof c.workflows.run, "function");
  },
);

Deno.test("console.workflows.get returns the body directly — no envelope key", async () => {
  const c = client(() =>
    json({ workflow: { id: "wf_1", status: "draft" }, sourceRef: null, updatedAt: "T1" })
  );

  const res = await c.client.console.workflows.get("wf_1");

  // A mutant that wrongly called unwrap(res, "workflow") here would throw
  // bad_response — there is no such single-key envelope.
  assertEquals(res, {
    workflow: { id: "wf_1", status: "draft" },
    sourceRef: null,
    updatedAt: "T1",
  });
  assertEquals(c.calls[0].method, "GET");
  assertEquals(c.calls[0].url, "https://api.example.com/workflows/wf_1");
});

Deno.test("console.workflows.archive returns the body directly — no envelope key", async () => {
  const c = client(() => json({ workflow: { id: "wf_1", status: "archived" } }));

  const res = await c.client.console.workflows.archive("wf_1");

  assertEquals(res, { workflow: { id: "wf_1", status: "archived" } });
  assertEquals(c.calls[0].method, "POST");
  assertEquals(c.calls[0].url, "https://api.example.com/workflows/wf_1/archive");
});

Deno.test("console.workflows.listRuns DOES unwrap the runs envelope", async () => {
  const c = client(() => json({ runs: [RUN_SUMMARY_A, RUN_SUMMARY_B] }));

  const res = await c.client.console.workflows.listRuns("wf_1");

  // A mutant that returned res.body raw here would hand back {runs:[...]},
  // not the array — this pins the opposite failure mode from get/archive.
  assertEquals(res, [RUN_SUMMARY_A, RUN_SUMMARY_B]);
  assertEquals(c.calls[0].method, "GET");
  assertEquals(c.calls[0].url, "https://api.example.com/workflows/wf_1/runs");
});

Deno.test("console.workflows.getRun DOES unwrap the run envelope", async () => {
  const c = client(() => json({ run: RUN_STATE_A }));

  const res = await c.client.console.workflows.getRun("run_1");

  // A mutant that returned res.body raw here would hand back {run:{...}}, not
  // the run itself.
  assertEquals(res, RUN_STATE_A);
  assertEquals(c.calls[0].method, "GET");
  assertEquals(c.calls[0].url, "https://api.example.com/runs/run_1");
});

Deno.test("console.workflows.upsert sends the precondition header ONLY when supplied", async () => {
  const c = client(() =>
    json({ workflow: { id: "wf_1", name: "wf_1" }, scheduled: false, updatedAt: "T2" }, 201)
  );
  await c.client.console.workflows.upsert({ id: "wf_1" }, { ifUnmodifiedSince: "T1" });
  assertEquals(c.calls[0].headers.get("x-w6w-if-unmodified-since"), "T1");

  const c2 = client(() =>
    json({ workflow: { id: "wf_2", name: "wf_2" }, scheduled: false, updatedAt: "T1" }, 201)
  );
  await c2.client.console.workflows.upsert({ id: "wf_2" });
  // Not just "falsy" — genuinely absent, never sent as "undefined" or "null".
  assertEquals(c2.calls[0].headers.has("x-w6w-if-unmodified-since"), false);
});

Deno.test("console.workflows.upsert sends the definition body verbatim, and ?project= only when supplied", async () => {
  const c = client(() =>
    json({ workflow: { id: "wf_1", name: "wf_1" }, scheduled: true, updatedAt: "T1" }, 201)
  );

  await c.client.console.workflows.upsert({ id: "wf_1", steps: [] }, { project: "prj_a" });

  assertEquals(JSON.parse(c.calls[0].body ?? "null"), { id: "wf_1", steps: [] });
  assertEquals(c.calls[0].url, "https://api.example.com/workflows?project=prj_a");
  assertEquals(c.calls[0].method, "POST");
});

Deno.test("console.workflows.upsert omits ?project= entirely when not supplied", async () => {
  const c = client(() =>
    json({ workflow: { id: "wf_2", name: "wf_2" }, scheduled: false, updatedAt: "T1" }, 201)
  );

  await c.client.console.workflows.upsert({ id: "wf_2" });

  assertEquals(c.calls[0].url, "https://api.example.com/workflows");
});

Deno.test("console.workflows.upsert returns the response body's three top-level keys directly", async () => {
  const c = client(() =>
    json({ workflow: { id: "wf_1", name: "wf_1" }, scheduled: true, updatedAt: "T3" }, 201)
  );

  const res = await c.client.console.workflows.upsert({ id: "wf_1" });

  assertEquals(res, { workflow: { id: "wf_1", name: "wf_1" }, scheduled: true, updatedAt: "T3" });
});

Deno.test("console.workflows.delete does NOT catch 409 workflow_not_archived — it propagates", async () => {
  const c = client(() =>
    json({ error: { code: "workflow_not_archived", message: "Archive first." } }, 409)
  );

  const err = await assertRejects(
    () => c.client.console.workflows.delete("wf_1"),
    ApiError,
  );

  assertEquals(err.status, 409);
  assertEquals(err.code, "workflow_not_archived");
});

Deno.test("console.workflows.delete sends DELETE to the right path and resolves void, discarding {ok:true}", async () => {
  const c = client(() => json({ ok: true }));

  const res = await c.client.console.workflows.delete("wf_1");

  assertEquals(res, undefined);
  assertEquals(c.calls[0].method, "DELETE");
  assertEquals(c.calls[0].url, "https://api.example.com/workflows/wf_1");
});

Deno.test("console.workflows.get throws on a genuine non-2xx", async () => {
  const c = client(() =>
    json({ error: { code: "unknown_workflow", message: "Not registered." } }, 404)
  );

  const err = await assertRejects(() => c.client.console.workflows.get("wf_missing"), ApiError);

  assertEquals(err.status, 404);
  assertEquals(err.code, "unknown_workflow");
});

Deno.test("console.workflows.listRuns throws on a genuine non-2xx", async () => {
  const c = client(() =>
    json({ error: { code: "unknown_workflow", message: "Not registered." } }, 404)
  );

  const err = await assertRejects(
    () => c.client.console.workflows.listRuns("wf_missing"),
    ApiError,
  );

  assertEquals(err.status, 404);
  assertEquals(err.code, "unknown_workflow");
});

Deno.test("console.workflows.getRun throws on a genuine non-2xx", async () => {
  const c = client(() => json({ error: { code: "unknown_run", message: "Not found." } }, 404));

  const err = await assertRejects(
    () => c.client.console.workflows.getRun("run_missing"),
    ApiError,
  );

  assertEquals(err.status, 404);
  assertEquals(err.code, "unknown_run");
});

Deno.test("console.workflows.archive throws on a genuine non-2xx", async () => {
  const c = client(() =>
    json({ error: { code: "unknown_workflow", message: "Not registered." } }, 404)
  );

  const err = await assertRejects(
    () => c.client.console.workflows.archive("wf_missing"),
    ApiError,
  );

  assertEquals(err.status, 404);
  assertEquals(err.code, "unknown_workflow");
});

Deno.test("console.workflows.get percent-encodes id via the `path` tag", async () => {
  const c = client(() => json({ workflow: {}, sourceRef: null, updatedAt: "T1" }));

  await c.client.console.workflows.get("wf 1");

  assertEquals(c.calls[0].url, "https://api.example.com/workflows/wf%201");
});

Deno.test("console.workflows.archive percent-encodes id via the `path` tag", async () => {
  const c = client(() => json({ workflow: {} }));

  await c.client.console.workflows.archive("wf 1");

  assertEquals(c.calls[0].url, "https://api.example.com/workflows/wf%201/archive");
});

Deno.test("console.workflows.delete percent-encodes id via the `path` tag", async () => {
  const c = client(() => json({ ok: true }));

  await c.client.console.workflows.delete("wf 1");

  assertEquals(c.calls[0].url, "https://api.example.com/workflows/wf%201");
});

Deno.test("console.workflows.listRuns percent-encodes id via the `path` tag", async () => {
  const c = client(() => json({ runs: [] }));

  await c.client.console.workflows.listRuns("wf 1");

  assertEquals(c.calls[0].url, "https://api.example.com/workflows/wf%201/runs");
});

Deno.test("console.workflows.getRun percent-encodes runId via the `path` tag", async () => {
  const c = client(() => json({ run: RUN_STATE_A }));

  await c.client.console.workflows.getRun("run 1");

  assertEquals(c.calls[0].url, "https://api.example.com/runs/run%201");
});
