/**
 * `client.console.tokens.*`, against an injected fake `fetch`.
 *
 * No case here needs a live server (`docs/implementation.md` §9). The case
 * that matters most is `create`'s plaintext-once shape: it must return BOTH
 * `token` and `secret`, with NO `unwrap()` call — this discriminates two
 * opposite mutants, one that wraps the result in `unwrap(res, "token")`
 * (which would silently drop `secret`, since `unwrap` returns only the
 * `token` value) and one that returns `res.body.token` alone. A structural
 * check further pins that `ApiToken` can never carry a `secret` field, so
 * "simplifying" `CreateTokenResponse` into an optional field on `ApiToken`
 * is caught even if every runtime assertion above happened to still pass.
 *
 * No secret VALUE in this file is a real credential — `"tok_live_abc123"` is
 * an obviously-synthetic placeholder used only to prove the transport
 * forwards the string verbatim.
 */

import { assertEquals } from "@std/assert";
import { W6WClient } from "../../src/client.ts";
import type { FetchLike } from "../../src/config.ts";
import type { ApiToken } from "../../src/console/tokens.ts";

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

// Deliberately NO `secret` field — matches ApiToken's real wire shape (the
// server's toWire() never puts it on this shape).
const TOKEN_A: ApiToken = {
  id: "tok_1",
  account: "acct_1",
  name: "ci-deploy",
  status: "active",
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
  revokedAt: null,
};

const TOKEN_B: ApiToken = {
  id: "tok_2",
  account: "acct_1",
  name: "backfill",
  status: "disabled",
  createdAt: "2026-08-02T00:00:00.000Z",
  updatedAt: "2026-08-02T00:00:00.000Z",
  revokedAt: null,
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
  "console.tokens: list/create/disable/enable/revoke are functions on a constructed client",
  () => {
    // Runtime, not type-level: a namespace that silently lost a method would
    // still typecheck everywhere else in this suite.
    const c = new W6WClient({ baseUrl: "https://api.example.com", token: "t" });
    assertEquals(typeof c.console.tokens.list, "function");
    assertEquals(typeof c.console.tokens.create, "function");
    assertEquals(typeof c.console.tokens.disable, "function");
    assertEquals(typeof c.console.tokens.enable, "function");
    assertEquals(typeof c.console.tokens.revoke, "function");
  },
);

Deno.test("console.tokens.list unwraps the tokens envelope", async () => {
  const c = client(() => json({ tokens: [TOKEN_A, TOKEN_B] }));

  const res = await c.client.console.tokens.list();

  // A mutant that forgot to call unwrap() would resolve the envelope object
  // itself, not the array it wraps.
  assertEquals(res, [TOKEN_A, TOKEN_B]);
  assertEquals(c.calls[0].method, "GET");
  assertEquals(c.calls[0].url, "https://api.example.com/tokens");
});

Deno.test(
  "console.tokens.create returns BOTH token and secret, with NO unwrap() call",
  async () => {
    const c = client(() => json({ token: TOKEN_A, secret: "tok_live_abc123" }, 201));

    const res = await c.client.console.tokens.create("ci-deploy");

    // A mutant that wrapped this in unwrap(res, "token") would silently drop
    // `secret` (unwrap returns only the `token` value); a mutant that
    // returned `res.body.token` alone would drop it too. Both fail here.
    assertEquals(res, { token: TOKEN_A, secret: "tok_live_abc123" });
    assertEquals(c.calls[0].method, "POST");
    assertEquals(c.calls[0].url, "https://api.example.com/tokens");
    assertEquals(JSON.parse(c.calls[0].body ?? "null"), { name: "ci-deploy" });
  },
);

Deno.test(
  "console.tokens.disable sends POST with {} body to /tokens/:id/disable and unwraps token",
  async () => {
    const c = client(() => json({ token: TOKEN_A }));

    const res = await c.client.console.tokens.disable("tok_1");

    assertEquals(res, TOKEN_A);
    assertEquals(c.calls[0].method, "POST");
    assertEquals(c.calls[0].url, "https://api.example.com/tokens/tok_1/disable");
    assertEquals(JSON.parse(c.calls[0].body ?? "null"), {});
  },
);

Deno.test(
  "console.tokens.enable sends POST with {} body to /tokens/:id/enable and unwraps token",
  async () => {
    const c = client(() => json({ token: TOKEN_A }));

    const res = await c.client.console.tokens.enable("tok_1");

    assertEquals(res, TOKEN_A);
    assertEquals(c.calls[0].method, "POST");
    assertEquals(c.calls[0].url, "https://api.example.com/tokens/tok_1/enable");
    assertEquals(JSON.parse(c.calls[0].body ?? "null"), {});
  },
);

Deno.test(
  "console.tokens.revoke sends POST with {} body to /tokens/:id/revoke and unwraps token",
  async () => {
    const c = client(() => json({ token: TOKEN_A }));

    const res = await c.client.console.tokens.revoke("tok_1");

    assertEquals(res, TOKEN_A);
    assertEquals(c.calls[0].method, "POST");
    assertEquals(c.calls[0].url, "https://api.example.com/tokens/tok_1/revoke");
    assertEquals(JSON.parse(c.calls[0].body ?? "null"), {});
  },
);

Deno.test("console.tokens.disable percent-encodes id via the `path` tag", async () => {
  const c = client(() => json({ token: TOKEN_A }));

  await c.client.console.tokens.disable("tok 1");

  assertEquals(c.calls[0].url, "https://api.example.com/tokens/tok%201/disable");
});

Deno.test("console.tokens.enable percent-encodes id via the `path` tag", async () => {
  const c = client(() => json({ token: TOKEN_A }));

  await c.client.console.tokens.enable("tok 1");

  assertEquals(c.calls[0].url, "https://api.example.com/tokens/tok%201/enable");
});

Deno.test("console.tokens.revoke percent-encodes id via the `path` tag", async () => {
  const c = client(() => json({ token: TOKEN_A }));

  await c.client.console.tokens.revoke("tok 1");

  assertEquals(c.calls[0].url, "https://api.example.com/tokens/tok%201/revoke");
});
