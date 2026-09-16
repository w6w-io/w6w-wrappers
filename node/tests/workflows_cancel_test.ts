/**
 * `client.workflows.cancel()`, against an injected fake `fetch`.
 *
 * Mirrors `workflows_run_test.ts`'s shape and reuses its house style, because
 * this route is most often got wrong in exactly three plausible ways:
 *
 * - **The path root** — every other method on this class is
 *   `/workflows/…`-rooted; this one alone hits `/runs/…`, because it is
 *   addressed by the RUN id, not the workflow id.
 * - **The envelope key** — `"run"`, not `"workflow"` (the key every sibling
 *   write method on this class unwraps).
 * - **`202` does not mean stopped** — the returned `status` is the run's
 *   status as it is right now, never `"canceled"`.
 *
 * No case needs a live server (`docs/implementation.md` §9): T1.1.3 is
 * building the server route this wraps in parallel, and this suite asserts
 * against the pinned wire contract alone.
 */

import { assertEquals, assertRejects } from "@std/assert";
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

function json(body: unknown, status = 202, statusText?: string): Response {
  return new Response(JSON.stringify(body), {
    status,
    statusText,
    headers: { "content-type": "application/json" },
  });
}

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

Deno.test("workflows.cancel: posts to /runs/<id>/cancel, not /workflows/…", async () => {
  // The plausible near-miss: every other method on this class is
  // /workflows/-rooted. Asserted on the request the fake transport actually
  // received, never on a value `cancel()` returned.
  const c = client(() =>
    json({
      run: { id: "run_01HQ", status: "running", cancelRequestedAt: "2026-09-16T00:00:00.000Z" },
    })
  );

  await c.client.workflows.cancel("run_01HQ");

  assertEquals(c.calls.length, 1);
  assertEquals(c.calls[0].method, "POST");
  assertEquals(c.calls[0].url, "https://api.example.com/runs/run_01HQ/cancel");
  assertEquals(c.calls[0].body, null, "no request body");
});

Deno.test("workflows.cancel: unwraps the run envelope, not the workflow one", async () => {
  const run = { id: "run_01HQ", status: "queued", cancelRequestedAt: "2026-09-16T00:00:00.000Z" };
  const c = client(() => json({ run }));

  assertEquals(await c.client.workflows.cancel("run_01HQ"), run);
});

Deno.test("workflows.cancel: run id is percent-encoded into the path", async () => {
  // Encoding at interpolation, via the `path` tag — the same pin
  // `workflows.run`'s own id-encoding case is held to.
  const c = client(() =>
    json({ run: { id: "run_1", status: "queued", cancelRequestedAt: "2026-09-16T00:00:00.000Z" } })
  );

  await c.client.workflows.cancel("run a/b?x");

  assertEquals(c.calls[0].url, "https://api.example.com/runs/run%20a%2Fb%3Fx/cancel");
});

Deno.test("workflows.cancel: a 202 with status still 'running' or 'queued' is NOT reported canceled", async () => {
  // The server does not wait for the transition. The status field must be
  // carried through verbatim, never normalised to "canceled" by the wrapper.
  const running = client(() =>
    json({ run: { id: "run_1", status: "running", cancelRequestedAt: "2026-09-16T00:00:00.000Z" } })
  );
  const runningResult = await running.client.workflows.cancel("run_1");
  assertEquals(runningResult.status, "running");

  const queued = client(() =>
    json({ run: { id: "run_1", status: "queued", cancelRequestedAt: "2026-09-16T00:00:00.000Z" } })
  );
  const queuedResult = await queued.client.workflows.cancel("run_1");
  assertEquals(queuedResult.status, "queued");
});

Deno.test("workflows.cancel: repeating the call on a non-terminal run is still 202, idempotent", async () => {
  const c = client(() =>
    json({ run: { id: "run_1", status: "running", cancelRequestedAt: "2026-09-16T00:00:00.000Z" } })
  );

  const first = await c.client.workflows.cancel("run_1");
  const second = await c.client.workflows.cancel("run_1");

  assertEquals(first, second);
  assertEquals(c.calls.length, 2);
});

Deno.test("workflows.cancel: a 404 unknown_run reaches the caller as an ApiError", async () => {
  const c = client(() =>
    json({ error: { code: "unknown_run", message: "No such run." } }, 404, "Not Found")
  );

  const err = await assertRejects(() => c.client.workflows.cancel("run_missing"), ApiError);

  assertEquals(err.status, 404);
  assertEquals(err.code, "unknown_run");
  assertEquals(err.message, "No such run.");
});

Deno.test("workflows.cancel: a 409 run_not_cancelable reaches the caller as an ApiError", async () => {
  const c = client(() =>
    json(
      { error: { code: "run_not_cancelable", message: "Run has already finished." } },
      409,
      "Conflict",
    )
  );

  const err = await assertRejects(() => c.client.workflows.cancel("run_1"), ApiError);

  assertEquals(err.status, 409);
  assertEquals(err.code, "run_not_cancelable");
});
