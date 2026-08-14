/**
 * `client.console.projects.*`, against an injected fake `fetch`.
 *
 * No case here needs a live server (`docs/implementation.md` §9). Unlike
 * `console.reliability`/`console.auth`/`console.dashboard` (T2.1.1/SP2.1),
 * `list`/`create` here DO carry an envelope key — `{ projects: [...] }` /
 * `{ project: {...} }` — so the cases below discriminate the opposite mutant
 * from those suites: a `list`/`create` that forgot to call `unwrap()` and
 * returned the envelope object wholesale.
 */

import { assertEquals } from "@std/assert";
import { W6WClient } from "../../src/client.ts";
import type { FetchLike } from "../../src/config.ts";
import type { Project } from "../../src/console/projects.ts";

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

const PROJECT_A: Project = {
  id: "prj_1",
  account: "acct_1",
  name: "Acme",
  isDefault: true,
  status: "active",
  createdAt: "2026-07-01T12:00:00.000Z",
  updatedAt: "2026-07-22T18:03:00.000Z",
};

const PROJECT_B: Project = {
  id: "prj_2",
  account: "acct_1",
  name: "Sandbox",
  isDefault: false,
  status: "active",
  createdAt: "2026-07-05T12:00:00.000Z",
  updatedAt: "2026-07-23T18:03:00.000Z",
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

Deno.test("console.projects: list/create/delete are functions on a constructed client", () => {
  // Runtime, not type-level: a namespace that silently lost a method would
  // still typecheck everywhere else in this suite.
  const c = new W6WClient({ baseUrl: "https://api.example.com", token: "t" });
  assertEquals(typeof c.console.projects.list, "function");
  assertEquals(typeof c.console.projects.create, "function");
  assertEquals(typeof c.console.projects.delete, "function");
});

Deno.test("console.projects.list unwraps the envelope and returns the array", async () => {
  const c = client(() => json({ projects: [PROJECT_A, PROJECT_B] }));

  const res = await c.client.console.projects.list();

  // A mutant that returned `res.body` directly (skipping `unwrap`) would fail
  // this assertion — it would see the envelope object, not the array it wraps.
  assertEquals(res, [PROJECT_A, PROJECT_B]);
  assertEquals(c.calls.length, 1);
  assertEquals(c.calls[0].method, "GET");
  assertEquals(c.calls[0].url, "https://api.example.com/projects");
  assertEquals(c.calls[0].headers.get("authorization"), "Bearer tok_1");
});

Deno.test("console.projects.create sends { name } verbatim and unwraps the singular envelope", async () => {
  const c = client(() => json({ project: PROJECT_A }, 201));

  const created = await c.client.console.projects.create("Acme");

  assertEquals(created, PROJECT_A);
  assertEquals(c.calls[0].method, "POST");
  assertEquals(c.calls[0].url, "https://api.example.com/projects");
  assertEquals(JSON.parse(c.calls[0].body ?? "null"), { name: "Acme" });
});

Deno.test("console.projects.delete sends DELETE to the right path and resolves void, discarding {ok:true}", async () => {
  const c = client(() => json({ ok: true }));

  const res = await c.client.console.projects.delete("proj_1");

  assertEquals(res, undefined);
  assertEquals(c.calls[0].method, "DELETE");
  assertEquals(c.calls[0].url, "https://api.example.com/projects/proj_1");
  assertEquals(c.calls[0].body, null);
});

Deno.test("console.projects.delete percent-encodes the id via the `path` tag, not string concatenation", async () => {
  const c = client(() => json({ ok: true }));

  await c.client.console.projects.delete("proj a");

  assertEquals(c.calls[0].url, "https://api.example.com/projects/proj%20a");
});
