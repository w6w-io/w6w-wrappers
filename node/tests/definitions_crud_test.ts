/**
 * The definition lifecycle on `client.workflows.*` and `client.functions.*`,
 * against an injected fake `fetch`.
 *
 * These two domains share a file because they share the shape that makes them
 * easy to get wrong: **one upsert route serving two methods**. `create` and
 * `update` are the same POST, and everything that distinguishes them happens in
 * the wrapper — minting an id, or pinning the one the caller addressed. A test
 * per method would let the two drift; the cases below assert them against each
 * other.
 *
 * Three things pinned here that no other suite can see:
 *
 * 1. **The minted id is real and is sent.** The server rejects a body with no
 *    `id`, so a `create` that forwarded the caller's object verbatim would fail
 *    on the most natural call there is. The assertion is on the *wire*, not on
 *    the return value.
 * 2. **`update` overrides the body's `id`.** `update("wf_a", defOfB)` must write
 *    to A. The failure mode is silent: it writes to B and returns B's id, which
 *    reads like success.
 * 3. **The precondition header is absent unless asked for.** The server parses
 *    whatever arrives and answers `400 invalid_precondition` for a value it
 *    cannot read, so an empty or `"null"` string is worse than no header.
 */

import { assertEquals, assertRejects } from "@std/assert";
import { W6WClient } from "../src/client.ts";
import type { FetchLike } from "../src/config.ts";
import { ApiError } from "../src/errors.ts";
import type { FunctionSummary } from "../src/types.ts";

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

/**
 * A client wired to a fake transport, **with** a client-level default project.
 *
 * Load-bearing: the workflow write path is supposed to forward that default,
 * and the Function one is supposed to ignore it entirely — an asymmetry the
 * server dictates, and one that only shows up against a client that has a
 * default to forward in the first place.
 */
function client(respond: (call: Call) => Response): { client: W6WClient; calls: Call[] } {
  const fake = fakeFetch(respond);
  return {
    client: new W6WClient({
      baseUrl: "https://api.example.com",
      token: "tok_1",
      project: "prj_default",
      fetch: fake.fetch,
    }),
    calls: fake.calls,
  };
}

/** The save body a caller hands `create`, with no `id` of its own. */
const WORKFLOW_DEF = { manifestVersion: "2", name: "nightly-sync", steps: [] };

/** What `POST /workflows` answers with. */
const WORKFLOW_SAVED = {
  workflow: { id: "wf_1", name: "nightly-sync" },
  scheduled: false,
  updatedAt: "2026-08-22T09:00:00.000Z",
};

const FUNCTION_SUMMARY: FunctionSummary = {
  id: "fn_1",
  key: "send-email",
  displayName: "Send email",
  description: "",
  updatedAt: "2026-08-22T09:00:00.000Z",
  valid: true,
};

Deno.test("workflows: all seven operations are functions on a constructed client", () => {
  // Runtime, not type-level: a namespace that silently lost a method would
  // still typecheck everywhere else in this suite.
  const c = new W6WClient({ baseUrl: "https://api.example.com", token: "t" });
  for (const name of ["list", "run", "get", "create", "update", "archive", "delete"] as const) {
    assertEquals(typeof c.workflows[name], "function", `workflows.${name} is missing`);
  }
});

Deno.test("functions: all six operations are functions on a constructed client", () => {
  const c = new W6WClient({ baseUrl: "https://api.example.com", token: "t" });
  for (const name of ["run", "list", "get", "create", "update", "delete"] as const) {
    assertEquals(typeof c.functions[name], "function", `functions.${name} is missing`);
  }
});

Deno.test("workflows.get returns the whole body — there is no envelope to peel", async () => {
  const detail = {
    workflow: { id: "wf_1", name: "nightly-sync", status: "draft", tags: [] },
    sourceRef: null,
    updatedAt: "2026-08-22T09:00:00.000Z",
  };
  const c = client(() => json(detail));

  const got = await c.client.workflows.get("wf_1");

  assertEquals(got, detail);
  assertEquals(c.calls[0].url, "https://api.example.com/workflows/wf_1");
  assertEquals(c.calls[0].method, "GET");
});

Deno.test("workflows.get: updatedAt stays OUTSIDE the definition", async () => {
  // The definition is the portable document. A wrapper that spliced the
  // server's timestamp into it would put it in the object the caller sends
  // straight back to `update`.
  const c = client(() =>
    json({
      workflow: { id: "wf_1", name: "nightly-sync" },
      sourceRef: null,
      updatedAt: "2026-08-22T09:00:00.000Z",
    })
  );

  const got = await c.client.workflows.get("wf_1");

  assertEquals("updatedAt" in got.workflow, false);
  assertEquals(got.updatedAt, "2026-08-22T09:00:00.000Z");
});

Deno.test("workflows.create mints a wf_ id when the definition carries none", async () => {
  const c = client(() => json(WORKFLOW_SAVED, 201));

  await c.client.workflows.create(WORKFLOW_DEF);

  const sent = JSON.parse(c.calls[0].body ?? "{}");
  // The server rejects a body with no `id` outright, so this is the assertion
  // that the operation works at all — not a cosmetic one about id format.
  assertEquals(typeof sent.id, "string");
  assertEquals(sent.id.startsWith("wf_"), true);
  assertEquals(sent.name, "nightly-sync");
  assertEquals(c.calls[0].method, "POST");
  assertEquals(c.calls[0].url, "https://api.example.com/workflows?project=prj_default");
});

Deno.test("workflows.create forwards an id the caller supplied, untouched", async () => {
  // Minting is a fallback, not a policy: a seeded or imported definition keeps
  // the id it was written with, or re-importing one would fork it in two.
  const c = client(() => json(WORKFLOW_SAVED, 201));

  await c.client.workflows.create({ ...WORKFLOW_DEF, id: "wf_seeded" });

  assertEquals(JSON.parse(c.calls[0].body ?? "{}").id, "wf_seeded");
});

Deno.test("workflows.create returns the save result, flattened by nothing", async () => {
  const c = client(() => json(WORKFLOW_SAVED, 201));

  assertEquals(await c.client.workflows.create(WORKFLOW_DEF), WORKFLOW_SAVED);
});

Deno.test("workflows.update pins the addressed id over the body's own", async () => {
  // The silent failure this prevents: writing to B while reading as a write
  // to A, and answering with B's id so it looks like it worked.
  const c = client(() => json(WORKFLOW_SAVED, 201));

  await c.client.workflows.update("wf_a", { ...WORKFLOW_DEF, id: "wf_b" });

  assertEquals(JSON.parse(c.calls[0].body ?? "{}").id, "wf_a");
});

Deno.test("workflows.update sends the precondition header only when given", async () => {
  const c = client(() => json(WORKFLOW_SAVED, 201));

  await c.client.workflows.update("wf_1", WORKFLOW_DEF);
  assertEquals(c.calls[0].headers.get("x-w6w-if-unmodified-since"), null);

  await c.client.workflows.update("wf_1", WORKFLOW_DEF, {
    ifUnmodifiedSince: "2026-08-22T09:00:00.000Z",
  });
  assertEquals(
    c.calls[1].headers.get("x-w6w-if-unmodified-since"),
    "2026-08-22T09:00:00.000Z",
  );
});

Deno.test("workflows.update sends no precondition header for a null token", async () => {
  // `get` on a row the server has never stamped can hand back `null`, and the
  // header must then be absent rather than the string "null" — which the
  // server answers `400 invalid_precondition`, an error naming something the
  // caller never asked for.
  const c = client(() => json(WORKFLOW_SAVED, 201));

  await c.client.workflows.update("wf_1", WORKFLOW_DEF, { ifUnmodifiedSince: null });

  assertEquals(c.calls[0].headers.get("x-w6w-if-unmodified-since"), null);
});

Deno.test("workflows: a per-call project overrides the client default", async () => {
  const c = client(() => json(WORKFLOW_SAVED, 201));

  await c.client.workflows.create(WORKFLOW_DEF, { project: "prj_other" });

  assertEquals(c.calls[0].url, "https://api.example.com/workflows?project=prj_other");
});

Deno.test("workflows.archive unwraps the workflow envelope", async () => {
  const archived = { id: "wf_1", name: "nightly-sync", status: "archived", tags: [] };
  const c = client(() => json({ workflow: archived }));

  assertEquals(await c.client.workflows.archive("wf_1"), archived);
  assertEquals(c.calls[0].method, "POST");
  assertEquals(c.calls[0].url, "https://api.example.com/workflows/wf_1/archive");
});

Deno.test("workflows.delete returns nothing rather than {ok:true}", async () => {
  const c = client(() => json({ ok: true }));

  assertEquals(await c.client.workflows.delete("wf_1"), undefined);
  assertEquals(c.calls[0].method, "DELETE");
});

Deno.test("workflows.delete does not archive on the caller's behalf", async () => {
  // A 409 is a real signal: the caller asked to delete something that is still
  // live. Completing the two-step destructive path for them is how a workflow
  // someone only meant to look at gets deleted.
  const c = client(() =>
    json({ error: { code: "workflow_not_archived", message: "Archive it first." } }, 409)
  );

  const err = await assertRejects(
    () => c.client.workflows.delete("wf_1"),
    ApiError,
  );
  assertEquals(err.code, "workflow_not_archived");
  assertEquals(c.calls.length, 1);
});

Deno.test("workflows: the id is percent-encoded into every id-addressed route", async () => {
  const c = client(() => json({ workflow: {}, sourceRef: null, updatedAt: "x" }));

  await c.client.workflows.get("wf_a/b");

  assertEquals(c.calls[0].url, "https://api.example.com/workflows/wf_a%2Fb");
});

Deno.test("functions.list unwraps the functions envelope", async () => {
  const c = client(() => json({ functions: [FUNCTION_SUMMARY] }));

  assertEquals(await c.client.functions.list(), [FUNCTION_SUMMARY]);
});

Deno.test("functions: no request on this domain ever carries a project", async () => {
  // The route reads no `?project=` at all, so forwarding the client's default
  // would be sending an argument the server ignores — and inventing a
  // parameter is the one thing `endpoints.json` warns wrappers off.
  const c = client((call) =>
    call.method === "GET" && call.url.includes("/functions/fn_1")
      ? json({ function: { id: "fn_1" }, valid: true })
      : json({ functions: [] })
  );

  await c.client.functions.list();
  await c.client.functions.get("fn_1");

  for (const call of c.calls) assertEquals(call.url.includes("project="), false);
});

Deno.test("functions.get keeps `valid` a sibling, never spliced into the definition", async () => {
  // `valid` is computed per request and is not part of the stored document.
  // Splicing it in would put it inside the object a caller sends back to
  // `update` — which is the round trip this shape exists to keep clean.
  const c = client(() => json({ function: { id: "fn_1", key: "send-email" }, valid: false }));

  const got = await c.client.functions.get("fn_1");

  assertEquals(got.valid, false);
  assertEquals("valid" in got.function, false);
});

Deno.test("functions.create mints an fn_ id but never a key", async () => {
  // The key is the name the Function is CALLED by. Minting one would name the
  // caller's Function for them, and the server validates the grammar on first
  // save anyway.
  const c = client(() => json({ function: { id: "fn_1", key: "send-email" } }, 201));

  await c.client.functions.create({ key: "send-email", inputs: [] });

  const sent = JSON.parse(c.calls[0].body ?? "{}");
  assertEquals(sent.id.startsWith("fn_"), true);
  assertEquals(sent.key, "send-email");
});

Deno.test("functions.create unwraps the function envelope to {id, key}", async () => {
  const c = client(() => json({ function: { id: "fn_1", key: "send-email" } }, 201));

  assertEquals(await c.client.functions.create({ key: "send-email", inputs: [] }), {
    id: "fn_1",
    key: "send-email",
  });
});

Deno.test("functions.update pins the addressed id over the body's own", async () => {
  const c = client(() => json({ function: { id: "fn_a", key: "send-email" } }, 201));

  await c.client.functions.update("fn_a", { id: "fn_b", key: "send-email", inputs: [] });

  assertEquals(JSON.parse(c.calls[0].body ?? "{}").id, "fn_a");
});

Deno.test("functions.delete returns nothing, and does not swallow a 404", async () => {
  const ok = client(() => json({ ok: true }));
  assertEquals(await ok.client.functions.delete("fn_1"), undefined);
  assertEquals(ok.calls[0].method, "DELETE");

  const missing = client(() =>
    json({ error: { code: "unknown_function", message: "Not registered." } }, 404)
  );
  const err = await assertRejects(() => missing.client.functions.delete("fn_x"), ApiError);
  assertEquals(err.code, "unknown_function");
});

Deno.test("functions: a 409 function_key_conflict surfaces its own code", async () => {
  // Two distinct 409s live on this route — an ownership clash on the id, and
  // the key already being taken. A wrapper that flattened them would leave a
  // caller unable to tell "rename it" from "you do not own this".
  const c = client(() =>
    json({ error: { code: "function_key_conflict", message: "Key taken." } }, 409)
  );

  const err = await assertRejects(
    () => c.client.functions.create({ key: "send-email", inputs: [] }),
    ApiError,
  );
  assertEquals(err.code, "function_key_conflict");
});
