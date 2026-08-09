/**
 * The transport, against an injected fake `fetch`.
 *
 * No test here (or anywhere in this package) requires a live server
 * (`docs/implementation.md` §9). Every case asserts either the request the
 * wrapper *made* — method, full URL, headers, serialised body — or the outcome
 * it produced, including all three pinned failure modes.
 */

import {
  assertEquals,
  assertInstanceOf,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { W6wClient } from "../src/client.ts";
import { type FetchLike, resolveConfig } from "../src/config.ts";
import { ApiError, ConfigError } from "../src/errors.ts";
import { buildUrl, path, request } from "../src/http.ts";

/** One recorded call to the fake transport. */
interface Call {
  url: string;
  method: string | undefined;
  headers: Headers;
  body: string | null;
}

/**
 * A `fetch`-shaped fake. `respond` receives the recorded call and returns the
 * `Response` to hand back — or throws, to simulate a transport failure.
 */
function fakeFetch(
  respond: (call: Call) => Response,
): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: FetchLike = (input, init) => {
    const call: Call = {
      url: input,
      method: init?.method,
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? init.body : null,
    };
    calls.push(call);
    return Promise.resolve(respond(call));
  };
  return { fetch, calls };
}

const CONFIG = resolveConfig({ baseUrl: "https://api.example.com", token: "tok_1" });

function json(body: unknown, status = 200, statusText?: string): Response {
  return new Response(JSON.stringify(body), {
    status,
    statusText,
    headers: { "content-type": "application/json" },
  });
}

Deno.test("a 200 returns the parsed body, the status, and sends the bearer", async () => {
  const fake = fakeFetch(() => json({ vars: [{ id: "var_1" }] }));

  const res = await request<{ vars: { id: string }[] }>(CONFIG, fake.fetch, {
    method: "GET",
    path: "/vars",
  });

  assertEquals(res.status, 200);
  assertEquals(res.body, { vars: [{ id: "var_1" }] });
  assertEquals(fake.calls.length, 1);
  assertEquals(fake.calls[0].url, "https://api.example.com/vars");
  assertEquals(fake.calls[0].method, "GET");
  assertEquals(fake.calls[0].headers.get("authorization"), "Bearer tok_1");
  // No body, no content-type: a GET must not advertise one.
  assertEquals(fake.calls[0].headers.get("content-type"), null);
  assertEquals(fake.calls[0].body, null);
});

Deno.test("a 202 is success and its status reaches the caller", async () => {
  // 202 means the run is queued and still going — a normal outcome on this API,
  // not an error. The status is the only thing distinguishing it from a 200, so
  // a status-losing signature would make the run operations impossible.
  const fake = fakeFetch(() => json({ runId: "run_1", status: "queued" }, 202));

  const res = await request<{ runId: string; status: string }>(CONFIG, fake.fetch, {
    method: "POST",
    path: "/workflows/wf_1/run",
    query: { wait: true },
    body: { variables: { a: 1 } },
  });

  assertEquals(res.status, 202);
  assertEquals(res.body, { runId: "run_1", status: "queued" });
  assertEquals(fake.calls[0].url, "https://api.example.com/workflows/wf_1/run?wait=true");
  assertEquals(fake.calls[0].headers.get("content-type"), "application/json");
  assertEquals(fake.calls[0].body, '{"variables":{"a":1}}');
});

Deno.test("a 2xx with an empty body resolves rather than crashing", async () => {
  // The server answers deletes with {ok:true}, but a 204-style empty body must
  // not blow up JSON.parse on the way out.
  const fake = fakeFetch(() => new Response(null, { status: 204 }));

  const res = await request<null>(CONFIG, fake.fetch, { method: "DELETE", path: "/vars/var_1" });

  assertEquals(res.status, 204);
  assertEquals(res.body, null);
  assertEquals(fake.calls[0].method, "DELETE");
});

Deno.test("an error envelope becomes an ApiError that keeps the raw body", async () => {
  const raw = {
    error: { code: "unknown_document", message: "No such document." },
    logs: ["looked"],
  };
  const fake = fakeFetch(() => json(raw, 404, "Not Found"));

  const err = await assertRejects(
    () => request(CONFIG, fake.fetch, { method: "GET", path: "/documents/doc_x" }),
    ApiError,
  );

  assertEquals(err.status, 404);
  assertEquals(err.code, "unknown_document");
  assertEquals(err.message, "No such document.");
  // The raw body is kept because error bodies carry fields the message drops.
  assertEquals(err.raw, raw);
  assertEquals(err.name, "ApiError");
});

Deno.test("an error body with no envelope falls back to 'error' and the status text", async () => {
  const fake = fakeFetch(() => json({}, 500, "Internal Server Error"));

  const err = await assertRejects(
    () => request(CONFIG, fake.fetch, { method: "GET", path: "/vars" }),
    ApiError,
  );

  assertEquals(err.status, 500);
  assertEquals(err.code, "error");
  assertEquals(err.message, "Internal Server Error");
  assertEquals(err.raw, {});
});

Deno.test("a non-JSON body on a non-OK status is bad_response with a snippet", async () => {
  // What a Cloudflare/proxy HTML error page looks like. Reporting it as an
  // opaque JSON SyntaxError would throw away the only diagnostic there is.
  const html = `<!DOCTYPE html><html><body>${"error ".repeat(100)}</body></html>`;
  const fake = fakeFetch(() => new Response(html, { status: 502, statusText: "Bad Gateway" }));

  const err = await assertRejects(
    () => request(CONFIG, fake.fetch, { method: "GET", path: "/vars" }),
    ApiError,
  );

  assertEquals(err.status, 502);
  assertEquals(err.code, "bad_response");
  assertStringIncludes(err.message, "non-JSON 502");
  assertStringIncludes(err.message, "<!DOCTYPE html>");
  // The snippet is capped at 200 characters of body.
  assertEquals(err.message.includes(html), false);
  assertStringIncludes(err.message, html.slice(0, 200));
  assertEquals(err.raw, null);
});

Deno.test("a non-JSON body on an OK status is not an error", async () => {
  const fake = fakeFetch(() => new Response("plain text", { status: 200 }));

  const res = await request<null>(CONFIG, fake.fetch, { method: "GET", path: "/vars" });

  assertEquals(res.status, 200);
  assertEquals(res.body, null);
});

Deno.test("a thrown fetch is network_error with status 0, naming the method and URL", async () => {
  const fake = fakeFetch(() => {
    throw new TypeError("Connection refused");
  });

  const err = await assertRejects(
    () => request(CONFIG, fake.fetch, { method: "GET", path: "/vars" }),
    ApiError,
  );

  assertEquals(err.status, 0);
  assertEquals(err.code, "network_error");
  // A bare "TypeError: Failed to fetch" is useless on its own — the message has
  // to say which request, to where.
  assertStringIncludes(err.message, "GET https://api.example.com/vars");
  assertStringIncludes(err.message, "Connection refused");
  assertEquals(err.raw, null);
});

Deno.test("a 424 is an ApiError, never a transport error and never a 5xx", async () => {
  // 424 = the target app or its upstream vendor failed during execute. It is a
  // 4xx on purpose: Cloudflare replaces an origin 5xx with a CORS-less HTML
  // page, which would strip the real message. Passing it through intact is the
  // whole point, so it must not be normalised anywhere.
  const raw = { error: { code: "app_error", message: "Stripe said no." }, apiCalls: [] };
  const fake = fakeFetch(() => json(raw, 424, "Failed Dependency"));

  const err = await assertRejects(
    () => request(CONFIG, fake.fetch, { method: "POST", path: "/run", body: { urn: "conn_1" } }),
    ApiError,
  );

  assertInstanceOf(err, ApiError);
  assertEquals(err.status, 424);
  assertEquals(err.code, "app_error");
  assertEquals(err.message, "Stripe said no.");
  assertEquals(err.raw, raw);
});

Deno.test("a request with no token raises a ConfigError before reaching the transport", async () => {
  const unauthenticated = resolveConfig({ baseUrl: "https://api.example.com", token: "" });
  const fake = fakeFetch(() => json({}));

  const err = await assertRejects(
    () => request(unauthenticated, fake.fetch, { method: "GET", path: "/vars" }),
    ConfigError,
  );

  assertStringIncludes(err.message, "W6W_TOKEN");
  assertEquals(fake.calls.length, 0);
});

Deno.test("the path tag percent-encodes every caller-supplied segment", () => {
  // Not defensive ceremony: unencoded, each of these silently addresses a
  // DIFFERENT route than the caller asked for, with no error anywhere.
  assertEquals(path`/documents/by-key/${"a/b"}`, "/documents/by-key/a%2Fb");
  assertEquals(path`/documents/by-key/${"a b"}`, "/documents/by-key/a%20b");
  assertEquals(path`/documents/by-key/${"a?x=1"}`, "/documents/by-key/a%3Fx%3D1");
  assertEquals(path`/documents/by-key/${"a#f"}`, "/documents/by-key/a%23f");
  assertEquals(path`/vars/by-name/${"my_var"}`, "/vars/by-name/my_var");
  // Author-controlled fragments are left alone; only interpolations are encoded.
  assertEquals(path`/documents/${"doc_1"}/x`, "/documents/doc_1/x");
  assertEquals(path`/vars`, "/vars");
});

Deno.test("an unsafe key is encoded and sent — this rule is encoding, never validation", async () => {
  // A wrapper must not reject a key the server accepts: `validateKey` trims,
  // rejects empty and caps at 128 characters, and restricts nothing else, so
  // "../.." is a document a user can legitimately create. Refusing it locally
  // would make that document permanently unreadable through this client.
  const fake = fakeFetch(() => json({ document: { id: "doc_1" } }));

  const res = await request(CONFIG, fake.fetch, {
    method: "GET",
    path: path`/documents/by-key/${"../.."}`,
    query: { project: "prj_a b" },
  });

  assertEquals(res.status, 200);
  assertEquals(
    fake.calls[0].url,
    "https://api.example.com/documents/by-key/..%2F..?project=prj_a+b",
  );
});

Deno.test("query parameters are encoded, and undefined ones are dropped", () => {
  assertEquals(
    buildUrl(CONFIG, { method: "GET", path: "/documents", query: { project: undefined } }),
    "https://api.example.com/documents",
  );
  assertEquals(
    buildUrl(CONFIG, { method: "GET", path: "/documents", query: { project: "p/1", wait: true } }),
    "https://api.example.com/documents?project=p%2F1&wait=true",
  );
});

Deno.test(
  "options.headers is the BASE the transport builds on — it can never override authorization or content-type",
  async () => {
    const fake = fakeFetch(() => json({ ok: true }));

    const res = await request<{ ok: boolean }>(CONFIG, fake.fetch, {
      method: "POST",
      path: "/vars",
      body: { a: 1 },
      headers: {
        "x-w6w-if-unmodified-since": "abc",
        authorization: "Bearer evil",
        "content-type": "text/plain",
      },
    });

    assertEquals(res.body, { ok: true });
    // The caller-supplied header passes through untouched…
    assertEquals(fake.calls[0].headers.get("x-w6w-if-unmodified-since"), "abc");
    // …but never shadows what this transport itself sets. `CONFIG` is built
    // with token "tok_1" (see above), so the real bearer must win.
    assertEquals(fake.calls[0].headers.get("authorization"), "Bearer tok_1");
    assertEquals(fake.calls[0].headers.get("content-type"), "application/json");
  },
);

Deno.test(
  "options.headers passes an arbitrary header through untouched when the transport sets nothing to conflict with it",
  async () => {
    const fake = fakeFetch(() => json({ ok: true }));

    // No body on this request, so the transport's own conditional
    // `content-type` set never runs — a caller-supplied content-type here is
    // not shadowing anything and passes through as ordinary base content.
    await request(CONFIG, fake.fetch, {
      method: "GET",
      path: "/vars",
      headers: { "content-type": "text/plain" },
    });

    assertEquals(fake.calls[0].headers.get("content-type"), "text/plain");
  },
);

Deno.test(
  "requireAuth: false sends NO authorization header, even on a config carrying a token",
  async () => {
    const fake = fakeFetch(() => json({ token: "tok_new" }));

    const res = await request<{ token: string }>(CONFIG, fake.fetch, {
      method: "POST",
      path: "/auth/login",
      body: { username: "u", password: "p" },
      requireAuth: false,
    });

    assertEquals(res.body, { token: "tok_new" });
    // Not an empty header, not "Bearer null" — absent entirely.
    assertEquals(fake.calls[0].headers.has("authorization"), false);
    assertEquals(fake.calls[0].headers.get("authorization"), null);
  },
);

Deno.test("requireAuth omitted behaves exactly as before — the bearer is sent", async () => {
  const fake = fakeFetch(() => json({ ok: true }));

  await request(CONFIG, fake.fetch, { method: "GET", path: "/vars" });

  assertEquals(fake.calls[0].headers.get("authorization"), "Bearer tok_1");
});

Deno.test(
  "requireAuth: false on a TOKENLESS config never even attempts requireToken — resolves, not ConfigError",
  async () => {
    const unauthenticated = resolveConfig({ baseUrl: "https://api.example.com", token: "" });
    const fake = fakeFetch(() => json({ token: "tok_new" }));

    const res = await request<{ token: string }>(unauthenticated, fake.fetch, {
      method: "POST",
      path: "/auth/login",
      body: { username: "u", password: "p" },
      requireAuth: false,
    });

    assertEquals(res.body, { token: "tok_new" });
    assertEquals(fake.calls[0].headers.get("authorization"), null);
  },
);

Deno.test(
  "RequestOptions.headers ordering still holds when requireAuth is also set — no interaction bug",
  async () => {
    const fake = fakeFetch(() => json({ ok: true }));

    await request(CONFIG, fake.fetch, {
      method: "POST",
      path: "/auth/login",
      body: { username: "u", password: "p" },
      headers: { "x-custom": "1" },
      requireAuth: false,
    });

    assertEquals(fake.calls[0].headers.get("x-custom"), "1");
    assertEquals(fake.calls[0].headers.get("authorization"), null);
  },
);

Deno.test("the client defaults to globalThis.fetch, and says so when there is none", async () => {
  const original = globalThis.fetch;
  try {
    // Prove the default is the global: replace it and watch the client use it.
    const fake = fakeFetch(() => json({ ok: true }));
    globalThis.fetch = fake.fetch as typeof globalThis.fetch;
    const client = new W6wClient({ baseUrl: "https://api.example.com", token: "tok_g" });
    const res = await client.request<{ ok: boolean }>({ method: "GET", path: "/me" });
    assertEquals(res.body, { ok: true });
    assertEquals(fake.calls[0].url, "https://api.example.com/me");
    assertEquals(fake.calls[0].headers.get("authorization"), "Bearer tok_g");

    // …and on a host with no fetch at all, fail at construction with a message
    // that names the fix, rather than with an opaque TypeError at first use.
    // deno-lint-ignore no-explicit-any
    delete (globalThis as any).fetch;
    const err = assertThrows(
      () => new W6wClient({ baseUrl: "https://api.example.com", token: "tok_g" }),
      ConfigError,
    );
    assertStringIncludes(err.message, "fetch");
  } finally {
    globalThis.fetch = original;
  }
});
