/**
 * `client.console.stepTests.*`, against an injected fake `fetch`.
 *
 * No case here needs a live server (`docs/implementation.md` §9). Beyond the
 * per-operation envelope assertions (`save`/`list` unwrap), the case that
 * matters most is `recordRun`'s asymmetry with every prior console `delete`
 * in this package: `recordRun` unwraps `run` and RETURNS the real row, it
 * does not discard it to `void`.
 */

import { assertEquals, assertRejects } from "@std/assert";
import { W6WClient } from "../../src/client.ts";
import type { FetchLike } from "../../src/config.ts";
import { ApiError } from "../../src/errors.ts";
import type { StepTest, StepTestRun } from "../../src/console/step-tests.ts";

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

const STEP_TEST_A: StepTest = {
  id: "stept_1",
  workflowId: "wf_1",
  stepId: "nd_1",
  name: "Happy path",
  input: { foo: "bar" },
  with: { to: "a@b.com" },
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
  lastRunAt: null,
  lastRunStatus: null,
  lastRunError: null,
  lastRunOutput: null,
};

const STEP_TEST_B: StepTest = {
  id: "stept_2",
  workflowId: "wf_1",
  stepId: "nd_1",
  name: null,
  input: {},
  with: {},
  createdAt: "2026-08-02T00:00:00.000Z",
  updatedAt: "2026-08-02T00:00:00.000Z",
  lastRunAt: "2026-08-09T00:00:00.000Z",
  lastRunStatus: "failed",
  lastRunError: { message: "boom" },
  lastRunOutput: null,
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
  "console.stepTests: save/list/recordRun are functions on a constructed client",
  () => {
    // Runtime, not type-level: a namespace that silently lost a method would
    // still typecheck everywhere else in this suite.
    const c = new W6WClient({ baseUrl: "https://api.example.com", token: "t" });
    assertEquals(typeof c.console.stepTests.save, "function");
    assertEquals(typeof c.console.stepTests.list, "function");
    assertEquals(typeof c.console.stepTests.recordRun, "function");
  },
);

Deno.test("console.stepTests.save sends the body verbatim and unwraps the stepTest envelope", async () => {
  const c = client(() => json({ stepTest: STEP_TEST_A }, 201));

  const res = await c.client.console.stepTests.save("wf_1", "nd_1", {
    name: "Happy path",
    input: { foo: "bar" },
    with: { to: "a@b.com" },
  });

  assertEquals(res, STEP_TEST_A);
  assertEquals(c.calls[0].method, "POST");
  assertEquals(c.calls[0].url, "https://api.example.com/workflows/wf_1/steps/nd_1/tests");
  // No extra keys injected — the body IS exactly the input.
  assertEquals(JSON.parse(c.calls[0].body ?? "null"), {
    name: "Happy path",
    input: { foo: "bar" },
    with: { to: "a@b.com" },
  });
});

Deno.test("console.stepTests.save propagates a 404 as ApiError", async () => {
  const c = client(() => json({ error: { code: "unknown_workflow", message: "Not found." } }, 404));

  const err = await assertRejects(
    () => c.client.console.stepTests.save("wf_missing", "nd_1", { input: {}, with: {} }),
    ApiError,
  );

  assertEquals(err.status, 404);
  assertEquals(err.code, "unknown_workflow");
});

Deno.test("console.stepTests.list unwraps the stepTests envelope", async () => {
  const c = client(() => json({ stepTests: [STEP_TEST_A, STEP_TEST_B] }));

  const res = await c.client.console.stepTests.list("wf_1", "nd_1");

  // A mutant that forgot to call unwrap() would resolve the envelope object
  // itself, not the array it wraps.
  assertEquals(res, [STEP_TEST_A, STEP_TEST_B]);
  assertEquals(c.calls[0].method, "GET");
  assertEquals(c.calls[0].url, "https://api.example.com/workflows/wf_1/steps/nd_1/tests");
});

Deno.test(
  "console.stepTests.recordRun unwraps `run` and RETURNS the real row — does not discard to void",
  async () => {
    const RUN: StepTestRun = {
      id: "steprun_1",
      stepTestId: "stept_1",
      workflowId: "wf_1",
      stepId: "nd_1",
      status: "succeeded",
      input: { foo: "bar" },
      output: { ok: true },
      error: null,
      createdAt: "2026-01-01T00:00:00Z",
    };
    const c = client(() => json({ run: RUN }, 201));

    const run = await c.client.console.stepTests.recordRun("wf_1", "nd_1", {
      stepTestId: "stept_1",
      status: "succeeded",
      output: { ok: true },
    });

    // A mutant that discarded this to void would resolve undefined here
    // instead of the real row.
    assertEquals(run.id, "steprun_1");
    assertEquals(run.status, "succeeded");
    assertEquals(run.stepTestId, "stept_1");
    assertEquals(c.calls[0].method, "POST");
    assertEquals(c.calls[0].url, "https://api.example.com/workflows/wf_1/steps/nd_1/test-runs");
  },
);

Deno.test("console.stepTests.recordRun sends the body verbatim, no extra keys injected", async () => {
  const c = client(() =>
    json(
      {
        run: {
          id: "steprun_1",
          stepTestId: null,
          workflowId: "wf_1",
          stepId: "nd_1",
          status: "succeeded",
          input: null,
          output: null,
          error: null,
          createdAt: "2026-01-01T00:00:00Z",
        },
      },
      201,
    )
  );

  await c.client.console.stepTests.recordRun("wf_1", "nd_1", { status: "succeeded" });

  assertEquals(JSON.parse(c.calls[0].body ?? "null"), { status: "succeeded" });
});

Deno.test("console.stepTests.save percent-encodes workflowId and stepId via the `path` tag", async () => {
  const c = client(() => json({ stepTest: STEP_TEST_A }, 201));

  await c.client.console.stepTests.save("wf 1", "nd 1", { input: {}, with: {} });

  assertEquals(
    c.calls[0].url,
    "https://api.example.com/workflows/wf%201/steps/nd%201/tests",
  );
});

Deno.test("console.stepTests.list percent-encodes workflowId and stepId via the `path` tag", async () => {
  const c = client(() => json({ stepTests: [] }));

  await c.client.console.stepTests.list("wf 1", "nd 1");

  assertEquals(
    c.calls[0].url,
    "https://api.example.com/workflows/wf%201/steps/nd%201/tests",
  );
});
