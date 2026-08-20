/**
 * `client.functions.run()` and `client.endpoints.run()`, against an injected
 * fake `fetch`.
 *
 * These two exist so a caller can run the thing they NAMED rather than the id
 * the host issued. The cases below are the properties that makes true:
 *
 * - **the name is the first argument**, not a field inside an options object —
 *   an implementation that kept `run({name})` fails every case here;
 * - **id or key, one slot** — both forms reach the same path, so a wrapper that
 *   prefixed, tagged or branched on the shape fails the id cases;
 * - **`payload` is the one word** — the wire spells it `inputs` for a Function
 *   and `input` for an Endpoint, and reconciling that is the wrapper's job, so
 *   each case asserts the SENT body, not just the call count;
 * - **a Function returns its output, an Endpoint returns the envelope** — the
 *   asymmetry is deliberate (an Endpoint's `kind` is real information), and a
 *   wrapper that unwrapped both the same way fails one side or the other.
 *
 * No case needs a live server (`docs/implementation.md` §9).
 */

import { assertEquals, assertRejects } from "@std/assert";
import { W6WClient } from "../src/client.ts";
import type { FetchLike } from "../src/config.ts";
import { ApiError } from "../src/errors.ts";

/** One recorded call to the fake transport. */
interface Call {
  url: string;
  method: string | undefined;
  body: string | null;
}

/** A `fetch`-shaped fake; `respond` produces the `Response` to hand back. */
function fakeFetch(respond: (call: Call) => Response): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: FetchLike = (input, init) => {
    calls.push({
      url: input,
      method: init?.method,
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

const sentBody = (call: Call): Record<string, unknown> => JSON.parse(call.body ?? "null");

// ── functions.run ───────────────────────────────────────────────────────────

Deno.test("functions.run — the KEY is the first argument and lands in the path", async () => {
  const { client: c, calls } = client(() => json({ output: { id: "msg_1" } }));

  const output = await c.functions.run("send-email", {
    payload: { to: "ada@example.com", subject: "Hi" },
  });

  assertEquals(calls.length, 1);
  assertEquals(calls[0].method, "POST");
  assertEquals(calls[0].url, "https://api.example.com/functions/send-email/invoke");
  // `payload` on the way in, `inputs` on the wire — the rename is the point.
  assertEquals(sentBody(calls[0]), { inputs: { to: "ada@example.com", subject: "Hi" } });
  // The OUTPUT, not an envelope: the kind is already settled by the method name.
  assertEquals(output, { id: "msg_1" });
});

Deno.test("functions.run — an id works in the same slot, with no prefix or flag", async () => {
  const { client: c, calls } = client(() => json({ output: null }));

  await c.functions.run("fn_a9b39917-cd4e-4eea-ab89-c3d079684193", {});

  assertEquals(
    calls[0].url,
    "https://api.example.com/functions/fn_a9b39917-cd4e-4eea-ab89-c3d079684193/invoke",
  );
});

Deno.test("functions.run — no options at all still sends `inputs: {}`, never an absent key", async () => {
  const { client: c, calls } = client(() => json({ output: 1 }));

  await c.functions.run("send-email");

  // `{}` says "no input"; an absent key says "I forgot", and the server's
  // parameter schemas are written against an object.
  assertEquals(sentBody(calls[0]), { inputs: {} });
});

Deno.test("functions.run — a name is percent-encoded into the path, never interpolated raw", async () => {
  const { client: c, calls } = client(() => json({ output: null }));

  await c.functions.run("a b/c");

  assertEquals(calls[0].url, "https://api.example.com/functions/a%20b%2Fc/invoke");
});

Deno.test("functions.run — a success body with no `output` is a bad_response, not `undefined`", async () => {
  const { client: c } = client(() => json({ notOutput: 1 }));

  const err = await assertRejects(() => c.functions.run("send-email"), ApiError);
  assertEquals((err as ApiError).code, "bad_response");
});

// A Function's output is an opaque pass-through: an action that returns nothing
// yields `{"output": null}`, which is a SUCCESSFUL run. The shared `unwrap`
// helper treats null as a malformed body — correct for a `documents` envelope,
// wrong here — so this operation guards on PRESENCE of the key instead.
Deno.test("functions.run — a null output is a result, not a bad_response", async () => {
  const { client: c } = client(() => json({ output: null }));

  assertEquals(await c.functions.run("send-email"), null);
});

Deno.test("functions.run — a 404 raises ApiError carrying the server's code", async () => {
  const { client: c } = client(() =>
    json({ error: { code: "unknown_function", message: "Not registered." } }, 404)
  );

  const err = await assertRejects(() => c.functions.run("nope"), ApiError);
  assertEquals((err as ApiError).code, "unknown_function");
});

// ── endpoints.run ───────────────────────────────────────────────────────────

Deno.test("endpoints.run — key first, `payload` becomes `input`, envelope returned whole", async () => {
  const { client: c, calls } = client(() => json({ kind: "action", value: { ok: true } }));

  const envelope = await c.endpoints.run("send-email", { payload: { to: "ada" } });

  assertEquals(calls[0].url, "https://api.example.com/endpoints/send-email/invoke");
  // Singular `input` here, plural `inputs` for a Function — the wire is
  // inconsistent and the wrapper is where that stops being the caller's problem.
  assertEquals(sentBody(calls[0]), { input: { to: "ada" } });
  assertEquals(envelope, { kind: "action", value: { ok: true } });
});

Deno.test("endpoints.run — the async arm (202, a workflow) is returned, not raised", async () => {
  const { client: c } = client(() =>
    json({ kind: "workflow", runId: "run_1", status: "queued" }, 202)
  );

  const envelope = await c.endpoints.run("nightly");

  assertEquals(envelope, { kind: "workflow", runId: "run_1", status: "queued" });
});

Deno.test("endpoints.run — an unknown `kind` is handed back verbatim, every field intact", async () => {
  const { client: c } = client(() => json({ kind: "something-new", extra: 42 }));

  const envelope = await c.endpoints.run("x") as Record<string, unknown>;

  assertEquals(envelope.kind, "something-new");
  assertEquals(envelope.extra, 42);
});

Deno.test("endpoints.run — a success body with no string `kind` is a bad_response", async () => {
  const { client: c } = client(() => json({}));

  const err = await assertRejects(() => c.endpoints.run("x"), ApiError);
  assertEquals((err as ApiError).code, "bad_response");
});
