/**
 * `client.console.schedules.*`, against an injected fake `fetch`.
 *
 * No case here needs a live server (`docs/implementation.md` §9). Beyond the
 * per-operation assertions, this suite pins the deliberate 404→`null`
 * asymmetry of `get` — relocated verbatim from `client.ts:535-542` — with two
 * mutation-discriminating pairs:
 *
 * - a mutant that let a 404 bubble as `ApiError` (too narrow a catch) is
 *   caught by the "resolves null" cases below;
 * - a mutant that swallowed EVERY error into `null` (too broad a catch) is
 *   caught by the "still throws on non-404" case.
 *
 * `upsert`/`get` also carry an envelope key (`{ schedule: {...} }`), so — like
 * `console.projects` — the cases below discriminate a "forgot to call
 * `unwrap()`" mutant, the opposite failure mode from
 * `console.reliability`/`console.auth`/`console.dashboard`'s envelope-free
 * responses.
 */

import { assertEquals, assertRejects } from "@std/assert";
import { W6WClient } from "../../src/client.ts";
import type { FetchLike } from "../../src/config.ts";
import { ApiError } from "../../src/errors.ts";
import type { Schedule } from "../../src/console/schedules.ts";

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

const SCHEDULE: Schedule = {
  workflowId: "wf_1",
  cron: "*/5 * * * *",
  enabled: true,
  variables: { greeting: "hi" },
  nextRunAt: "2026-08-09T13:00:00.000Z",
  lastRunAt: "2026-08-09T12:55:00.000Z",
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

Deno.test("console.schedules: get/upsert/delete are functions on a constructed client", () => {
  // Runtime, not type-level: a namespace that silently lost a method would
  // still typecheck everywhere else in this suite.
  const c = new W6WClient({ baseUrl: "https://api.example.com", token: "t" });
  assertEquals(typeof c.console.schedules.get, "function");
  assertEquals(typeof c.console.schedules.upsert, "function");
  assertEquals(typeof c.console.schedules.delete, "function");
});

Deno.test("console.schedules.get unwraps the envelope and returns the schedule", async () => {
  const c = client(() => json({ schedule: SCHEDULE }));

  const res = await c.client.console.schedules.get("wf_1");

  // A mutant that returned `res.body` directly (skipping `unwrap`) would fail
  // this assertion — it would see the envelope object, not the schedule it wraps.
  assertEquals(res, SCHEDULE);
  assertEquals(c.calls[0].method, "GET");
  assertEquals(c.calls[0].url, "https://api.example.com/workflows/wf_1/schedule");
});

Deno.test("console.schedules.get on a 404 `no_schedule` resolves null, does not throw", async () => {
  const c = client(() => json({ error: { code: "no_schedule", message: "Not scheduled." } }, 404));

  const res = await c.client.console.schedules.get("wf_1");

  assertEquals(res, null);
});

Deno.test("console.schedules.get on a 404 `unknown_workflow` ALSO resolves null — the client does not discriminate by code, only by status", async () => {
  const c = client(() =>
    json({ error: { code: "unknown_workflow", message: "No such workflow." } }, 404)
  );

  const res = await c.client.console.schedules.get("wf_missing");

  assertEquals(res, null);
});

Deno.test("console.schedules.get on a non-404 error still throws — the catch does not swallow every error", async () => {
  const c = client(() => json({ error: { code: "internal_error", message: "boom" } }, 500));

  const err = await assertRejects(
    () => c.client.console.schedules.get("wf_1"),
    ApiError,
  );

  assertEquals(err.status, 500);
  assertEquals(err.code, "internal_error");
});

Deno.test("console.schedules.upsert sends the body verbatim and unwraps the envelope", async () => {
  const c = client(() => json({ schedule: SCHEDULE }));

  const res = await c.client.console.schedules.upsert("wf_1", {
    cron: "*/5 * * * *",
    enabled: true,
  });

  assertEquals(res, SCHEDULE);
  assertEquals(c.calls[0].method, "POST");
  assertEquals(c.calls[0].url, "https://api.example.com/workflows/wf_1/schedule");
  assertEquals(JSON.parse(c.calls[0].body ?? "null"), { cron: "*/5 * * * *", enabled: true });
});

Deno.test("console.schedules.delete sends DELETE to the right path and resolves void, discarding {ok:true}", async () => {
  const c = client(() => json({ ok: true }));

  const res = await c.client.console.schedules.delete("wf_1");

  assertEquals(res, undefined);
  assertEquals(c.calls[0].method, "DELETE");
  assertEquals(c.calls[0].url, "https://api.example.com/workflows/wf_1/schedule");
  assertEquals(c.calls[0].body, null);
});

Deno.test("console.schedules.delete does not swallow a 404 — it is not a silent success, unlike get", async () => {
  const c = client(() =>
    json({ error: { code: "unknown_workflow", message: "No such workflow." } }, 404)
  );

  const err = await assertRejects(
    () => c.client.console.schedules.delete("wf_missing"),
    ApiError,
  );

  assertEquals(err.status, 404);
  assertEquals(err.code, "unknown_workflow");
});

Deno.test("console.schedules.get percent-encodes the workflowId via the `path` tag, not string concatenation", async () => {
  const c = client(() => json({ schedule: SCHEDULE }));

  await c.client.console.schedules.get("wf/1");

  assertEquals(c.calls[0].url, "https://api.example.com/workflows/wf%2F1/schedule");
});
