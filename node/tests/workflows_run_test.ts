/**
 * `client.workflows.run()`, against an injected fake `fetch`.
 *
 * The three semantics this route is most often got wrong each have a case here,
 * and each one would fail against the obvious wrong implementation:
 *
 * - **`202` is success** — a wrapper that treated a non-`200` as an error fails
 *   the queued case and the `?wait=` timeout case.
 * - **A failed run is data** — a wrapper that mapped `status: "failed"` to a
 *   raised exception fails the third case, which asserts a returned value.
 * - **No client-side polling** — every case asserts `calls.length === 1`, so a
 *   transcribed poll loop fails all of them rather than merely being slow.
 *
 * No case needs a live server (`docs/implementation.md` §9), even though this
 * route is served today.
 */

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { W6WClient } from "../src/client.ts";
import type { FetchLike } from "../src/config.ts";
import { ApiError } from "../src/errors.ts";

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

/** The parsed request body of a recorded call. */
function sentBody(call: Call): Record<string, unknown> {
  return JSON.parse(call.body ?? "null");
}

Deno.test("workflows.run: a 202 queued run is SUCCESS, and hands back the handle", async () => {
  // The default path: no `wait`, so the server enqueues and answers immediately.
  // A wrapper that raised on a non-200 would fail here — 202 is the *normal*
  // outcome of this route, not an edge case.
  const c = client(() => json({ runId: "run_01HQ", status: "queued" }, 202));

  const run = await c.client.workflows.run("wf_01HQ");

  assertEquals(run.runId, "run_01HQ");
  assertEquals(run.status, "queued");
  assertEquals(run.terminal, false);
  assertEquals(run.httpStatus, 202);
  // A 202 carries no steps; normalised to {} so a caller iterating them never
  // has to branch on which status carried the body.
  assertEquals(run.steps, {});

  assertEquals(c.calls.length, 1, "exactly one request — no client-side polling");
  assertEquals(c.calls[0].method, "POST");
  // No `?wait=` at all, not `?wait=false`.
  assertEquals(c.calls[0].url, "https://api.example.com/workflows/wf_01HQ/run");
  assertEquals(c.calls[0].headers.get("authorization"), "Bearer tok_1");
  assertEquals(sentBody(c.calls[0]), {});
});

Deno.test("workflows.run: ?wait=true returns the terminal 200 result", async () => {
  const c = client(() =>
    json({
      runId: "run_01HQ",
      status: "succeeded",
      output: { sent: 3 },
      error: null,
      steps: { step_a: { status: "succeeded" } },
    })
  );

  const run = await c.client.workflows.run("wf_01HQ", { wait: true });

  assertEquals(run.status, "succeeded");
  assertEquals(run.terminal, true);
  assertEquals(run.httpStatus, 200);
  assertEquals(run.output, { sent: 3 });
  assertEquals(run.steps, { step_a: { status: "succeeded" } });

  assertEquals(c.calls.length, 1, "the wait happens server-side — one request");
  assertEquals(c.calls[0].url, "https://api.example.com/workflows/wf_01HQ/run?wait=true");
});

Deno.test("workflows.run: a 200 carrying status 'failed' is RETURNED, never raised", async () => {
  // The single most-often-got-wrong semantic in this surface. A run-level
  // failure is reported in the envelope, not as an HTTP error, so this must be
  // an ordinary return value — an implementation that throws fails this case
  // because the assertions below are on what came back.
  const c = client(() =>
    json({
      runId: "run_01HQ",
      status: "failed",
      output: null,
      error: { code: "step_failed", message: "sendgrid rejected the payload" },
      steps: { step_a: { status: "failed" } },
    })
  );

  const run = await c.client.workflows.run("wf_01HQ", { wait: true });

  assertEquals(run.status, "failed");
  // Terminal, because the run finished — it finished badly, which is data.
  assertEquals(run.terminal, true);
  assertEquals(run.httpStatus, 200);
  assertEquals(run.error, { code: "step_failed", message: "sendgrid rejected the payload" });
  // Mapping this to a non-zero exit is the CLI's job, not the SDK's.
});

Deno.test("workflows.run: a ?wait= timeout comes back as a 202 with the current status", async () => {
  // The server waited up to its own timeout and gave up; the run is still
  // going. Also a success, and the reason `httpStatus` is exposed at all: the
  // body alone cannot tell this apart from a run that was never waited on.
  const c = client(() => json({ runId: "run_01HQ", status: "running" }, 202));

  const run = await c.client.workflows.run("wf_01HQ", { wait: true });

  assertEquals(run.status, "running");
  assertEquals(run.terminal, false);
  assertEquals(run.httpStatus, 202);
  assertEquals(c.calls.length, 1, "no client-side retry after a server-side timeout");
});

Deno.test("workflows.run: variables and trigger reach the request body", async () => {
  const c = client(() => json({ runId: "run_01HQ", status: "queued" }, 202));

  await c.client.workflows.run("wf_01HQ", {
    variables: { email: "a@example.com", count: 2 },
    trigger: "webhook",
  });

  assertEquals(sentBody(c.calls[0]), {
    variables: { email: "a@example.com", count: 2 },
    trigger: "webhook",
  });
  assertEquals(c.calls[0].headers.get("content-type"), "application/json");
  // They are body fields, not query parameters.
  assertEquals(c.calls[0].url, "https://api.example.com/workflows/wf_01HQ/run");

  // `wait: false` is the same request as no wait at all — the server compares
  // the query value to the string "true", so `?wait=false` would look like it
  // meant something while meaning nothing.
  const off = client(() => json({ runId: "run_2", status: "queued" }, 202));
  await off.client.workflows.run("wf_01HQ", { wait: false });
  assertEquals(off.calls[0].url, "https://api.example.com/workflows/wf_01HQ/run");
});

Deno.test("workflows.run: input reaches the request body, distinct from variables", async () => {
  // `input` is delivered to the entry trigger node's own recorded output
  // (`steps.<triggerId>.output.<key>`), not the run's variable scope
  // (`vars.*`, which is what `variables` seeds) — they are separate body
  // fields and must both be sent when both are given.
  const c = client(() => json({ runId: "run_01HQ", status: "queued" }, 202));

  await c.client.workflows.run("wf_01HQ", {
    variables: { count: 2 },
    input: { email: "a@example.com", plan: "pro" },
  });

  assertEquals(sentBody(c.calls[0]), {
    variables: { count: 2 },
    input: { email: "a@example.com", plan: "pro" },
  });

  // Omitted means omitted, not `null` or `{}` — no `input` key at all when the
  // caller does not pass one.
  const off = client(() => json({ runId: "run_2", status: "queued" }, 202));
  await off.client.workflows.run("wf_01HQ", { variables: { count: 1 } });
  assertEquals(sentBody(off.calls[0]), { variables: { count: 1 } });
});

Deno.test("workflows.run: a 404 unknown_workflow reaches the caller as an ApiError", async () => {
  const c = client(() =>
    json({ error: { code: "unknown_workflow", message: "Not registered." } }, 404, "Not Found")
  );

  const err = await assertRejects(() => c.client.workflows.run("wf_missing"), ApiError);

  assertEquals(err.status, 404);
  assertEquals(err.code, "unknown_workflow");
  assertEquals(err.message, "Not registered.");
  // The parsed body is kept, so a caller never has to re-issue the request.
  assertEquals(err.raw, { error: { code: "unknown_workflow", message: "Not registered." } });
});

Deno.test("workflows.run: the workflow id is percent-encoded into the path", async () => {
  // Encoding at interpolation, via the `path` tag — the same pin the document
  // key routes are held to. A caller-supplied id never becomes extra segments.
  const c = client(() => json({ runId: "run_1", status: "queued" }, 202));

  await c.client.workflows.run("wf a/b?x");

  assertEquals(c.calls[0].url, "https://api.example.com/workflows/wf%20a%2Fb%3Fx/run");
});

Deno.test("workflows.run: a success body that is not a run object is bad_response", async () => {
  // A proxy answering 200 "ok" must fail loudly here rather than return an
  // object whose only populated fields are the two this client derived.
  const c = client(() => json("ok"));

  const err = await assertRejects(() => c.client.workflows.run("wf_01HQ"), ApiError);

  assertEquals(err.code, "bad_response");
  assertEquals(err.status, 200);
  assertStringIncludes(err.message, "not a run object");
});

Deno.test("workflows.run: an object-shaped body with no run in it is bad_response", async () => {
  // The guard used to check only `typeof body === "object"`, which every one of
  // these passes — `typeof [] === "object"` included. Measured against that
  // version, each returned a WorkflowRunResult whose `runId: string` and
  // `status: RunStatus` were `undefined` AT RUNTIME: a lie the compiler cannot
  // catch, surfacing as a TypeError somewhere in the caller minutes later.
  //
  // Its sibling `client.run()` already required a string `kind`; two operations
  // in one package must not disagree about what a malformed success body is.
  // Python's idiomatic `isinstance(body, dict)` rejects `[]` too, so this is
  // also what keeps the lanes answering alike.
  const bodies: unknown[] = [
    {},
    [],
    [{ runId: "run_1", status: "queued" }],
    { ok: true },
    { runId: 42, status: 7 },
    { runId: "run_1" },
    { status: "queued" },
    null,
  ];
  for (const body of bodies) {
    const c = client(() => json(body));

    const err = await assertRejects(
      () => c.client.workflows.run("wf_01HQ"),
      ApiError,
      undefined,
      `body ${JSON.stringify(body)} should be rejected`,
    );

    assertEquals(err.code, "bad_response");
    assertStringIncludes(err.message, "not a run object");
    // The body is kept on the error, so a caller can see what actually arrived.
    assertEquals(err.raw, body);
  }
});

Deno.test("workflows.run: a minimal well-formed 202 body is still accepted", async () => {
  // The control for the case above: the guard must reject malformed bodies
  // without becoming a schema validator. `runId` + `status` is everything a
  // queued run carries, and it goes straight through.
  const c = client(() => json({ runId: "run_1", status: "queued" }, 202));

  const run = await c.client.workflows.run("wf_01HQ");

  assertEquals(run.runId, "run_1");
  assertEquals(run.status, "queued");
  assertEquals(run.steps, {});
  assertEquals(run.terminal, false);
  assertEquals(run.httpStatus, 202);
});

Deno.test("workflows.run: an unknown trigger value is sent, never validated", async () => {
  // `endpoints.json` declares `trigger` as an open string with `closedEnum:
  // false` — the five known values are documentation. A wrapper that validated
  // against them would reject a request the server accepts, so the value is
  // passed through verbatim.
  const c = client(() => json({ runId: "run_1", status: "queued" }, 202));

  await c.client.workflows.run("wf_01HQ", { trigger: "a_future_server_value" });

  assertEquals(JSON.parse(c.calls[0].body ?? "null"), { trigger: "a_future_server_value" });
});
