/**
 * `createW6WUiAdapter` — the `W6WApi` bridge (C-1, C-2).
 *
 * Every case here drives the adapter through a fake `fetch`, mirroring
 * `node/tests/console/apps_test.ts`'s pattern (read-only reference,
 * transcribed here, never imported).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { FetchLike } from "@w6w/sdk";
import { W6WClient } from "@w6w/sdk";
import { createW6WUiAdapter } from "../adapter.ts";

/** One recorded call to the fake transport. */
interface Call {
  url: string;
  method: string | undefined;
  body: string | null;
}

function fakeFetch(respond: (call: Call, callIndex: number) => Response): {
  fetch: FetchLike;
  calls: Call[];
} {
  const calls: Call[] = [];
  const fetch: FetchLike = (input, init) => {
    const call: Call = {
      url: input,
      method: init?.method,
      body: typeof init?.body === "string" ? init.body : null,
    };
    calls.push(call);
    return Promise.resolve(respond(call, calls.length - 1));
  };
  return { fetch, calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function testClient(fetch: FetchLike): W6WClient {
  return new W6WClient({ baseUrl: "https://api.example.com", token: "tok_1", fetch });
}

test("listApps reaches the real console.apps.list() pass-through, spanning more than one page", async () => {
  const appOne = {
    id: "app_1",
    displayName: "One",
    version: "1.0.0",
    description: "",
    categories: [],
    sourceRef: "s",
    importedAt: "t",
  };
  const appTwo = {
    id: "app_2",
    displayName: "Two",
    version: "1.0.0",
    description: "",
    categories: [],
    sourceRef: "s",
    importedAt: "t",
  };
  const fake = fakeFetch((_call, i) =>
    i === 0 ? json({ apps: [appOne], nextCursor: "cursor_2" }) : json({ apps: [appTwo] }),
  );
  const adapter = createW6WUiAdapter(testClient(fake.fetch));

  const apps = await adapter.listApps();

  assert.equal(fake.calls.length, 2, "expected one request per page");
  assert.deepEqual(
    apps.map((a) => a.id),
    ["app_1", "app_2"],
  );
});

test("a thrown ApiError gains a `.body` alias of `.raw` (one shared helper, every member)", async () => {
  const errorBody = { error: { code: "unknown_app", message: "no such app" } };
  const fake = fakeFetch(() => json(errorBody, 404));
  const adapter = createW6WUiAdapter(testClient(fake.fetch));

  await assert.rejects(
    () => adapter.getAppAuth("app_missing"),
    (err: unknown) => {
      assert.ok(err && typeof err === "object");
      const e = err as { body?: unknown; raw?: unknown; status?: number; name?: string };
      assert.deepEqual(e.body, errorBody);
      assert.equal(e.body, e.raw, ".body must be the SAME reference as .raw, not a copy");
      assert.equal(e.status, 404);
      assert.equal(e.name, "ApiError");
      return true;
    },
  );
});

test("recordTestRun discards the SDK's real created row to void, per the W6WApi contract", async () => {
  const fake = fakeFetch(() =>
    json(
      {
        run: {
          id: "run_1",
          savedTestId: null,
          connectionId: "conn_1",
          appId: "a",
          actionKey: "k",
          ok: true,
          summary: null,
          result: null,
          createdAt: "t",
        },
      },
      201,
    ),
  );
  const adapter = createW6WUiAdapter(testClient(fake.fetch));

  const result = await adapter.recordTestRun("conn_1", { actionKey: "k", ok: true });

  assert.equal(result, undefined);
});

test("listConnections calls the BASE /connections route, not console.connections", async () => {
  const fake = fakeFetch((call) => {
    assert.equal(call.url, "https://api.example.com/connections");
    return json({ connections: [] });
  });
  const adapter = createW6WUiAdapter(testClient(fake.fetch));

  await adapter.listConnections();

  assert.equal(fake.calls.length, 1);
});

test("invokeAction forwards the WHOLE opts object (connectionId, project, state)", async () => {
  let capturedBody: unknown;
  const capturing: FetchLike = (_input, init) => {
    capturedBody = typeof init?.body === "string" ? JSON.parse(init.body) : init?.body;
    return Promise.resolve(json({ value: "ok" }));
  };
  const adapter = createW6WUiAdapter(testClient(capturing));

  await adapter.invokeAction(
    "app_1",
    "send",
    { to: "a@b.com" },
    {
      connectionId: "conn_1",
      project: "proj_1",
      state: { trigger: { event: { x: 1 } } },
    },
  );

  assert.deepEqual(capturedBody, {
    params: { to: "a@b.com" },
    connectionId: "conn_1",
    project: "proj_1",
    state: { trigger: { event: { x: 1 } } },
  });
});

test("listTriggerApps filters to apps whose triggerCount is truthy — absent and 0 both excluded", async () => {
  const base = {
    displayName: "d",
    version: "1.0.0",
    description: "",
    categories: [],
    sourceRef: "s",
    importedAt: "t",
  };
  const appWithTwo = { ...base, id: "app_with_two", triggerCount: 2 };
  const appWithZero = { ...base, id: "app_with_zero", triggerCount: 0 };
  const appAbsent = { ...base, id: "app_absent" };
  const fake = fakeFetch(() => json({ apps: [appWithTwo, appWithZero, appAbsent] }));
  const adapter = createW6WUiAdapter(testClient(fake.fetch));

  const apps = await adapter.listTriggerApps();

  assert.deepEqual(
    apps.map((a) => a.id),
    ["app_with_two"],
  );
});

test("getAppTriggers reaches GET /apps/:id/triggers", async () => {
  const trigger = { key: "new-message", title: "New message" };
  const fake = fakeFetch((call) => {
    assert.equal(call.url, "https://api.example.com/apps/app_x/triggers");
    assert.equal(call.method, "GET");
    return json({ triggers: [trigger] });
  });
  const adapter = createW6WUiAdapter(testClient(fake.fetch));

  const triggers = await adapter.getAppTriggers("app_x");

  assert.deepEqual(triggers, [trigger]);
});

test("listSubscriptionsForWorkflow reaches GET /workflows/:id/subscriptions", async () => {
  const fake = fakeFetch((call) => {
    assert.equal(call.url, "https://api.example.com/workflows/wf_1/subscriptions");
    assert.equal(call.method, "GET");
    return json({ subscriptions: [] });
  });
  const adapter = createW6WUiAdapter(testClient(fake.fetch));

  const subs = await adapter.listSubscriptionsForWorkflow("wf_1");

  assert.deepEqual(subs, []);
});

test("createSubscription forwards `input` verbatim to POST /apps/:id/triggers/:key/subscriptions", async () => {
  const fake = fakeFetch((call) => {
    assert.equal(call.url, "https://api.example.com/apps/app_x/triggers/new-message/subscriptions");
    assert.equal(call.method, "POST");
    assert.deepEqual(JSON.parse(call.body ?? "null"), {
      workflowId: "wf_1",
      connectionId: null,
      params: { a: 1 },
    });
    return json(
      {
        subscription: {
          id: "sub_1",
          appId: "app_x",
          triggerKey: "new-message",
          connectionId: null,
          workflowId: "wf_1",
          params: { a: 1 },
          state: {},
          enabled: true,
          createdAt: "t",
          updatedAt: "t",
        },
      },
      201,
    );
  });
  const adapter = createW6WUiAdapter(testClient(fake.fetch));

  const sub = await adapter.createSubscription("app_x", "new-message", {
    workflowId: "wf_1",
    connectionId: null,
    params: { a: 1 },
  });

  assert.equal(sub.id, "sub_1");
});
