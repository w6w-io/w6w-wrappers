/**
 * `client.console.commerce.*`, against an injected fake `fetch`.
 *
 * Beyond the per-operation assertions, this suite pins the two things that
 * matter most: `plans()` is PUBLIC — it must never send a bearer, even on a
 * client that holds one, and it must succeed on a tokenless client rather
 * than throwing `ConfigError` (the actual bug `requireAuth: false` fixes,
 * mirroring `console.auth`'s public trio); `subscription()` is GUARDED and
 * must send the bearer like any other request. Both responses carry an
 * envelope key, unlike `console.dashboard`, so both methods must peel it via
 * `unwrap()` rather than returning `res.body` verbatim.
 */

import { assertEquals } from "@std/assert";
import { W6WClient } from "../../src/client.ts";
import type { FetchLike } from "../../src/config.ts";
import type { CommerceSubscription, Plan } from "../../src/console/commerce.ts";

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

/** A realistic plan, matching every required field of `Plan`/`PlanLimits`. */
const PLAN: Plan = {
  key: "free",
  name: "Free",
  description: "Get started",
  rank: 0,
  retired: false,
  features: ["catalog"],
  limits: {
    quotas: {
      connections: { kind: "capped", included: 3 },
      runs: { kind: "metered", included: 1000, per: 1000, unitAmount: 5 },
      monitors: { quota: { kind: "capped", included: 5 }, minCadenceMinutes: 15 },
      checkRuns: { kind: "unlimited" },
      retention: { bodiesDays: 7, metadataDays: 30 },
      projects: { kind: "capped", included: 1 },
      seats: { kind: "capped", included: 1 },
    },
    capabilities: {
      catalogImport: false,
      privateRegistry: false,
      implSwapAndConfig: false,
      versionPinsAndBlocks: false,
      egressCaptureExport: false,
      embeddedWhiteLabel: false,
      selfHostLicence: { available: false, annualSurcharge: null },
    },
    support: "community",
  },
  price: { kind: "none" },
};

const SUBSCRIPTION: CommerceSubscription = { plan: "team", status: "active", canUpgrade: true };

/** A client wired to a fake transport, WITH a token — the interesting case for `requireAuth`. */
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

Deno.test("console.commerce.plans() hits GET /commerce/plans and returns the ARRAY, not the envelope", async () => {
  const c = client(() => json({ plans: [PLAN] }));

  const result = await c.client.console.commerce.plans();

  // A `return res.body` implementation (no envelope peel) would resolve
  // `{ plans: [...] }` here — an object, not an array — and this fails.
  assertEquals(Array.isArray(result), true);
  assertEquals(result[0].key, "free");
  assertEquals(c.calls[0].method, "GET");
  assertEquals(c.calls[0].url, "https://api.example.com/commerce/plans");
});

Deno.test("console.commerce.plans() on a client WITH a token sends NO authorization header", async () => {
  const c = client(() => json({ plans: [PLAN] }));

  await c.client.console.commerce.plans();

  // A `requireAuth: true` (or omitted) implementation passes "returns the
  // plans" and dies precisely here.
  assertEquals(c.calls[0].headers.has("authorization"), false);
});

Deno.test("console.commerce.plans() on a TOKENLESS client succeeds rather than throwing ConfigError", async () => {
  const fake = fakeFetch(() => json({ plans: [PLAN] }));
  const anon = new W6WClient({ baseUrl: "https://api.example.com", fetch: fake.fetch }); // no token

  const result = await anon.console.commerce.plans();

  assertEquals(Array.isArray(result), true);
  assertEquals(result[0].key, "free");
});

Deno.test(
  "console.commerce.subscription() hits GET /commerce/subscription, DOES send the bearer, and unwraps",
  async () => {
    const c = client(() => json({ subscription: SUBSCRIPTION }));

    const result = await c.client.console.commerce.subscription();

    assertEquals(c.calls[0].method, "GET");
    assertEquals(c.calls[0].url, "https://api.example.com/commerce/subscription");
    assertEquals(c.calls[0].headers.get("authorization"), "Bearer tok_1");
    assertEquals(result.canUpgrade, true);
    assertEquals(result.plan, "team");
    assertEquals(result.status, "active");
  },
);

Deno.test("console.commerce: plans and subscription are functions on a constructed client", () => {
  // Runtime, not type-level: a namespace that silently lost a method would
  // still typecheck everywhere else in this suite.
  const c = new W6WClient({ baseUrl: "https://api.example.com", token: "t" });
  assertEquals(typeof c.console.commerce.plans, "function");
  assertEquals(typeof c.console.commerce.subscription, "function");
});
