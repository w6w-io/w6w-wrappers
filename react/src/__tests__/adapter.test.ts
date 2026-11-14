/**
 * `createW6WUiAdapter` — the `W6WApi` bridge (C-1, C-2).
 *
 * Every case here drives the adapter through a fake `fetch`, mirroring
 * `node/tests/console/apps_test.ts`'s pattern (read-only reference,
 * transcribed here, never imported).
 *
 * The one case below that is NOT about the adapter (`mod.ts`'s `"use
 * client"` pin) lives here rather than in a new file: this task's own
 * `inputs.touch` list names this file as the lane's only touchable existing
 * test file, and `mod.ts`'s directive has no other home within that scope.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
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

/**
 * `listAppsByIds`/`listAppsPage` are OPTIONAL on `W6WApi` (an older/imported
 * host may not implement them); `createW6WUiAdapter`'s own result always
 * provides both, so every case below asserts that once instead of a
 * non-null assertion per call site.
 */
function required<T>(fn: T | undefined): T {
  assert.ok(fn, "createW6WUiAdapter must implement this member");
  return fn;
}

/** A minimal, otherwise-valid `AppSummary` for a given id. */
function appFor(id: string) {
  return {
    id,
    displayName: id,
    version: "1.0.0",
    description: "",
    categories: [],
    sourceRef: "s",
    importedAt: "t",
  };
}

test("listAppsByIds: 150 distinct ids -> exactly 2 requests, each <= 100 ids, union of apps returned", async () => {
  const ids = Array.from({ length: 150 }, (_, i) => `app_${i}`);
  const fake = fakeFetch((call) => {
    const requested = new URL(call.url).searchParams.get("ids")?.split(",") ?? [];
    return json({ apps: requested.map(appFor) });
  });
  const adapter = createW6WUiAdapter(testClient(fake.fetch));

  const listAppsByIds = required(adapter.listAppsByIds);
  const apps = await listAppsByIds(ids);

  assert.equal(fake.calls.length, 2, "expected exactly 2 chunked requests");
  for (const call of fake.calls) {
    const chunkIds = new URL(call.url).searchParams.get("ids")?.split(",") ?? [];
    assert.ok(chunkIds.length <= 100, "each chunk must carry <= 100 ids");
  }
  assert.deepEqual(apps.map((a) => a.id).sort(), [...ids].sort());
});

test("listAppsByIds: duplicate ids collapse before chunking", async () => {
  const fake = fakeFetch((call) => {
    const requested = new URL(call.url).searchParams.get("ids")?.split(",") ?? [];
    return json({ apps: requested.map(appFor) });
  });
  const adapter = createW6WUiAdapter(testClient(fake.fetch));

  const listAppsByIds = required(adapter.listAppsByIds);
  const apps = await listAppsByIds(["app_1", "app_2", "app_1", "app_2"]);

  assert.equal(fake.calls.length, 1);
  assert.equal(new URL(fake.calls[0].url).searchParams.get("ids"), "app_1,app_2");
  assert.deepEqual(
    apps.map((a) => a.id),
    ["app_1", "app_2"],
  );
});

test("listAppsByIds: [] input -> 0 requests, resolves []", async () => {
  const fake = fakeFetch(() => json({ apps: [appFor("unexpected")] }));
  const adapter = createW6WUiAdapter(testClient(fake.fetch));

  const listAppsByIds = required(adapter.listAppsByIds);
  const apps = await listAppsByIds([]);

  assert.equal(fake.calls.length, 0, "an empty id set must issue NO request");
  assert.deepEqual(apps, []);
});

test("listAppsPage forwards every option and returns nextCursor", async () => {
  const fake = fakeFetch((call) => {
    const url = new URL(call.url);
    assert.equal(url.pathname, "/apps");
    assert.equal(url.searchParams.get("q"), "sendgrid");
    assert.equal(url.searchParams.get("category"), "email");
    assert.equal(url.searchParams.get("cursor"), "c1");
    assert.equal(url.searchParams.get("limit"), "40");
    assert.equal(url.searchParams.get("compact"), "true");
    return json({ apps: [appFor("app_1")], nextCursor: "c2" });
  });
  const adapter = createW6WUiAdapter(testClient(fake.fetch));

  const listAppsPage = required(adapter.listAppsPage);
  const page = await listAppsPage({
    q: "sendgrid",
    category: "email",
    cursor: "c1",
    limit: 40,
    compact: true,
  });

  assert.equal(fake.calls.length, 1);
  assert.deepEqual(
    page.apps.map((a) => a.id),
    ["app_1"],
  );
  assert.equal(page.nextCursor, "c2");
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

test("listWorkflows reaches the BASE GET /workflows", async () => {
  const wf = {
    id: "wf_1",
    key: null,
    name: "n",
    displayName: "N",
    description: "",
    status: "active",
    tags: [],
    runCount: 0,
    updatedAt: "t",
  };
  const fake = fakeFetch((call) => {
    assert.equal(call.url, "https://api.example.com/workflows");
    assert.equal(call.method, "GET");
    return json({ workflows: [wf] });
  });
  const adapter = createW6WUiAdapter(testClient(fake.fetch));

  const workflows = await adapter.listWorkflows();

  assert.deepEqual(
    workflows.map((w) => w.id),
    ["wf_1"],
  );
});

test("getWorkflow reaches GET /workflows/:id and reshapes the base definition into @w6w/ui's WorkflowDetail", async () => {
  const fake = fakeFetch((call) => {
    assert.equal(call.url, "https://api.example.com/workflows/wf_1");
    assert.equal(call.method, "GET");
    return json({
      workflow: {
        id: "wf_1",
        name: "n",
        displayName: "N",
        description: "d",
        steps: [
          { id: "trigger", uses: { app: "@w6w/webhook", action: "trigger" }, with: { a: 1 } },
        ],
      },
      sourceRef: null,
      updatedAt: "2026-01-01T00:00:00Z",
    });
  });
  const adapter = createW6WUiAdapter(testClient(fake.fetch));

  const detail = await adapter.getWorkflow("wf_1");

  assert.deepEqual(detail, {
    id: "wf_1",
    name: "n",
    displayName: "N",
    description: "d",
    steps: [{ id: "trigger", uses: { app: "@w6w/webhook", action: "trigger" }, with: { a: 1 } }],
  });
});

test("getWorkflow reaches GET /workflows/:id and reshapes the base definition into @w6w/ui's WorkflowDetail (nodes[] definition)", async () => {
  const fake = fakeFetch((call) => {
    assert.equal(call.url, "https://api.example.com/workflows/wf_1");
    assert.equal(call.method, "GET");
    return json({
      workflow: {
        id: "wf_1",
        name: "n",
        displayName: "N",
        description: "d",
        nodes: [
          { id: "trigger", uses: { app: "@w6w/webhook", action: "trigger" }, with: { a: 1 } },
        ],
      },
      sourceRef: null,
      updatedAt: "2026-01-01T00:00:00Z",
    });
  });
  const adapter = createW6WUiAdapter(testClient(fake.fetch));

  const detail = await adapter.getWorkflow("wf_1");

  assert.deepEqual(detail, {
    id: "wf_1",
    name: "n",
    displayName: "N",
    description: "d",
    steps: [{ id: "trigger", uses: { app: "@w6w/webhook", action: "trigger" }, with: { a: 1 } }],
  });
});

test("runWorkflow always sends ?wait=true and maps a 200 body to terminal: true", async () => {
  const fake = fakeFetch((call) => {
    const url = new URL(call.url);
    assert.equal(url.pathname, "/workflows/wf_1/run");
    assert.equal(url.searchParams.get("wait"), "true");
    assert.equal(call.method, "POST");
    assert.deepEqual(JSON.parse(call.body ?? "null"), { variables: { x: 1 } });
    return json({ runId: "run_1", status: "succeeded", output: { ok: true }, steps: {} }, 200);
  });
  const adapter = createW6WUiAdapter(testClient(fake.fetch));

  const result = await adapter.runWorkflow("wf_1", { variables: { x: 1 } });

  assert.equal(result.runId, "run_1");
  assert.equal(result.status, "succeeded");
  assert.deepEqual(result.output, { ok: true });
  assert.equal(result.terminal, true);
});

test("runWorkflow maps the server's 202 wait-timeout arm to terminal: false, carrying runId/status", async () => {
  const fake = fakeFetch(() => json({ runId: "run_2", status: "running" }, 202));
  const adapter = createW6WUiAdapter(testClient(fake.fetch));

  const result = await adapter.runWorkflow("wf_2");

  assert.equal(result.runId, "run_2");
  assert.equal(result.status, "running");
  assert.equal(result.terminal, false);
});

test("listFunctions reaches the BASE GET /functions", async () => {
  const fn = {
    id: "fn_1",
    key: "send-email",
    displayName: "Send email",
    description: "",
    updatedAt: "t",
    valid: true,
  };
  const fake = fakeFetch((call) => {
    assert.equal(call.url, "https://api.example.com/functions");
    assert.equal(call.method, "GET");
    return json({ functions: [fn] });
  });
  const adapter = createW6WUiAdapter(testClient(fake.fetch));

  const fns = await adapter.listFunctions();

  assert.deepEqual(
    fns.map((f) => f.id),
    ["fn_1"],
  );
});

test("getFunction reaches GET /functions/:id and reshapes the base definition into @w6w/ui's FunctionDetail", async () => {
  const fake = fakeFetch((call) => {
    assert.equal(call.url, "https://api.example.com/functions/fn_1");
    assert.equal(call.method, "GET");
    return json({
      function: {
        manifestVersion: "1",
        id: "fn_1",
        key: "send-email",
        displayName: "Send email",
        description: "d",
        inputs: [{ key: "to", label: "To", type: "string", required: true }],
        impl: { kind: "action", uses: { app: "sendgrid", action: "send" } },
      },
      valid: true,
    });
  });
  const adapter = createW6WUiAdapter(testClient(fake.fetch));

  const detail = await adapter.getFunction("fn_1");

  assert.deepEqual(detail, {
    id: "fn_1",
    key: "send-email",
    displayName: "Send email",
    description: "d",
    inputs: [{ key: "to", label: "To", type: "string", required: true }],
    valid: true,
  });
});

test("invokeFunction POSTs /functions/:id/invoke with body {inputs} via client.functions.run(id, {payload: inputs})", async () => {
  let capturedBody: unknown;
  const capturing: FetchLike = (input, init) => {
    assert.equal(input, "https://api.example.com/functions/fn_1/invoke");
    assert.equal(init?.method, "POST");
    capturedBody = typeof init?.body === "string" ? JSON.parse(init.body) : init?.body;
    return Promise.resolve(json({ output: { sent: true } }));
  };
  const adapter = createW6WUiAdapter(testClient(capturing));

  const result = await adapter.invokeFunction("fn_1", { to: "a@b.com" });

  assert.deepEqual(capturedBody, { inputs: { to: "a@b.com" } });
  assert.deepEqual(result, { sent: true });
});

test('mod.ts\'s first statement is "use client"; — above the doc comment, not below it', () => {
  const modPath = fileURLToPath(new URL("../../mod.ts", import.meta.url));
  const source = readFileSync(modPath, "utf8");
  const firstStatement = source.trimStart().split("\n", 1)[0]?.trim();
  assert.equal(
    firstStatement,
    '"use client";',
    'mod.ts must open with "use client"; as its first line, so the built ' +
      "dist/mod.js carries it as the directive prologue a bundler requires " +
      "it to be — a doc comment (or anything else) above it would move it " +
      "out of that position.",
  );
});

test("listAppsPage forwards snapshot/offset and returns the snapshot page fields", async () => {
  const fake = fakeFetch((call) => {
    const url = new URL(call.url);
    assert.equal(url.searchParams.get("snapshot"), "lsn_s");
    assert.equal(url.searchParams.get("offset"), "0");
    return json({
      apps: [appFor("app_1")],
      snapshot: "lsn_s",
      total: 7,
      offset: 0,
      limit: 50,
      expiresAt: "2026-10-16T01:00:00.000Z",
    });
  });
  const adapter = createW6WUiAdapter(testClient(fake.fetch));

  const page = await required(adapter.listAppsPage)({ snapshot: "lsn_s", offset: 0, limit: 50 });

  assert.equal(fake.calls.length, 1);
  assert.equal(page.snapshot, "lsn_s");
  assert.equal(page.total, 7);
  assert.equal(page.offset, 0);
  assert.equal(page.limit, 50);
  assert.equal(page.expiresAt, "2026-10-16T01:00:00.000Z");
});

test("listApps restarts once when the snapshot expires mid-walk and resolves only the restarted set", async () => {
  const fake = fakeFetch((_call, i) => {
    if (i === 0) return json({ apps: [appFor("app_1")], nextCursor: "c2" });
    if (i === 1) return json({ error: { code: "snapshot_expired", message: "gone" } }, 410);
    if (i === 2) return json({ apps: [appFor("app_1")], nextCursor: "d2" });
    if (i === 3) return json({ apps: [appFor("app_3")] });
    return json({ error: { code: "internal", message: "runaway" } }, 500);
  });
  const adapter = createW6WUiAdapter(testClient(fake.fetch));

  const apps = await adapter.listApps();

  assert.deepEqual(
    apps.map((a) => a.id),
    ["app_1", "app_3"],
  );
  assert.equal(fake.calls.length, 4);
});

const CRED = {
  id: "cred_1",
  name: "Ops",
  contract: "api_key",
  status: "active",
  revision: 1,
  display: {},
  private: false,
  connectionCount: 0,
  createdAt: "t",
  updatedAt: "t",
};
const CRED_BASE = "https://api.example.com/credentials";

test("listCredentials reaches GET /credentials with only the given filter keys", async () => {
  const fake = fakeFetch(() => json({ credentials: [CRED] }));
  const adapter = createW6WUiAdapter(testClient(fake.fetch));

  assert.deepEqual(await adapter.listCredentials(), [CRED]);
  await adapter.listCredentials({ appId: "gmail", authKey: "sa" });

  assert.equal(fake.calls[0].url, CRED_BASE);
  assert.equal(fake.calls[1].url, `${CRED_BASE}?appId=gmail&authKey=sa`);
});

test("createCredential reaches POST /credentials with the body verbatim", async () => {
  const fake = fakeFetch(() => json({ credential: CRED }, 201));
  const adapter = createW6WUiAdapter(testClient(fake.fetch));
  const body = { name: "Ops", contract: "api_key", source: { key: "k" } };

  assert.deepEqual(await adapter.createCredential(body), CRED);

  assert.equal(fake.calls[0].method, "POST");
  assert.equal(fake.calls[0].url, CRED_BASE);
  assert.equal(fake.calls[0].body, JSON.stringify(body));
});

test("getCredential reaches GET /credentials/:id (encoded)", async () => {
  const fake = fakeFetch(() => json({ credential: CRED }));
  const adapter = createW6WUiAdapter(testClient(fake.fetch));

  assert.deepEqual(await adapter.getCredential("cred/x"), CRED);

  assert.equal(fake.calls[0].method, "GET");
  assert.equal(fake.calls[0].url, `${CRED_BASE}/cred%2Fx`);
});

test("rotateCredential reaches POST /credentials/:id/rotate with {source} verbatim", async () => {
  const fake = fakeFetch(() => json({ credential: CRED }));
  const adapter = createW6WUiAdapter(testClient(fake.fetch));

  await adapter.rotateCredential("cred_1", { source: { key: "n" } });

  assert.equal(fake.calls[0].method, "POST");
  assert.equal(fake.calls[0].url, `${CRED_BASE}/cred_1/rotate`);
  assert.equal(fake.calls[0].body, '{"source":{"key":"n"}}');
});

test("setCredentialStatus('disabled') reaches POST /disable", async () => {
  const fake = fakeFetch(() => json({ credential: { ...CRED, status: "disabled" } }));
  const adapter = createW6WUiAdapter(testClient(fake.fetch));

  const res = await adapter.setCredentialStatus("cred_1", "disabled");

  assert.equal(res.status, "disabled");
  assert.equal(fake.calls[0].method, "POST");
  assert.equal(fake.calls[0].url, `${CRED_BASE}/cred_1/disable`);
});

test("setCredentialStatus('active') reaches POST /enable", async () => {
  const fake = fakeFetch(() => json({ credential: CRED }));
  const adapter = createW6WUiAdapter(testClient(fake.fetch));

  await adapter.setCredentialStatus("cred_1", "active");

  assert.equal(fake.calls[0].method, "POST");
  assert.equal(fake.calls[0].url, `${CRED_BASE}/cred_1/enable`);
});

test("testCredential reaches POST /credentials/:id/test and returns the whole body", async () => {
  const body = { ok: false, code: "credential_invalid", message: "bad" };
  const fake = fakeFetch(() => json(body));
  const adapter = createW6WUiAdapter(testClient(fake.fetch));

  assert.deepEqual(await adapter.testCredential("cred_1"), body);

  assert.equal(fake.calls[0].method, "POST");
  assert.equal(fake.calls[0].url, `${CRED_BASE}/cred_1/test`);
});

test("credentialDependents reaches GET /credentials/:id/dependents and unwraps", async () => {
  const deps = {
    connections: [{ id: "conn_1", appId: "gmail", authKey: "sa", displayName: "G" }],
  };
  const fake = fakeFetch(() => json({ dependents: deps }));
  const adapter = createW6WUiAdapter(testClient(fake.fetch));

  assert.deepEqual(await adapter.credentialDependents("cred_1"), deps);

  assert.equal(fake.calls[0].url, `${CRED_BASE}/cred_1/dependents`);
});

test("deleteCredential sends a bare DELETE; a 409 rejects with .body.error.dependents intact", async () => {
  const ok = fakeFetch(() => new Response(null, { status: 204 }));
  assert.equal(
    await createW6WUiAdapter(testClient(ok.fetch)).deleteCredential("cred_1"),
    undefined,
  );
  assert.equal(ok.calls[0].method, "DELETE");
  assert.equal(ok.calls[0].url, `${CRED_BASE}/cred_1`);

  const errorBody = {
    error: {
      code: "credential_in_use",
      message: "in use",
      dependents: {
        connections: [{ id: "conn_1", appId: "gmail", authKey: "sa" }],
      },
    },
  };
  const fake = fakeFetch(() => json(errorBody, 409));
  await assert.rejects(
    () => createW6WUiAdapter(testClient(fake.fetch)).deleteCredential("cred_1"),
    (err: unknown) => {
      const e = err as {
        status?: number;
        code?: string;
        body?: typeof errorBody;
      };
      assert.equal(e.status, 409);
      assert.equal(e.code, "credential_in_use");
      assert.equal(e.body?.error.dependents.connections[0].id, "conn_1");
      return true;
    },
  );
});

test("createConnection forwards an attach-by-id body verbatim", async () => {
  const fake = fakeFetch(() => json({ connection: { id: "conn_1" } }, 201));
  const adapter = createW6WUiAdapter(testClient(fake.fetch));
  const body = {
    authKey: "sa",
    credentialId: "cred_1",
    binding: { delegatedUser: "u@x.io" },
  };

  await adapter.createConnection("gmail", body);

  assert.equal(fake.calls[0].url, "https://api.example.com/apps/gmail/connections");
  assert.equal(fake.calls[0].body, JSON.stringify(body));
});

test("createConnection and startAppOAuthFlow forward autoRefresh verbatim", async () => {
  const fake = fakeFetch((call) =>
    call.url.endsWith("/authorize-url")
      ? json({ authorizationUrl: "https://w6w.example/oauth/start", state: "s", expiresIn: 300 })
      : json({ connection: { id: "conn_1", autoRefresh: false } }, 201),
  );
  const adapter = createW6WUiAdapter(testClient(fake.fetch));

  const created = await adapter.createConnection("gmail", {
    authKey: "apiKey",
    credential: { key: "k" },
    autoRefresh: false,
  });
  await adapter.startAppOAuthFlow("gmail", "oauth2", { displayName: "Work", autoRefresh: false });

  assert.equal(
    fake.calls[0].body,
    JSON.stringify({ authKey: "apiKey", credential: { key: "k" }, autoRefresh: false }),
  );
  assert.equal(created.autoRefresh, false);
  assert.equal(
    fake.calls[1].url,
    "https://api.example.com/apps/gmail/oauth-config/oauth2/authorize-url",
  );
  assert.equal(fake.calls[1].body, JSON.stringify({ displayName: "Work", autoRefresh: false }));
});
