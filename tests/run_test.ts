/**
 * `client.run({urn, action, payload})`, against an injected fake `fetch`.
 *
 * `POST /api/run` is live (verified 2026-07-28); every case here still runs
 * against a mocked transport, which is what `docs/implementation.md` §9 asks
 * for regardless of server status.
 *
 * Two things are load-bearing and are asserted rather than assumed:
 *
 * 1. **The arms keep their own field names.** `value` (action) and `output`
 *    (function) are deliberately different; a wrapper that normalised them into
 *    one field would fail the first two cases.
 * 2. **An unknown `kind` is returned, not raised.** The case below feeds
 *    `{"kind":"batch","jobId":"job_1"}` and asserts the returned object,
 *    including the unknown sibling field — "does not crash" is not an assertion
 *    a raising implementation fails, so it is not what is asserted.
 */

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { W6wClient } from "../src/client.ts";
import type { FetchLike } from "../src/config.ts";
import { ApiError } from "../src/errors.ts";
import {
  isActionRun,
  isFunctionRun,
  isWorkflowRun,
  type RunEnvelope,
  type RunStatus,
  type UnknownRunEnvelope,
} from "../src/types.ts";

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

/** The parsed request body of a recorded call. */
function sentBody(call: Call): Record<string, unknown> {
  return JSON.parse(call.body ?? "null");
}

Deno.test("run: the action arm keeps `kind` and `value`, at 200", async () => {
  const c = client(() => json({ kind: "action", value: { messageId: "msg_1" } }));

  const env = await c.client.run({
    urn: "conn_01HQ",
    action: "send_email",
    payload: { to: "a@example.com" },
  });

  // Guarded, not narrowed by hand: the union is open, so `env.value` is not
  // reachable from a bare `env.kind === "action"` check.
  assertEquals(isActionRun(env), true);
  if (!isActionRun(env)) throw new Error("unreachable");
  assertEquals(env.value, { messageId: "msg_1" });

  assertEquals(c.calls.length, 1);
  assertEquals(c.calls[0].method, "POST");
  // The URN travels in the body, so nothing here is interpolated into a path.
  assertEquals(c.calls[0].url, "https://api.example.com/api/run");
  assertEquals(c.calls[0].headers.get("authorization"), "Bearer tok_1");
  assertEquals(sentBody(c.calls[0]), {
    urn: "conn_01HQ",
    action: "send_email",
    payload: { to: "a@example.com" },
  });
});

Deno.test("run: the function arm carries `output`, and is NOT normalised to `value`", async () => {
  const c = client(() => json({ kind: "function", output: { total: 7 } }));

  const env = await c.client.run({ urn: "fn_01HQ", payload: { items: [1, 2] } });

  assertEquals(isFunctionRun(env), true);
  assertEquals(isActionRun(env), false);
  if (!isFunctionRun(env)) throw new Error("unreachable");
  assertEquals(env.output, { total: 7 });
  // The two synchronous arms are told apart by field name; a client that folded
  // them together would make `value` appear here.
  assertEquals(Object.hasOwn(env, "value"), false);
});

Deno.test("run: the workflow arm is a 202 with runId + status — success, and needs no action", async () => {
  const c = client(() => json({ kind: "workflow", runId: "run_01HQ", status: "queued" }, 202));

  // A workflow URN has no action, so none is passed; `payload` is omitted too.
  const env = await c.client.run({ urn: "wf_01HQ" });

  assertEquals(isWorkflowRun(env), true);
  if (!isWorkflowRun(env)) throw new Error("unreachable");
  assertEquals(env.runId, "run_01HQ");
  // Typed access, not `unknown`: this assignment is the compile-time half of the
  // assertion and fails `deno check` if the guard stops narrowing.
  const status: RunStatus = env.status;
  assertEquals(status, "queued");

  // `action` is dropped from the body when absent; `payload` defaults to `{}`
  // rather than being omitted.
  assertEquals(sentBody(c.calls[0]), { urn: "wf_01HQ", payload: {} });
});

Deno.test("run: an unknown kind RETURNS the raw envelope and does not raise", async () => {
  // The server may grow a fourth kind before this SDK does — an additive change
  // that must not become a hard breakage for an installed client. The envelope
  // is handed back with its unknown sibling field reachable.
  const body = { kind: "batch", jobId: "job_1" };
  const c = client(() => json(body, 202));

  const env = await c.client.run({ urn: "batch_01HQ" });

  assertEquals(env, { kind: "batch", jobId: "job_1" });
  assertEquals(env.kind, "batch");
  // The open arm is what makes the unknown sibling field reachable at all —
  // this is the type a caller lands in once the three guards have said no.
  assertEquals((env as UnknownRunEnvelope).jobId, "job_1");
  // None of the known guards claim it, so a caller's `else` branch gets it.
  assertEquals(isActionRun(env), false);
  assertEquals(isFunctionRun(env), false);
  assertEquals(isWorkflowRun(env), false);
});

Deno.test("run: the guards are what a caller dispatches on", async () => {
  // The documented consumer shape, exercised end to end: one `describe` over an
  // envelope of any kind, with the unknown one falling through to the default
  // arm instead of throwing.
  function describe(env: RunEnvelope): string {
    if (isActionRun(env)) return `action:${JSON.stringify(env.value)}`;
    if (isFunctionRun(env)) return `function:${JSON.stringify(env.output)}`;
    if (isWorkflowRun(env)) return `workflow:${env.runId}:${env.status}`;
    return `unknown:${env.kind}`;
  }

  const bodies: unknown[] = [
    { kind: "action", value: 1 },
    { kind: "function", output: 2 },
    { kind: "workflow", runId: "run_1", status: "queued" },
    { kind: "batch", jobId: "job_1" },
  ];
  let i = 0;
  const c = client(() => json(bodies[i++]));

  const seen: string[] = [];
  for (const _ of bodies) seen.push(describe(await c.client.run({ urn: "urn_x" })));

  assertEquals(seen, [
    "action:1",
    "function:2",
    "workflow:run_1:queued",
    "unknown:batch",
  ]);
});

Deno.test("run: a 404 for an unresolvable URN reaches the caller as an ApiError", async () => {
  const c = client(() =>
    json({ error: { code: "unknown_urn", message: "No such target." } }, 404, "Not Found")
  );

  const err = await assertRejects(() => c.client.run({ urn: "conn_missing" }), ApiError);

  assertEquals(err.status, 404);
  assertEquals(err.code, "unknown_urn");
  assertEquals(err.message, "No such target.");
});

Deno.test("run: a 424 execute-phase failure keeps its code — not network_error", async () => {
  // 424 means the target app or its upstream vendor failed during execute. It
  // is a 4xx on purpose (Cloudflare replaces an origin 5xx with a CORS-less
  // HTML page), and it must not be normalised into a transport failure or a
  // server error — the code and the body are what a caller diagnoses with.
  const c = client(() =>
    json(
      {
        error: { code: "app_execute_failed", message: "sendgrid returned 401" },
        logs: ["POST https://api.sendgrid.com/v3/mail/send -> 401"],
      },
      424,
      "Failed Dependency",
    )
  );

  const err = await assertRejects(
    () => c.client.run({ urn: "conn_01HQ", action: "send_email" }),
    ApiError,
  );

  assertEquals(err.status, 424);
  assertEquals(err.code, "app_execute_failed");
  assertEquals((err.raw as { logs: string[] }).logs.length, 1);
});

Deno.test("run: a success body with no `kind` is bad_response", async () => {
  // Not a new arm — a dispatch response with no discriminator at all, which is
  // the one shape a caller can do nothing with. It fails loudly here rather
  // than surfacing as an undefined `kind` somewhere in the caller's switch.
  const c = client(() => json({ value: 1 }));

  const err = await assertRejects(() => c.client.run({ urn: "conn_01HQ" }), ApiError);

  assertEquals(err.code, "bad_response");
  assertStringIncludes(err.message, '"kind"');
});
