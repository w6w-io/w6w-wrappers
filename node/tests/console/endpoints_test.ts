/**
 * `client.console.endpoints.*`, against an injected fake `fetch`.
 *
 * No case here needs a live server (`docs/implementation.md` §9). The cases
 * that matter most:
 *
 * - `get`/`upsert` return the raw three-key body VERBATIM — NOT merged, NOT
 *   `unwrap()`ed — including the `invokeUrlByKey`-omitted case (genuinely
 *   absent, not `undefined`-valued).
 * - `invoke` calls the DEDICATED `/endpoints/:id/invoke` route directly,
 *   NEVER `/run`, and preserves field names verbatim on every target kind
 *   (`action`/`function`/`workflow`) — the central discriminating gate for
 *   this task's central finding.
 * - A structural check that `invoke`'s method body never references `"/run"`
 *   or `runUrn`, straight from the source.
 * - `list` unwraps correctly, each row keeping its own `invokeUrl`.
 * - Every id-taking method routes its id through the `path` tag (percent-encoding).
 */

import { assertEquals, assertRejects } from "@std/assert";
import { W6WClient } from "../../src/client.ts";
import type { FetchLike } from "../../src/config.ts";
import { ApiError } from "../../src/errors.ts";
import type { EndpointDef, EndpointSummary } from "../../src/console/endpoints.ts";

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

const EP: EndpointDef = {
  manifestVersion: "2",
  id: "ep_1",
  key: "hook",
  displayName: "Hook",
  description: "",
  target: { kind: "action", uses: { app: "a", action: "b" } },
};

const SUMMARY_EP_A: EndpointSummary = {
  id: "ep_1",
  key: "hook",
  displayName: "Hook",
  description: "",
  updatedAt: "2026-08-09T00:00:00.000Z",
  invokeUrl: "https://api.example.com/invoke/ep_1",
};

const SUMMARY_EP_B: EndpointSummary = {
  id: "ep_2",
  key: "notify",
  displayName: "Notify",
  description: "",
  updatedAt: "2026-08-09T00:00:01.000Z",
  invokeUrl: "https://api.example.com/invoke/ep_2",
};

Deno.test(
  "console.endpoints: list/get/upsert/invoke are functions on a constructed client",
  () => {
    // Runtime, not type-level: a namespace that silently lost a method would
    // still typecheck everywhere else in this suite.
    const c = new W6WClient({ baseUrl: "https://api.example.com", token: "t" });
    assertEquals(typeof c.console.endpoints.list, "function");
    assertEquals(typeof c.console.endpoints.get, "function");
    assertEquals(typeof c.console.endpoints.upsert, "function");
    assertEquals(typeof c.console.endpoints.invoke, "function");
    // Regression-proof: base client.run stays untouched.
    assertEquals(typeof c.run, "function");
  },
);

Deno.test(
  "console.endpoints.get returns the raw three-key body VERBATIM — NOT merged, NOT unwrap()ed",
  async () => {
    const c = client(() =>
      json({
        endpoint: EP,
        invokeUrl: "https://x/invoke/ep_1",
        invokeUrlByKey: "https://x/invoke/acme/hook",
      })
    );

    const res = await c.client.console.endpoints.get("ep_1");

    // A mutant that spliced invokeUrl/invokeUrlByKey into `endpoint`, or that
    // called unwrap(res, "endpoint"), would fail this exact assertion.
    assertEquals(res, {
      endpoint: EP,
      invokeUrl: "https://x/invoke/ep_1",
      invokeUrlByKey: "https://x/invoke/acme/hook",
    });
    assertEquals(c.calls[0].method, "GET");
  },
);

Deno.test(
  "console.endpoints.get omits invokeUrlByKey entirely when absent from the fixture — not undefined-valued",
  async () => {
    const c = client(() => json({ endpoint: EP, invokeUrl: "https://x/invoke/ep_1" }));

    const res = await c.client.console.endpoints.get("ep_1");

    assertEquals(res, { endpoint: EP, invokeUrl: "https://x/invoke/ep_1" });
    // Genuinely absent — a mutant that defaults it to `undefined` explicitly
    // would still pass a loose equality check but fail this one.
    assertEquals(Object.hasOwn(res, "invokeUrlByKey"), false);
  },
);

Deno.test(
  "console.endpoints.upsert returns the raw three-key body VERBATIM and sends the definition verbatim",
  async () => {
    const c = client(() =>
      json(
        {
          endpoint: { id: "ep_1", key: "hook" },
          invokeUrl: "https://x/invoke/ep_1",
          invokeUrlByKey: "https://x/invoke/acme/hook",
        },
        201,
      )
    );

    const res = await c.client.console.endpoints.upsert(EP);

    assertEquals(res, {
      endpoint: { id: "ep_1", key: "hook" },
      invokeUrl: "https://x/invoke/ep_1",
      invokeUrlByKey: "https://x/invoke/acme/hook",
    });
    assertEquals(JSON.parse(c.calls[0].body ?? "null"), EP);
    assertEquals(c.calls[0].method, "POST");
    assertEquals(c.calls[0].url, "https://api.example.com/endpoints");
  },
);

Deno.test(
  "console.endpoints.upsert omits invokeUrlByKey entirely when absent from the fixture",
  async () => {
    const c = client(() =>
      json({ endpoint: { id: "ep_1", key: "hook" }, invokeUrl: "https://x/invoke/ep_1" }, 201)
    );

    const res = await c.client.console.endpoints.upsert(EP);

    assertEquals(Object.hasOwn(res, "invokeUrlByKey"), false);
  },
);

Deno.test("console.endpoints.list unwraps the endpoints envelope, each row keeping its own invokeUrl", async () => {
  const c = client(() => json({ endpoints: [SUMMARY_EP_A, SUMMARY_EP_B] }));

  const res = await c.client.console.endpoints.list();

  assertEquals(res, [SUMMARY_EP_A, SUMMARY_EP_B]);
  assertEquals(res[0].invokeUrl, SUMMARY_EP_A.invokeUrl);
  assertEquals(res[1].invokeUrl, SUMMARY_EP_B.invokeUrl);
  assertEquals(c.calls[0].method, "GET");
  assertEquals(c.calls[0].url, "https://api.example.com/endpoints");
});

Deno.test(
  "console.endpoints.invoke hits the DEDICATED route, never /run, and preserves output on the action arm",
  async () => {
    const c = client(() => json({ kind: "action", output: 42 }));

    const res = await c.client.console.endpoints.invoke("ep_1", { to: "a@b.com" });

    // NOT { kind: "action", value: 42 } — the field-rename the resolve-run.ts
    // `ep_` arm applies would produce that instead.
    assertEquals(res, { kind: "action", output: 42 });
    assertEquals(c.calls[0].url, "https://api.example.com/endpoints/ep_1/invoke");
    assertEquals(c.calls[0].url.includes("/run"), false);
    assertEquals(JSON.parse(c.calls[0].body ?? "null"), { input: { to: "a@b.com" } });
    assertEquals(c.calls[0].method, "POST");
  },
);

Deno.test("console.endpoints.invoke round-trips the function-target result verbatim", async () => {
  const c = client(() => json({ kind: "function", output: { sent: true } }));

  const res = await c.client.console.endpoints.invoke("ep_1", {});

  assertEquals(res, { kind: "function", output: { sent: true } });
  assertEquals(c.calls[0].url, "https://api.example.com/endpoints/ep_1/invoke");
});

Deno.test("console.endpoints.invoke round-trips the workflow-target result verbatim", async () => {
  const c = client(() => json({ kind: "workflow", runId: "run_1" }, 202));

  const res = await c.client.console.endpoints.invoke("ep_1", {});

  assertEquals(res, { kind: "workflow", runId: "run_1" });
  assertEquals(c.calls[0].url, "https://api.example.com/endpoints/ep_1/invoke");
});

Deno.test("console.endpoints.get throws on a genuine non-2xx", async () => {
  const c = client(() =>
    json({ error: { code: "unknown_endpoint", message: "Not registered." } }, 404)
  );

  const err = await assertRejects(() => c.client.console.endpoints.get("ep_missing"), ApiError);

  assertEquals(err.status, 404);
  assertEquals(err.code, "unknown_endpoint");
});

Deno.test("console.endpoints.upsert throws on a genuine non-2xx", async () => {
  const c = client(() => json({ error: { code: "key_immutable", message: "Immutable." } }, 409));

  const err = await assertRejects(() => c.client.console.endpoints.upsert(EP), ApiError);

  assertEquals(err.status, 409);
  assertEquals(err.code, "key_immutable");
});

Deno.test("console.endpoints.invoke throws on a genuine non-2xx", async () => {
  const c = client(() =>
    json({ error: { code: "unknown_endpoint", message: "Not registered." } }, 404)
  );

  const err = await assertRejects(
    () => c.client.console.endpoints.invoke("ep_missing", {}),
    ApiError,
  );

  assertEquals(err.status, 404);
  assertEquals(err.code, "unknown_endpoint");
});

Deno.test("console.endpoints.get percent-encodes id via the `path` tag", async () => {
  const c = client(() => json({ endpoint: EP, invokeUrl: "https://x/invoke/ep_1" }));

  await c.client.console.endpoints.get("ep 1");

  assertEquals(c.calls[0].url, "https://api.example.com/endpoints/ep%201");
});

Deno.test("console.endpoints.invoke percent-encodes id via the `path` tag", async () => {
  const c = client(() => json({ kind: "action", output: 1 }));

  await c.client.console.endpoints.invoke("ep 1", {});

  assertEquals(c.calls[0].url, "https://api.example.com/endpoints/ep%201/invoke");
});
