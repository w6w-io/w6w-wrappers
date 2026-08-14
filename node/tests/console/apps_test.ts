/**
 * `client.console.apps.*`, against an injected fake `fetch`.
 *
 * No case here needs a live server (`docs/implementation.md` §9). This is the
 * largest console domain (16 methods) and the cases below are organized by
 * the mutant class each discriminates, per this task's contract test plan:
 * pagination-loop correctness, "three reads of one `GET /apps/:id` call",
 * envelope unwrap vs. no-envelope passthrough, the one deliberate
 * non-`void` `delete`, body-forwarding, and path-segment encoding.
 *
 * The four HITL-4 dead-code methods (`getHealth`, `listOAuthConfig`,
 * `upsertOAuthConfig`, `deleteOAuthConfig`) get one wire-shape assertion
 * each — no exhaustive edge-case coverage, per the contract's lighter bar
 * for code with zero call sites anywhere in studio or `@w6w/ui`.
 */

import { assertEquals } from "@std/assert";
import { W6WClient } from "../../src/client.ts";
import type { FetchLike } from "../../src/config.ts";
import type {
  ActionDef,
  AppDetail,
  AppHealthStatus,
  AppSummary,
  AuthDef,
  HealthCheckMeta,
  ImportResponse,
  OAuthConfigSummary,
  PreviewSourceResponse,
  RefreshAppResponse,
  TriggerDef,
} from "../../src/console/apps.ts";

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

const APP_A: AppSummary = {
  id: "app_1",
  displayName: "Sendgrid",
  version: "1.0.0",
  description: "Email API",
  categories: ["email"],
  sourceRef: "github:w6w-io/sendgrid",
  importedAt: "2026-07-01T00:00:00.000Z",
};

const APP_B: AppSummary = {
  id: "app_2",
  displayName: "Eventbrite",
  version: "2.1.0",
  description: "Events API",
  categories: ["events"],
  sourceRef: "github:w6w-io/eventbrite",
  importedAt: "2026-07-02T00:00:00.000Z",
};

const ACTION_A: ActionDef = { key: "send", type: "action", title: "Send Email" };
const HEALTH_A: HealthCheckMeta = { key: "ping", title: "Ping", kind: "service" };
const AUTH_A: AuthDef = { key: "oauth2", type: "oauth2", displayName: "OAuth2" };
const TRIGGER_A: TriggerDef = { key: "new-email", title: "New Email" };

const APP_DETAIL: AppDetail = {
  app: { displayName: "Sendgrid" },
  actions: [ACTION_A],
  health: [HEALTH_A],
  sourceRef: "github:w6w-io/sendgrid",
  version: "1.0.0",
  digest: "digest123",
  versionCount: 3,
  overlay: {},
  effective: { maturity: "stable", visibility: "public" },
};

const CONFIG_A: OAuthConfigSummary = {
  appId: "app_1",
  authKey: "oauth2",
  clientId: "client_1",
  redirectUri: "https://app.example.com/callback",
  hasClientSecret: true,
  extra: {},
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-01T00:00:00.000Z",
};

Deno.test("console.apps: all 16 methods are functions on a freshly constructed client", () => {
  // Runtime, not type-level: a namespace that silently lost a method would
  // still typecheck everywhere else in this suite.
  const c = new W6WClient({ baseUrl: "https://api.example.com", token: "t" });
  const methods = [
    "list",
    "get",
    "getAuth",
    "getActions",
    "getTriggers",
    "getHealth",
    "getHealthStatus",
    "listOAuthConfig",
    "upsertOAuthConfig",
    "deleteOAuthConfig",
    "startOAuthFlow",
    "preview",
    "import",
    "refresh",
    "invoke",
    "delete",
  ] as const;
  for (const m of methods) {
    assertEquals(typeof c.console.apps[m], "function", `console.apps.${m} should be a function`);
  }
});

// --- list(): pagination loop ------------------------------------------------

Deno.test("console.apps.list follows nextCursor across pages and merges the results", async () => {
  const c = client((call) => {
    const cursor = new URL(call.url).searchParams.get("cursor");
    if (cursor === "c2") return json({ apps: [APP_B] });
    return json({ apps: [APP_A], nextCursor: "c2" });
  });

  const res = await c.client.console.apps.list();

  // A mutant that forgot to loop, or forgot to forward the cursor, would fail
  // here: either only [APP_A] resolves, or the second call never carries
  // cursor=c2 and the server (per this mock) answers page 1 again forever.
  assertEquals(res, [APP_A, APP_B]);
  assertEquals(c.calls.length, 2);
  assertEquals(c.calls[0].method, "GET");
  assertEquals(c.calls[1].url.includes("cursor=c2"), true);
});

Deno.test("console.apps.list stops when the server sends no nextCursor", async () => {
  const c = client(() => json({ apps: [APP_A] }));

  const res = await c.client.console.apps.list();

  assertEquals(res, [APP_A]);
  assertEquals(c.calls.length, 1);
});

Deno.test(
  "console.apps.list carries supportsOAuth and owner through untouched",
  async () => {
    // The server always sends both (`api/wire-summary.ts:81` computes
    // `supportsOAuth`; `owner` at `:57` has shipped since T2.2). `list` must
    // pass the summaries through, not project a field list of its own — a
    // mutant that re-mapped each page would drop exactly these two.
    const GLOBAL: AppSummary = {
      ...APP_A,
      supportsOAuth: true,
      owner: { tenant: "", subject: "" },
    };
    const TENANT_OWNED: AppSummary = {
      ...APP_B,
      supportsOAuth: false,
      owner: { tenant: "ten_1", subject: "" },
    };
    const USER_OWNED: AppSummary = {
      ...APP_B,
      id: "app_3",
      supportsOAuth: true,
      owner: { tenant: "ten_1", subject: "usr_1" },
    };
    const c = client(() => json({ apps: [GLOBAL, TENANT_OWNED, USER_OWNED] }));

    const res = await c.client.console.apps.list();

    assertEquals(res, [GLOBAL, TENANT_OWNED, USER_OWNED]);
    // The sentinel semantics the doc comment states, exercised over real
    // values: only an app with an EMPTY `owner.tenant` is global, and the
    // tenant OAuth route accepts nothing else.
    assertEquals(
      res.filter((a) => a.owner?.tenant === "" && a.supportsOAuth).map((a) => a.id),
      ["app_1"],
    );
  },
);

Deno.test("AppSummary's two new fields are OPTIONAL — an older host still satisfies it", () => {
  // APP_A/APP_B above already carry neither field; this states the rule the
  // rest of the suite depends on out loud, and would fail to COMPILE (not to
  // run) the moment either field were declared required.
  const _older: AppSummary = {
    id: "app_9",
    displayName: "Legacy",
    version: "0.1.0",
    description: "",
    categories: [],
    sourceRef: "file:./legacy",
    importedAt: "2026-07-01T00:00:00.000Z",
  };
  assertEquals(_older.supportsOAuth, undefined);
  assertEquals(_older.owner, undefined);
});

// --- get / getActions / getHealth: three reads of one GET /apps/:id --------

Deno.test("console.apps.get resolves the WHOLE AppDetail body", async () => {
  const c = client(() => json(APP_DETAIL));

  const res = await c.client.console.apps.get("app_1");

  assertEquals(res, APP_DETAIL);
  assertEquals(c.calls[0].method, "GET");
  assertEquals(c.calls[0].url, "https://api.example.com/apps/app_1");
});

Deno.test("console.apps.getActions resolves ONLY the actions array, not the whole body", async () => {
  const c = client(() => json(APP_DETAIL));

  const res = await c.client.console.apps.getActions("app_1");

  assertEquals(res, [ACTION_A]);
});

Deno.test("console.apps.getHealth resolves ONLY the health array, not the whole body", async () => {
  const c = client(() => json(APP_DETAIL));

  const res = await c.client.console.apps.getHealth("app_1");

  assertEquals(res, [HEALTH_A]);
});

// --- getAuth / getTriggers: envelope unwrap ---------------------------------

Deno.test("console.apps.getAuth unwraps the auths envelope", async () => {
  const c = client(() => json({ auths: [AUTH_A] }));

  const res = await c.client.console.apps.getAuth("app_1");

  // A mutant that skipped unwrap() would see the envelope object, not the array.
  assertEquals(res, [AUTH_A]);
  assertEquals(c.calls[0].url, "https://api.example.com/apps/app_1/auths");
});

Deno.test("console.apps.getTriggers unwraps the triggers envelope", async () => {
  const c = client(() => json({ triggers: [TRIGGER_A] }));

  const res = await c.client.console.apps.getTriggers("app_1");

  assertEquals(res, [TRIGGER_A]);
  assertEquals(c.calls[0].url, "https://api.example.com/apps/app_1/triggers");
});

// --- no-envelope passthrough -------------------------------------------------

Deno.test("console.apps.getHealthStatus resolves the body verbatim — no unwrap()", async () => {
  const body: AppHealthStatus = { state: "ok", attributedTo: [], results: [] };
  const c = client(() => json(body));

  const res = await c.client.console.apps.getHealthStatus("app_1");

  assertEquals(res, body);
  assertEquals(c.calls[0].url, "https://api.example.com/apps/app_1/health");
});

Deno.test("console.apps.startOAuthFlow resolves the body verbatim — no unwrap()", async () => {
  const body = {
    authorizationUrl: "https://provider.example.com/authorize",
    state: "s1",
    expiresIn: 600,
  };
  const c = client(() => json(body));

  const res = await c.client.console.apps.startOAuthFlow("app_1", "oauth2");

  assertEquals(res, body);
  assertEquals(
    c.calls[0].url,
    "https://api.example.com/apps/app_1/oauth-config/oauth2/authorize-url",
  );
});

Deno.test("console.apps.preview resolves the body verbatim — kind: app", async () => {
  const body: PreviewSourceResponse = {
    kind: "app",
    sourceRef: "github:org/app",
    app: { id: "app_x", version: "1.0.0", displayName: "X" },
  };
  const c = client(() => json(body));

  const res = await c.client.console.apps.preview("github:org/app");

  assertEquals(res, body);
});

Deno.test("console.apps.preview resolves the body verbatim — kind: pack", async () => {
  const body: PreviewSourceResponse = {
    kind: "pack",
    sourceRef: "github:org/pack",
    pack: { name: "pack", count: 1 },
    entries: [{ path: "a", alreadyRegistered: false }],
  };
  const c = client(() => json(body));

  const res = await c.client.console.apps.preview("github:org/pack");

  assertEquals(res, body);
});

Deno.test("console.apps.import resolves the body verbatim — kind: app", async () => {
  const body: ImportResponse = {
    kind: "app",
    sourceRef: "github:org/app",
    app: { id: "app_x" },
    actions: [ACTION_A],
    registered: true,
    latestAdvanced: true,
  };
  const c = client(() => json(body, 201));

  const res = await c.client.console.apps.import("github:org/app");

  assertEquals(res, body);
});

Deno.test("console.apps.import resolves the body verbatim — kind: pack", async () => {
  const body: ImportResponse = {
    kind: "pack",
    sourceRef: "github:org/pack",
    pack: { name: "pack", count: 1 },
    registered: 1,
    failed: 0,
    results: [
      {
        path: "a",
        ok: true,
        id: "app_a",
        version: "1.0.0",
        registered: true,
        latestAdvanced: true,
      },
    ],
  };
  const c = client(() => json(body, 201));

  const res = await c.client.console.apps.import("github:org/pack");

  assertEquals(res, body);
});

Deno.test("console.apps.refresh resolves the body verbatim — no unwrap()", async () => {
  const body: RefreshAppResponse = {
    app: { id: "app_1" },
    actions: [ACTION_A],
    sourceRef: "github:org/app",
    version: "1.0.1",
    digest: "digest456",
    registered: true,
    latestAdvanced: true,
    bumped: false,
    sourceVersion: "1.0.1",
  };
  const c = client(() => json(body));

  const res = await c.client.console.apps.refresh("app_1");

  assertEquals(res, body);
});

Deno.test("console.apps.invoke resolves the body verbatim — no unwrap()", async () => {
  const body = {
    value: { ok: true },
    logs: ["step 1"],
    apiCalls: [{ host: "api.sendgrid.com", method: "POST", status: 200 }],
  };
  const c = client(() => json(body));

  const res = await c.client.console.apps.invoke("app_1", "send", { to: "a@b.com" });

  assertEquals(res, body);
});

// --- delete: returns the REAL value, not void -------------------------------

Deno.test("console.apps.delete resolves {removed}, NOT undefined — the one delete asymmetry", async () => {
  const c = client(() => json({ removed: 3 }));

  const res = await c.client.console.apps.delete("app_1");

  assertEquals(res, { removed: 3 });
  assertEquals(c.calls[0].method, "DELETE");
});

// --- HITL-4 dead-code methods: one wire-shape assertion each ----------------

Deno.test("console.apps.listOAuthConfig unwraps the configs envelope", async () => {
  const c = client(() => json({ configs: [CONFIG_A] }));

  const res = await c.client.console.apps.listOAuthConfig("app_1");

  assertEquals(res, [CONFIG_A]);
  assertEquals(c.calls[0].url, "https://api.example.com/apps/app_1/oauth-config");
});

Deno.test("console.apps.upsertOAuthConfig unwraps the config envelope", async () => {
  const c = client(() => json({ config: CONFIG_A }, 201));

  const res = await c.client.console.apps.upsertOAuthConfig("app_1", "oauth2", {
    clientId: "id",
    clientSecret: "secret",
    redirectUri: "https://x/callback",
  });

  assertEquals(res, CONFIG_A);
});

Deno.test("console.apps.deleteOAuthConfig discards {ok:true} and resolves undefined", async () => {
  const c = client(() => json({ ok: true }));

  const res = await c.client.console.apps.deleteOAuthConfig("app_1", "oauth2");

  assertEquals(res, undefined);
  assertEquals(c.calls[0].method, "DELETE");
  assertEquals(c.calls[0].url, "https://api.example.com/apps/app_1/oauth-config/oauth2");
});

// --- Body forwarding ---------------------------------------------------------

Deno.test("console.apps.upsertOAuthConfig sends the body verbatim", async () => {
  const c = client(() => json({ config: CONFIG_A }, 201));

  await c.client.console.apps.upsertOAuthConfig("app_1", "oauth2", {
    clientId: "id",
    clientSecret: "secret",
    redirectUri: "https://x/callback",
  });

  assertEquals(JSON.parse(c.calls[0].body ?? "null"), {
    clientId: "id",
    clientSecret: "secret",
    redirectUri: "https://x/callback",
  });
});

Deno.test("console.apps.invoke sends { params, ...opts } verbatim", async () => {
  const c = client(() => json({ value: null }));

  await c.client.console.apps.invoke("app_1", "send", { a: 1 }, { connectionId: "conn_1" });

  assertEquals(JSON.parse(c.calls[0].body ?? "null"), { params: { a: 1 }, connectionId: "conn_1" });
});

// `project` and `state` are not decoration: the server resolves any ExprValue
// left in `params` against a scope built from exactly those two (`invoke.ts` ->
// `buildAmbientScope`). Modelling only `connectionId` here — which this method
// did until 2026-08-11 — silently drops them, and every
// `{{ steps.<id>.output.<field> }}` in a step test resolves to "" while the
// editor's local preview still shows the right value. Assert the WHOLE body, so
// a dropped key is a failure rather than an absence nobody looks for.
Deno.test("console.apps.invoke forwards project and state, not just connectionId", async () => {
  const c = client(() => json({ value: null }));
  const state = { steps: { gate_1: { output: { email: "a@b.com" } } } };

  await c.client.console.apps.invoke("app_1", "send", { a: 1 }, {
    connectionId: "conn_1",
    project: "prj_9",
    state,
  });

  assertEquals(JSON.parse(c.calls[0].body ?? "null"), {
    params: { a: 1 },
    connectionId: "conn_1",
    project: "prj_9",
    state,
  });
});

Deno.test("console.apps.invoke carries state alone, with no connection", async () => {
  const c = client(() => json({ value: null }));
  const state = { trigger: { event: { id: 7 } } };

  await c.client.console.apps.invoke("app_1", "send", {}, { state });

  assertEquals(JSON.parse(c.calls[0].body ?? "null"), { params: {}, state });
});

Deno.test("console.apps.preview sends { source } with no refresh key when opts.refresh is omitted", async () => {
  const c = client(() => json({ kind: "app", sourceRef: "s", app: {} }));

  await c.client.console.apps.preview("github:org/app");

  assertEquals(JSON.parse(c.calls[0].body ?? "null"), { source: "github:org/app" });
});

Deno.test("console.apps.preview sends { source, refresh: true } when opts.refresh is set", async () => {
  const c = client(() => json({ kind: "app", sourceRef: "s", app: {} }));

  await c.client.console.apps.preview("github:org/app", { refresh: true });

  assertEquals(JSON.parse(c.calls[0].body ?? "null"), { source: "github:org/app", refresh: true });
});

Deno.test("console.apps.import sends { source, paths, refresh } only when given", async () => {
  const c = client(() =>
    json({
      kind: "app",
      sourceRef: "s",
      app: {},
      actions: [],
      registered: true,
      latestAdvanced: true,
    })
  );

  await c.client.console.apps.import("github:org/pack", { paths: ["a", "b"], refresh: true });

  assertEquals(JSON.parse(c.calls[0].body ?? "null"), {
    source: "github:org/pack",
    paths: ["a", "b"],
    refresh: true,
  });
});

Deno.test("console.apps.import sends { source } only when opts is omitted", async () => {
  const c = client(() =>
    json({
      kind: "app",
      sourceRef: "s",
      app: {},
      actions: [],
      registered: true,
      latestAdvanced: true,
    })
  );

  await c.client.console.apps.import("github:org/app");

  assertEquals(JSON.parse(c.calls[0].body ?? "null"), { source: "github:org/app" });
});

Deno.test("console.apps.refresh sends { force: true } only when opts.force is set", async () => {
  const c = client(() =>
    json({
      app: {},
      actions: [],
      sourceRef: "s",
      version: "1.0.0",
      digest: "d",
      registered: false,
      latestAdvanced: false,
      bumped: false,
      sourceVersion: "1.0.0",
    })
  );

  await c.client.console.apps.refresh("app_1", { force: true });

  assertEquals(JSON.parse(c.calls[0].body ?? "null"), { force: true });
});

Deno.test("console.apps.refresh sends {} when opts is omitted", async () => {
  const c = client(() =>
    json({
      app: {},
      actions: [],
      sourceRef: "s",
      version: "1.0.0",
      digest: "d",
      registered: false,
      latestAdvanced: false,
      bumped: false,
      sourceVersion: "1.0.0",
    })
  );

  await c.client.console.apps.refresh("app_1");

  assertEquals(JSON.parse(c.calls[0].body ?? "null"), {});
});

// --- Path-segment encoding ----------------------------------------------------

Deno.test("console.apps.get percent-encodes the id via the `path` tag, not string concatenation", async () => {
  const c = client(() => json(APP_DETAIL));

  await c.client.console.apps.get("app a");

  assertEquals(c.calls[0].url, "https://api.example.com/apps/app%20a");
});

Deno.test("console.apps.getAuth percent-encodes the id via the `path` tag", async () => {
  const c = client(() => json({ auths: [] }));

  await c.client.console.apps.getAuth("app a");

  assertEquals(c.calls[0].url, "https://api.example.com/apps/app%20a/auths");
});

Deno.test("console.apps.delete percent-encodes the id via the `path` tag", async () => {
  const c = client(() => json({ removed: 0 }));

  await c.client.console.apps.delete("app a");

  assertEquals(c.calls[0].url, "https://api.example.com/apps/app%20a");
});
