/**
 * `client.console.subscriptions.*`, against an injected fake `fetch`.
 *
 * No case here needs a live server (`docs/implementation.md` §9). Cases below
 * are organized by the mutant class each discriminates: envelope unwrap
 * (`list`/`listForWorkflow`/`get`/`create`/`listEvents` all carry an envelope
 * key), body-and-path-segment forwarding (`create`), discard-to-`void`
 * (`delete`/`requeueEvent`), a genuine `ApiError` propagation on `requeueEvent`
 * (not a swallowed success), and path-segment encoding.
 *
 * Four of the seven methods (`listForWorkflow`, `get`, `listEvents`,
 * `requeueEvent`) have zero call sites anywhere in studio or `@w6w/ui`
 * (HITL-4) — they get their full wire-shape assertion here same as the other
 * three, but no further exhaustive edge-case battery, per the contract's
 * lighter bar for dead code.
 */

import { assertEquals, assertRejects } from "@std/assert";
import { W6wClient } from "../../src/client.ts";
import type { FetchLike } from "../../src/config.ts";
import { ApiError } from "../../src/errors.ts";
import type { Subscription, TriggerEventSummary } from "../../src/console/subscriptions.ts";

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

const SUB_A: Subscription = {
  id: "sub_1",
  appId: "app_x",
  triggerKey: "new-message",
  connectionId: "conn_1",
  workflowId: "wf_1",
  params: { a: 1 },
  state: {},
  enabled: true,
  createdAt: "2026-08-09T12:00:00.000Z",
  updatedAt: "2026-08-09T12:00:00.000Z",
};

const SUB_B: Subscription = {
  ...SUB_A,
  id: "sub_2",
  connectionId: null,
};

const EVENT: TriggerEventSummary = {
  id: "evt_1",
  subscriptionId: "sub_1",
  status: "failed",
  attempts: 1,
  receivedAt: "2026-08-09T12:00:00.000Z",
  dispatchedAt: null,
  runId: null,
};

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

Deno.test(
  "console.subscriptions: list/listForWorkflow/get/create/delete/listEvents/requeueEvent are functions on a constructed client",
  () => {
    // Runtime, not type-level: a namespace that silently lost a method would
    // still typecheck everywhere else in this suite. Covers the 4
    // zero-caller methods' lighter test bar (presence + wire-shape below).
    const c = new W6wClient({ baseUrl: "https://api.example.com", token: "t" });
    assertEquals(typeof c.console.subscriptions.list, "function");
    assertEquals(typeof c.console.subscriptions.listForWorkflow, "function");
    assertEquals(typeof c.console.subscriptions.get, "function");
    assertEquals(typeof c.console.subscriptions.create, "function");
    assertEquals(typeof c.console.subscriptions.delete, "function");
    assertEquals(typeof c.console.subscriptions.listEvents, "function");
    assertEquals(typeof c.console.subscriptions.requeueEvent, "function");
  },
);

Deno.test("console.subscriptions.list unwraps the `subscriptions` envelope", async () => {
  const c = client(() => json({ subscriptions: [SUB_A, SUB_B] }));

  const res = await c.client.console.subscriptions.list();

  // A mutant that returned the envelope directly (forgot `unwrap()`) would
  // fail this assertion — it would see `{subscriptions: [...]}`, not the array.
  assertEquals(res, [SUB_A, SUB_B]);
  assertEquals(c.calls[0].method, "GET");
  assertEquals(c.calls[0].url, "https://api.example.com/subscriptions");
});

Deno.test(
  "console.subscriptions.listForWorkflow sends the right path and unwraps the `subscriptions` envelope",
  async () => {
    const c = client(() => json({ subscriptions: [SUB_A] }));

    const res = await c.client.console.subscriptions.listForWorkflow("wf_1");

    assertEquals(res, [SUB_A]);
    assertEquals(c.calls[0].method, "GET");
    assertEquals(c.calls[0].url, "https://api.example.com/workflows/wf_1/subscriptions");
  },
);

Deno.test("console.subscriptions.get unwraps the `subscription` envelope", async () => {
  const c = client(() => json({ subscription: SUB_A }));

  const res = await c.client.console.subscriptions.get("sub_1");

  assertEquals(res, SUB_A);
  assertEquals(c.calls[0].method, "GET");
  assertEquals(c.calls[0].url, "https://api.example.com/subscriptions/sub_1");
});

Deno.test("console.subscriptions.get throws ApiError on a 404, no null-coalescing", async () => {
  const c = client(() =>
    json({ error: { code: "unknown_subscription", message: "No such subscription." } }, 404)
  );

  const err = await assertRejects(
    () => c.client.console.subscriptions.get("sub_missing"),
    ApiError,
  );

  assertEquals(err.status, 404);
  assertEquals(err.code, "unknown_subscription");
});

Deno.test(
  "console.subscriptions.create sends the right path segments and body, unwraps the `subscription` envelope",
  async () => {
    const c = client(() => json({ subscription: SUB_A }, 201));

    const res = await c.client.console.subscriptions.create("app_x", "new-message", {
      workflowId: "wf_1",
      connectionId: null,
      params: { a: 1 },
    });

    assertEquals(res, SUB_A);
    assertEquals(c.calls[0].method, "POST");
    assertEquals(
      c.calls[0].url,
      "https://api.example.com/apps/app_x/triggers/new-message/subscriptions",
    );
    assertEquals(JSON.parse(c.calls[0].body ?? "null"), {
      workflowId: "wf_1",
      connectionId: null,
      params: { a: 1 },
    });
  },
);

Deno.test(
  "console.subscriptions.create percent-encodes both appId and triggerKey via the `path` tag",
  async () => {
    const c = client(() => json({ subscription: SUB_A }, 201));

    await c.client.console.subscriptions.create("app/x", "new message", { workflowId: "wf_1" });

    assertEquals(
      c.calls[0].url,
      "https://api.example.com/apps/app%2Fx/triggers/new%20message/subscriptions",
    );
  },
);

Deno.test(
  "console.subscriptions.delete sends DELETE to the right path and resolves void, discarding {ok:true}",
  async () => {
    const c = client(() => json({ ok: true }));

    const res = await c.client.console.subscriptions.delete("sub_1");

    assertEquals(res, undefined);
    assertEquals(c.calls[0].method, "DELETE");
    assertEquals(c.calls[0].url, "https://api.example.com/subscriptions/sub_1");
  },
);

Deno.test(
  "console.subscriptions.delete percent-encodes the id via the `path` tag, not string concatenation",
  async () => {
    const c = client(() => json({ ok: true }));

    await c.client.console.subscriptions.delete("sub/1");

    assertEquals(c.calls[0].url, "https://api.example.com/subscriptions/sub%2F1");
  },
);

Deno.test(
  "console.subscriptions.listEvents sends the right path and unwraps the `events` envelope",
  async () => {
    const c = client(() => json({ events: [EVENT] }));

    const res = await c.client.console.subscriptions.listEvents("sub_1");

    assertEquals(res, [EVENT]);
    assertEquals(c.calls[0].method, "GET");
    assertEquals(c.calls[0].url, "https://api.example.com/subscriptions/sub_1/events");
  },
);

Deno.test(
  "console.subscriptions.requeueEvent sends POST to the right path and resolves void, discarding {ok:true}",
  async () => {
    const c = client(() => json({ ok: true }));

    const res = await c.client.console.subscriptions.requeueEvent("evt_1");

    assertEquals(res, undefined);
    assertEquals(c.calls[0].method, "POST");
    assertEquals(c.calls[0].url, "https://api.example.com/trigger-events/evt_1/requeue");
  },
);

Deno.test(
  "console.subscriptions.requeueEvent propagates a 404 requeue_failed as ApiError, not a swallowed success",
  async () => {
    const c = client(() =>
      json(
        {
          error: { code: "requeue_failed", message: "Event not found or not in `failed` status." },
        },
        404,
      )
    );

    const err = await assertRejects(
      () => c.client.console.subscriptions.requeueEvent("evt_x"),
      ApiError,
    );

    assertEquals(err.status, 404);
    assertEquals(err.code, "requeue_failed");
  },
);
