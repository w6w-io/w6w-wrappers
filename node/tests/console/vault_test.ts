/**
 * `client.console.vault.*`, against an injected fake `fetch`.
 *
 * No case here needs a live server (`docs/implementation.md` §9). Beyond the
 * per-operation envelope assertions (`list`/`get`/`create`/`update` all
 * unwrap from `secret`/`secrets`; `seal` unwraps from `sealed`, a DIFFERENT
 * key — discriminating a mutant that copies the wrong envelope key from a
 * neighboring method), the fixtures below deliberately never carry a `value`
 * field, matching the real server's wire shape: `VaultSecretSummary` has no
 * such field, so a fixture that added one and asserted it survives would be
 * testing the wrong thing.
 *
 * No secret VALUE in this file is a real credential — every value below
 * (`"sk-live-123"`, `"sk- with spaces \n"`) is an obviously-synthetic
 * placeholder used only to prove the transport forwards the string verbatim.
 */

import { assertEquals } from "@std/assert";
import { W6wClient } from "../../src/client.ts";
import type { FetchLike } from "../../src/config.ts";
import type { VaultSecretSummary } from "../../src/console/vault.ts";

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

// Deliberately NO `value` field — matches the real server's wire shape for
// VaultSecretSummary (list/get/create/update never carry plaintext).
const SECRET_A: VaultSecretSummary = {
  id: "sec_1",
  name: "openai_key",
  description: "Prod key",
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
};

const SECRET_B: VaultSecretSummary = {
  id: "sec_2",
  name: "stripe_key",
  description: "",
  createdAt: "2026-08-02T00:00:00.000Z",
  updatedAt: "2026-08-02T00:00:00.000Z",
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
  "console.vault: list/get/create/update/delete/seal are functions on a constructed client",
  () => {
    // Runtime, not type-level: a namespace that silently lost a method would
    // still typecheck everywhere else in this suite.
    const c = new W6wClient({ baseUrl: "https://api.example.com", token: "t" });
    assertEquals(typeof c.console.vault.list, "function");
    assertEquals(typeof c.console.vault.get, "function");
    assertEquals(typeof c.console.vault.create, "function");
    assertEquals(typeof c.console.vault.update, "function");
    assertEquals(typeof c.console.vault.delete, "function");
    assertEquals(typeof c.console.vault.seal, "function");
  },
);

Deno.test("console.vault.list unwraps the secrets envelope", async () => {
  const c = client(() => json({ secrets: [SECRET_A, SECRET_B] }));

  const res = await c.client.console.vault.list();

  // A mutant that forgot to call unwrap() would resolve the envelope object
  // itself, not the array it wraps.
  assertEquals(res, [SECRET_A, SECRET_B]);
  assertEquals(c.calls[0].method, "GET");
  assertEquals(c.calls[0].url, "https://api.example.com/vault");
});

Deno.test("console.vault.get unwraps the secret envelope", async () => {
  const c = client(() => json({ secret: SECRET_A }));

  const res = await c.client.console.vault.get("sec_1");

  assertEquals(res, SECRET_A);
  assertEquals(c.calls[0].method, "GET");
  assertEquals(c.calls[0].url, "https://api.example.com/vault/sec_1");
});

Deno.test("console.vault.create unwraps the secret envelope (201)", async () => {
  const c = client(() => json({ secret: SECRET_A }, 201));

  const res = await c.client.console.vault.create({
    name: "openai_key",
    value: "sk-live-123",
    description: "Prod key",
  });

  assertEquals(res, SECRET_A);
  assertEquals(c.calls[0].method, "POST");
  assertEquals(c.calls[0].url, "https://api.example.com/vault");
});

Deno.test("console.vault.update unwraps the secret envelope", async () => {
  const c = client(() => json({ secret: SECRET_A }));

  const res = await c.client.console.vault.update("sec_1", { description: "Renamed" });

  assertEquals(res, SECRET_A);
  assertEquals(c.calls[0].method, "PATCH");
  assertEquals(c.calls[0].url, "https://api.example.com/vault/sec_1");
});

Deno.test(
  "console.vault.seal unwraps from `sealed`, not `secret` — a mutant copying the wrong envelope key fails here",
  async () => {
    const c = client(() => json({ sealed: { type: "secret", ciphertext: "abc", iv: "def" } }));

    const res = await c.client.console.vault.seal("sk-live-123");

    assertEquals(res, { type: "secret", ciphertext: "abc", iv: "def" });
    assertEquals(JSON.parse(c.calls[0].body ?? "null"), { value: "sk-live-123" });
    assertEquals(c.calls[0].method, "POST");
    assertEquals(c.calls[0].url, "https://api.example.com/vault/seal");
  },
);

Deno.test("console.vault.delete sends DELETE to the right path and resolves void", async () => {
  const c = client(() => json({ ok: true }));

  const res = await c.client.console.vault.delete("sec_1");

  assertEquals(res, undefined);
  assertEquals(c.calls[0].method, "DELETE");
  assertEquals(c.calls[0].url, "https://api.example.com/vault/sec_1");
});

Deno.test(
  "console.vault.create sends `value` verbatim, untouched — no trim/transform",
  async () => {
    const c = client(() => json({ secret: SECRET_A }, 201));

    await c.client.console.vault.create({
      name: "openai_key",
      value: "sk- with spaces \n",
      description: "d",
    });

    assertEquals(JSON.parse(c.calls[0].body ?? "null"), {
      name: "openai_key",
      value: "sk- with spaces \n",
      description: "d",
    });
  },
);

Deno.test(
  "console.vault.update sends `value` verbatim, untouched — no trim/transform",
  async () => {
    const c = client(() => json({ secret: SECRET_A }));

    await c.client.console.vault.update("sec_1", { value: "sk- with spaces \n" });

    assertEquals(JSON.parse(c.calls[0].body ?? "null"), { value: "sk- with spaces \n" });
  },
);

Deno.test("console.vault.get percent-encodes id via the `path` tag", async () => {
  const c = client(() => json({ secret: SECRET_A }));

  await c.client.console.vault.get("sec 1");

  assertEquals(c.calls[0].url, "https://api.example.com/vault/sec%201");
});

Deno.test("console.vault.update percent-encodes id via the `path` tag", async () => {
  const c = client(() => json({ secret: SECRET_A }));

  await c.client.console.vault.update("sec 1", { description: "d" });

  assertEquals(c.calls[0].url, "https://api.example.com/vault/sec%201");
});

Deno.test("console.vault.delete percent-encodes id via the `path` tag", async () => {
  const c = client(() => json({ ok: true }));

  await c.client.console.vault.delete("sec 1");

  assertEquals(c.calls[0].url, "https://api.example.com/vault/sec%201");
});
