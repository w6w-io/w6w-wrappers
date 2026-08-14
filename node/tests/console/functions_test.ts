/**
 * `client.console.functions.*`, against an injected fake `fetch`.
 *
 * No case here needs a live server (`docs/implementation.md` §9). The cases
 * that matter most:
 *
 * - `get` performs the pinned `valid`-splice merge — `{...function, valid}`,
 *   NOT the raw `{function, valid}` two-key body.
 * - `list`/`upsert` unwrap correctly (`functions`/`function` envelope keys).
 * - There is no `console.functions.invoke` — a direct check on the
 *   Requirement's anti-duplication pin, and the base `client.run` stays
 *   untouched.
 * - Every id-taking method routes its id through the `path` tag
 *   (percent-encoding).
 */

import { assertEquals, assertRejects } from "@std/assert";
import { W6WClient } from "../../src/client.ts";
import type { FetchLike } from "../../src/config.ts";
import { ApiError } from "../../src/errors.ts";
import type { FunctionDef, FunctionSummary } from "../../src/console/functions.ts";

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

const FN: FunctionDef = {
  manifestVersion: "2",
  id: "fn_1",
  key: "send",
  displayName: "Send email",
  description: "",
  inputs: [],
  impl: { uses: { app: "sendgrid", action: "send" } },
  valid: true,
};

const SUMMARY_A: FunctionSummary = {
  id: "fn_1",
  key: "send",
  displayName: "Send email",
  description: "",
  updatedAt: "2026-08-09T00:00:00.000Z",
  valid: true,
};

const SUMMARY_B: FunctionSummary = {
  id: "fn_2",
  key: "notify",
  displayName: "Notify",
  description: "",
  updatedAt: "2026-08-09T00:00:01.000Z",
  valid: false,
};

Deno.test(
  "console.functions: list/get/upsert are functions on a constructed client; invoke does NOT exist",
  () => {
    // Runtime, not type-level: a namespace that silently lost a method would
    // still typecheck everywhere else in this suite.
    const c = new W6WClient({ baseUrl: "https://api.example.com", token: "t" });
    assertEquals(typeof c.console.functions.list, "function");
    assertEquals(typeof c.console.functions.get, "function");
    assertEquals(typeof c.console.functions.upsert, "function");
    // Direct check on the Requirement's anti-duplication pin: no
    // console.functions.invoke exists at all.
    // deno-lint-ignore no-explicit-any
    assertEquals(typeof (c.console.functions as any).invoke, "undefined");
    // Regression-proof: base client.run stays untouched.
    assertEquals(typeof c.run, "function");
  },
);

Deno.test(
  "console.functions.get performs the pinned valid-splice merge, NOT the raw {function, valid} body",
  async () => {
    // Stored definition as the server sends it: `valid` is NOT part of the
    // Fn/FnImpl shape itself, only a top-level sibling on the envelope.
    const stored = {
      manifestVersion: "2",
      id: "fn_1",
      key: "send",
      inputs: [],
      impl: { uses: { app: "a", action: "b" } },
    };
    const c = client(() => json({ function: stored, valid: true }));

    const res = await c.client.console.functions.get("fn_1");

    // The pinned merge: `valid` spliced at the TOP LEVEL of the definition
    // itself, matching studio's FunctionsPage.tsx `setDraft(fn)` expectation.
    // A mutant returning the raw two-key {function, valid} body would fail
    // this exact assertion (the result would carry a `function` key instead
    // of the definition's own fields).
    assertEquals(res, { ...stored, valid: true });
    assertEquals(Object.hasOwn(res, "function"), false);
    assertEquals(c.calls[0].method, "GET");
  },
);

Deno.test("console.functions.list unwraps the functions envelope", async () => {
  const c = client(() => json({ functions: [SUMMARY_A, SUMMARY_B] }));

  const res = await c.client.console.functions.list();

  assertEquals(res, [SUMMARY_A, SUMMARY_B]);
  assertEquals(c.calls[0].method, "GET");
  assertEquals(c.calls[0].url, "https://api.example.com/functions");
});

Deno.test(
  "console.functions.upsert unwraps the function envelope and sends the definition verbatim",
  async () => {
    const c = client(() => json({ function: { id: "fn_1", key: "send" } }, 201));

    const res = await c.client.console.functions.upsert(FN);

    assertEquals(res, { id: "fn_1", key: "send" });
    assertEquals(JSON.parse(c.calls[0].body ?? "null"), FN);
    assertEquals(c.calls[0].method, "POST");
    assertEquals(c.calls[0].url, "https://api.example.com/functions");
  },
);

Deno.test("console.functions.get throws on a genuine non-2xx", async () => {
  const c = client(() =>
    json({ error: { code: "unknown_function", message: "Not registered." } }, 404)
  );

  const err = await assertRejects(() => c.client.console.functions.get("fn_missing"), ApiError);

  assertEquals(err.status, 404);
  assertEquals(err.code, "unknown_function");
});

Deno.test("console.functions.upsert throws on a genuine non-2xx", async () => {
  const c = client(() => json({ error: { code: "function_conflict", message: "Owned." } }, 409));

  const err = await assertRejects(() => c.client.console.functions.upsert(FN), ApiError);

  assertEquals(err.status, 409);
  assertEquals(err.code, "function_conflict");
});

Deno.test("console.functions.get percent-encodes id via the `path` tag", async () => {
  const c = client(() => json({ function: FN, valid: true }));

  await c.client.console.functions.get("fn 1");

  assertEquals(c.calls[0].url, "https://api.example.com/functions/fn%201");
});
