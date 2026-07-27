/**
 * `client.me()`, against an injected fake `fetch`.
 *
 * No case here needs a live server (`docs/implementation.md` §9) — which
 * matters more for this operation than for any other, because `/api/me` is
 * `status: "planned"`: no server serves that path yet, so a test that reached
 * for one would be testing the 404.
 *
 * What this file pins that no other suite can: the response body is **flat**.
 * `me` is the one read operation with no envelope key, so every case below
 * asserts the identity fields at the top level of the returned value, and the
 * suite would fail loudly the day someone "helpfully" wraps them in a `user`
 * object.
 */

import { assertEquals, assertNotEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { W6wClient } from "../src/client.ts";
import type { FetchLike } from "../src/config.ts";
import { ApiError } from "../src/errors.ts";
import type { Me } from "../src/types.ts";
import { VERSION } from "../src/version.ts";

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

/** The identity half, exactly as the server's handler returns it — flat. */
const IDENTITY = {
  tenant: "default",
  subject: "user_01HQ",
  account: "default",
  role: "admin",
};

Deno.test("me: a flat body with no versions parses cleanly", async () => {
  // This is what a server that has not grown the versions block yet returns —
  // and what the existing identity handler returns today. It must be a clean
  // parse, not a partial one: `versions` is optional and additive.
  const c = client(() => json(IDENTITY));

  const me = await c.client.me();

  // Read off the TOP LEVEL. A nested `{user: {...}}` envelope would fail here,
  // which is the point: the flat shape is the contract (D15).
  assertEquals(me.tenant, "default");
  assertEquals(me.subject, "user_01HQ");
  assertEquals(me.account, "default");
  assertEquals(me.role, "admin");

  assertEquals(c.calls.length, 1);
  assertEquals(c.calls[0].method, "GET");
  assertEquals(c.calls[0].url, "https://api.example.com/api/me");
  assertEquals(c.calls[0].headers.get("authorization"), "Bearer tok_1");
  // A bodiless GET: no body, and therefore no content-type either.
  assertEquals(c.calls[0].body, null);
  assertEquals(c.calls[0].headers.get("content-type"), null);
});

Deno.test("me: versions.wrapper is filled in by the client", async () => {
  const c = client(() => json(IDENTITY));

  const me = await c.client.me();

  // The server cannot know the wrapper's version, so the client supplies it —
  // even when the server sent no versions block at all.
  assertEquals(me.versions?.wrapper, VERSION);
  // Asserted against the constant, never against a hard-coded string: a version
  // bump must not have to edit this file, and a placeholder zero version must
  // never be assertable here (D5).
  assertNotEquals(VERSION, "");
});

Deno.test("me: an unrecognised key inside versions is tolerated, not rejected", async () => {
  // `versions` is an OPEN string map. The server adding a key is a purely
  // additive change and an installed client must keep working — so the unknown
  // key has to survive the round trip and stay reachable.
  const c = client(() =>
    json({
      ...IDENTITY,
      versions: {
        composition: "server@1a2b3c4 core@a11a7ca",
        // A key this release has never heard of.
        scheduler: "2026.07.27",
      },
    })
  );

  const me = await c.client.me();

  assertEquals(me.versions?.composition, "server@1a2b3c4 core@a11a7ca");
  assertEquals(me.versions?.scheduler, "2026.07.27");
  // …alongside, not instead of, the client-side fill.
  assertEquals(me.versions?.wrapper, VERSION);
  // And an unknown key at the TOP level survives too — interfaces are
  // structural, and nothing here validates against a closed schema.
  const withExtra = client(() => json({ ...IDENTITY, plan: "enterprise" }));
  const extra = await withExtra.client.me() as Me & { plan?: string };
  assertEquals(extra.plan, "enterprise");
});

Deno.test("me: a server-supplied versions.wrapper is not clobbered", async () => {
  // The client's own version is a DEFAULT, not an override. A host that has a
  // better answer than "whatever version is installed locally" must win, or the
  // fill would quietly rewrite a fact the server reported.
  const c = client(() => json({ ...IDENTITY, versions: { wrapper: "9.9.9-from-server" } }));

  const me = await c.client.me();

  assertEquals(me.versions?.wrapper, "9.9.9-from-server");
  assertNotEquals(me.versions?.wrapper, VERSION);
});

Deno.test("me: a 401 unauthorized reaches the caller as an ApiError", async () => {
  // The transport does not refresh, retry or re-auth (§3): a 401 raises and
  // stops, with the server's own code intact so a CLI can map it to an exit
  // code without parsing prose.
  const c = client(() =>
    json({ error: { code: "unauthorized", message: "Invalid token." } }, 401, "Unauthorized")
  );

  const err = await assertRejects(() => c.client.me(), ApiError);

  assertEquals(err.status, 401);
  assertEquals(err.code, "unauthorized");
  assertEquals(err.message, "Invalid token.");
});

Deno.test("me: a 200 whose body is an array is bad_response, not a degenerate Me", async () => {
  // `typeof [] === "object"` and `[] !== null`, so the guard next door used to
  // pass an array straight through to the spread. Measured against the shipped
  // code before this fix:
  //
  //   me() on 200 []              -> {"versions":{"wrapper":"0.1.0"}}
  //   me() on 200 [{"tenant":"x"}] -> {"0":{"tenant":"x"},"versions":{…}}
  //
  // i.e. exactly "a Me whose only populated field is the one this client just
  // added" — the thing the guard's own docstring says it prevents. It also keeps
  // this lane in step with python, whose `isinstance(body, dict)` raises here.
  for (const body of [[], [{ tenant: "x" }], [1, 2, 3]]) {
    const c = client(() => json(body));

    const err = await assertRejects(() => c.client.me(), ApiError);

    assertEquals(err.status, 200);
    assertEquals(err.code, "bad_response");
    assertStringIncludes(err.message, "not an identity object");
  }
});

Deno.test("me: a versions block that is not an object is not spread into keys", async () => {
  // A server answering `versions: "1.2.3"` used to yield
  // {"versions":{"0":"1","1":".","2":"2",…}} — junk that satisfies
  // Record<string, string> and is therefore invisible to the compiler. The
  // client keeps its own fill and drops the malformed block.
  for (const versions of ["1.2.3", 42, ["server@1a2b3c4"], true]) {
    const c = client(() => json({ ...IDENTITY, versions }));

    const me = await c.client.me();

    assertEquals(me.versions, { wrapper: VERSION });
    // The identity fields are untouched by the guard.
    assertEquals(me.tenant, "default");
  }
  // `null` was always handled correctly ({...null} is {}), and still is.
  const withNull = client(() => json({ ...IDENTITY, versions: null }));
  assertEquals((await withNull.client.me()).versions, { wrapper: VERSION });
});

Deno.test("me: a 200 whose body is not an object is bad_response", async () => {
  // Guarded rather than spread: a proxy answering `200 "ok"` must fail as a
  // shape problem here, not return a Me whose only populated field is the
  // `versions.wrapper` this client just added.
  const c = client(() => json("ok"));

  const err = await assertRejects(() => c.client.me(), ApiError);

  assertEquals(err.status, 200);
  assertEquals(err.code, "bad_response");
  assertStringIncludes(err.message, "not an identity object");
});
