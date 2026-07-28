/**
 * The two mechanism pins the rest of the suite exercises without pinning.
 *
 * Both were found by mutation testing against the shipped transport core, and
 * both mutants survived `check`, `lint`, `fmt:check` and every test file:
 *
 * 1. **A client that ignores its injected `fetch`.** Every http test calls
 *    `request(CONFIG, fake.fetch, …)` directly, so a `W6wClient` that quietly
 *    used `globalThis.fetch` instead of the transport it was handed still passed
 *    — executed, the fake was called **0 times** and a real network request went
 *    out. "No test may require a live server" (`docs/implementation.md` §9) was
 *    therefore load-bearing on one unpinned line. The cases below assert the
 *    **call count** on the injected transport, not merely the shape of a result.
 * 2. **Credentials as instance state.** A module-level `let sharedToken` that
 *    the constructor writes and reads — the exact browser anti-pattern
 *    `docs/implementation.md` §2 forbids — also survived every gate. Its failure
 *    mode is a client constructed with no token silently sending **another
 *    tenant's credential**, possibly to a different server. The cases below
 *    construct two clients with different tokens plus one with none, interleave
 *    their requests, and check each request carried exactly its own client's
 *    credential.
 */

import { assertEquals, assertRejects } from "@std/assert";
import { W6wClient } from "../src/client.ts";
import type { FetchLike } from "../src/config.ts";
import { ConfigError } from "../src/errors.ts";

/** One recorded call to a fake transport, with the client it came from. */
interface Call {
  url: string;
  authorization: string | null;
}

/** A `fetch`-shaped fake that records what it was asked to send. */
function spyFetch(body: unknown = { ok: true }): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: FetchLike = (input, init) => {
    calls.push({
      url: input,
      authorization: new Headers(init?.headers).get("authorization"),
    });
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  };
  return { fetch, calls };
}

Deno.test("the client uses the transport it was injected with, and only that one", async () => {
  const spy = spyFetch({ documents: [], vars: [] });
  const client = new W6wClient({
    baseUrl: "https://api.example.com",
    token: "tok_1",
    fetch: spy.fetch,
  });

  await client.documents.list();
  await client.vars.list();
  await client.request({ method: "GET", path: "/anything" });

  // The count is the assertion. A client that reached for `globalThis.fetch`
  // would still satisfy every assertion about the returned value — and would
  // have put three real requests on the network from a unit test.
  assertEquals(spy.calls.length, 3);
  assertEquals(spy.calls.map((c) => c.url), [
    "https://api.example.com/documents",
    "https://api.example.com/vars",
    "https://api.example.com/anything",
  ]);
});

Deno.test("every namespace and method routes through the injected transport", async () => {
  // Not a repetition of the case above: each namespace is constructed with the
  // client rather than with the transport, so one of them wiring itself to the
  // global would be invisible everywhere else.
  const spy = spyFetch({ runId: "run_1", status: "queued", kind: "workflow", ok: true });
  const client = new W6wClient({
    baseUrl: "https://api.example.com",
    token: "tok_1",
    project: "prj_1",
    fetch: spy.fetch,
  });

  // The bodies the fake returns do not satisfy every operation's envelope, and
  // that is fine: what is being asserted is which transport carried the request,
  // so an operation that rejects afterwards still counts.
  const operations: Array<() => Promise<unknown>> = [
    () => client.documents.get("doc_1"),
    () => client.vars.get("var_1"),
    () => client.connections.list(),
    () => client.workflows.list(),
    () => client.workflows.run("wf_1"),
    () => client.me(),
    () => client.run({ urn: "wf_1" }),
  ];
  for (const operation of operations) {
    await operation().catch(() => {});
  }

  assertEquals(spy.calls.length, operations.length);
  // …and every one of them carried this client's credential.
  assertEquals(
    spy.calls.every((c) => c.authorization === "Bearer tok_1"),
    true,
  );
});

Deno.test("two clients in one process never share a credential", async () => {
  // Interleaved on purpose: a module-global token is written by the LAST
  // construction, so a sequential A-then-B script would still look right.
  const spyA = spyFetch({ documents: [] });
  const spyB = spyFetch({ documents: [] });
  const a = new W6wClient({
    baseUrl: "https://tenant-a.example.com",
    token: "tok_TENANT_A",
    fetch: spyA.fetch,
  });
  const b = new W6wClient({
    baseUrl: "https://tenant-b.example.com",
    token: "tok_TENANT_B",
    fetch: spyB.fetch,
  });

  await a.documents.list();
  await b.documents.list();
  await a.documents.list();

  assertEquals(spyA.calls.map((c) => c.authorization), [
    "Bearer tok_TENANT_A",
    "Bearer tok_TENANT_A",
  ]);
  assertEquals(spyB.calls.map((c) => c.authorization), ["Bearer tok_TENANT_B"]);
  // The base URL is instance state for the same reason: B's requests must never
  // arrive at A's server.
  assertEquals(spyA.calls.map((c) => c.url), [
    "https://tenant-a.example.com/documents",
    "https://tenant-a.example.com/documents",
  ]);
  assertEquals(spyB.calls[0].url, "https://tenant-b.example.com/documents");
});

Deno.test("a client with no token borrows nobody else's", async () => {
  // The failure this pins is the dangerous one: under a module-global
  // credential, the tokenless client below would send `Bearer tok_TENANT_A` —
  // one tenant's credential, to another tenant's server, with no error anywhere.
  const spyA = spyFetch({ documents: [] });
  const spyNone = spyFetch({ documents: [] });
  const withToken = new W6wClient({
    baseUrl: "https://tenant-a.example.com",
    token: "tok_TENANT_A",
    fetch: spyA.fetch,
  });
  const saved = Deno.env.get("W6W_TOKEN");
  Deno.env.delete("W6W_TOKEN");
  try {
    const tokenless = new W6wClient({
      baseUrl: "https://tenant-b.example.com",
      fetch: spyNone.fetch,
    });
    await withToken.documents.list();

    assertEquals(tokenless.config.token, null);
    await assertRejects(() => tokenless.documents.list(), ConfigError);
    // It failed before the transport, so nothing at all was sent.
    assertEquals(spyNone.calls.length, 0);
  } finally {
    if (saved === undefined) Deno.env.delete("W6W_TOKEN");
    else Deno.env.set("W6W_TOKEN", saved);
  }
  assertEquals(spyA.calls[0].authorization, "Bearer tok_TENANT_A");
});
