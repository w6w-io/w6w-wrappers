/**
 * `client.vars.*`, against an injected fake `fetch`.
 *
 * No case here needs a live server (`docs/implementation.md` §9). Beyond the
 * per-operation assertions, one thing this file pins that the documents suite
 * cannot: **no variable request ever carries a query string.** Variables are
 * scoped by tenant/subject only, and a wrapper that helpfully forwarded the
 * client's default scope would be sending an argument the server ignores.
 */

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { W6wClient } from "../src/client.ts";
import type { FetchLike } from "../src/config.ts";
import { ApiError } from "../src/errors.ts";
import type { Var } from "../src/types.ts";

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

function json(body: unknown, status = 200, statusText?: string): Response {
  return new Response(JSON.stringify(body), {
    status,
    statusText,
    headers: { "content-type": "application/json" },
  });
}

const VAR: Var = {
  id: "var_1",
  name: "sender_email",
  type: "string",
  value: "hello@example.com",
  description: "From address.",
  createdAt: "2026-07-01T12:00:00.000Z",
  updatedAt: "2026-07-22T18:03:00.000Z",
};

/**
 * A client wired to a fake transport. It is built **with** a client-level
 * default scope on purpose: the point of several cases below is that the
 * variable namespace does not forward it.
 */
function client(respond: (call: Call) => Response): { client: W6wClient; calls: Call[] } {
  const fake = fakeFetch(respond);
  return {
    client: new W6wClient({
      baseUrl: "https://api.example.com",
      token: "tok_1",
      project: "prj_default",
      fetch: fake.fetch,
    }),
    calls: fake.calls,
  };
}

Deno.test("vars: all six operations are functions on a constructed client", () => {
  // Runtime, not type-level: a namespace that silently lost a method would
  // still typecheck everywhere else in this suite.
  const c = new W6wClient({ baseUrl: "https://api.example.com", token: "t" });
  for (const name of ["list", "get", "getByName", "create", "update", "delete"] as const) {
    assertEquals(typeof c.vars[name], "function", `vars.${name} is missing`);
  }
});

Deno.test("vars.list unwraps the envelope and returns the array", async () => {
  const c = client(() => json({ vars: [VAR] }));

  const vars = await c.client.vars.list();

  assertEquals(vars, [VAR]);
  assertEquals(c.calls.length, 1);
  assertEquals(c.calls[0].method, "GET");
  assertEquals(c.calls[0].url, "https://api.example.com/vars");
  assertEquals(c.calls[0].headers.get("authorization"), "Bearer tok_1");
});

Deno.test("no var operation ever sends a query string, even with one configured", async () => {
  // The client below carries a default scope, and documents would forward it.
  // Variables are not scoped that way server-side — the `vars` table has no
  // such column and no `vars` route reads the parameter — so forwarding it
  // would be an argument that typechecks and does nothing. The namespace is
  // constructed without the client's configuration precisely so it cannot.
  const ok = client(() => json({ var: VAR, vars: [VAR], ok: true }));

  assertEquals(ok.client.config.project, "prj_default");

  await ok.client.vars.list();
  await ok.client.vars.get("var_1");
  await ok.client.vars.getByName("sender_email");
  await ok.client.vars.create({ name: "n", type: "string", value: "v" });
  await ok.client.vars.update("var_1", { value: "v2" });
  await ok.client.vars.delete("var_1");

  assertEquals(ok.calls.length, 6);
  for (const call of ok.calls) {
    assertEquals(call.url.includes("?"), false, `unexpected query string: ${call.url}`);
  }
  assertEquals(ok.calls.map((call) => call.url), [
    "https://api.example.com/vars",
    "https://api.example.com/vars/var_1",
    "https://api.example.com/vars/by-name/sender_email",
    "https://api.example.com/vars",
    "https://api.example.com/vars/var_1",
    "https://api.example.com/vars/var_1",
  ]);
});

Deno.test("vars.get reads the singular `var` envelope key", async () => {
  // `var` is a reserved word in TypeScript, so the key is read as a property
  // and never destructured into a binding of that name.
  const c = client(() => json({ var: VAR }));

  const v = await c.client.vars.get("var_1");

  assertEquals(v, VAR);
  assertEquals(c.calls[0].url, "https://api.example.com/vars/var_1");
});

Deno.test("vars.getByName addresses the by-name route with the name encoded", async () => {
  const c = client(() => json({ var: VAR }));

  await c.client.vars.getByName("sender_email");
  // A name the server's own rule would reject is still encoded and SENT — the
  // rule is the server's to enforce (`400 invalid_name`), not the client's to
  // pre-empt with an error that would go stale the moment the rule changed.
  await c.client.vars.getByName("a/b c");

  assertEquals(c.calls[0].url, "https://api.example.com/vars/by-name/sender_email");
  assertEquals(c.calls[1].url, "https://api.example.com/vars/by-name/a%2Fb%20c");
});

Deno.test("vars.create posts name+type+value+description and accepts 201", async () => {
  const c = client(() => json({ var: VAR }, 201));

  const created = await c.client.vars.create({
    name: "sender_email",
    type: "string",
    value: "hello@example.com",
    description: "From address.",
  });

  assertEquals(created, VAR);
  assertEquals(c.calls[0].method, "POST");
  assertEquals(c.calls[0].url, "https://api.example.com/vars");
  assertEquals(c.calls[0].headers.get("content-type"), "application/json");
  assertEquals(JSON.parse(c.calls[0].body ?? "null"), {
    name: "sender_email",
    type: "string",
    value: "hello@example.com",
    description: "From address.",
  });
});

Deno.test("vars.create passes a json value through opaquely", async () => {
  // `value` is `unknown` on purpose: it is whatever the declared type allows,
  // including an arbitrary document, and the wrapper models none of it.
  const c = client(() => json({ var: VAR }, 201));

  await c.client.vars.create({ name: "cfg", type: "json", value: { a: [1, null, "x"] } });

  assertEquals(JSON.parse(c.calls[0].body ?? "null"), {
    name: "cfg",
    type: "json",
    value: { a: [1, null, "x"] },
  });
});

Deno.test("vars.update patches by id and cannot carry a name", async () => {
  const c = client(() => json({ var: VAR }));

  const updated = await c.client.vars.update("var_1", { value: "new@example.com" });

  assertEquals(updated, VAR);
  assertEquals(c.calls[0].method, "PATCH");
  // Addressed by the server-issued id (D6), never by the name.
  assertEquals(c.calls[0].url, "https://api.example.com/vars/var_1");
  // A `value` with no `type` is validated against the existing type server-side,
  // so the body must carry exactly what was asked for and nothing more.
  assertEquals(JSON.parse(c.calls[0].body ?? "null"), { value: "new@example.com" });

  const patch = { value: 1, name: "sneaky" } as { value: number };
  await c.client.vars.update("var_1", patch);
  assertEquals(JSON.parse(c.calls[1].body ?? "null"), { value: 1 });
});

Deno.test("vars.delete returns nothing rather than {ok:true}", async () => {
  const c = client(() => json({ ok: true }));

  const result = await c.client.vars.delete("var_1");

  assertEquals(result, undefined);
  assertEquals(c.calls[0].method, "DELETE");
  assertEquals(c.calls[0].url, "https://api.example.com/vars/var_1");
  assertEquals(c.calls[0].body, null);
});

Deno.test("vars: a 404 unknown_var reaches the caller as an ApiError", async () => {
  const c = client(() => json({ error: { code: "unknown_var", message: "No such." } }, 404));

  const err = await assertRejects(() => c.client.vars.get("var_missing"), ApiError);

  assertEquals(err.status, 404);
  assertEquals(err.code, "unknown_var");
  assertEquals(err.message, "No such.");
});

Deno.test("vars: a 409 var_exists surfaces its code, unswallowed", async () => {
  const c = client(() =>
    json({ error: { code: "var_exists", message: "Name taken." } }, 409, "Conflict")
  );

  const err = await assertRejects(
    () => c.client.vars.create({ name: "sender_email", type: "string", value: "x" }),
    ApiError,
  );

  assertEquals(err.status, 409);
  assertEquals(err.code, "var_exists");
});

Deno.test("vars: the id is percent-encoded into every id-addressed route", async () => {
  // Same gap as the documents suite: every id fixture here is `var_1`, which
  // encodes to itself, so dropping the `path` tag from `vars.get` left all gates
  // green. An id carrying a `/` makes the tag load-bearing.
  const c = client(() => json({ var: VAR, ok: true }));

  await c.client.vars.get("var/1");
  await c.client.vars.update("var/1", { value: 1 });
  await c.client.vars.delete("var/1");

  assertEquals(c.calls[0].url, "https://api.example.com/vars/var%2F1");
  assertEquals(c.calls[1].url, "https://api.example.com/vars/var%2F1");
  assertEquals(c.calls[2].url, "https://api.example.com/vars/var%2F1");
});

Deno.test("vars.delete does not swallow a 404 — it is not a silent success", async () => {
  const c = client(() => json({ error: { code: "unknown_var", message: "No such." } }, 404));

  const err = await assertRejects(() => c.client.vars.delete("var_missing"), ApiError);

  assertEquals(err.status, 404);
  assertEquals(err.code, "unknown_var");
});

Deno.test("vars: an envelope key present but null is bad_response, not null", async () => {
  // A JSON null used to resolve `vars.get()` to `null` typed `Var`.
  const single = client(() => json({ var: null }));
  const errSingle = await assertRejects(() => single.client.vars.get("var_1"), ApiError);
  assertEquals(errSingle.code, "bad_response");
  assertStringIncludes(errSingle.message, '"var"');

  const many = client(() => json({ vars: null }));
  const errMany = await assertRejects(() => many.client.vars.list(), ApiError);
  assertEquals(errMany.code, "bad_response");
  assertStringIncludes(errMany.message, '"vars"');
});

Deno.test("vars: a 200 missing its envelope key is bad_response, not undefined", async () => {
  const c = client(() => json({ unexpected: true }));

  const err = await assertRejects(() => c.client.vars.list(), ApiError);

  assertEquals(err.code, "bad_response");
  assertEquals(err.status, 200);
  assertStringIncludes(err.message, '"vars"');
});
