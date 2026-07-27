/**
 * `client.documents.*`, against an injected fake `fetch`.
 *
 * No case here needs a live server (`docs/implementation.md` §9). Each one
 * asserts the request the wrapper *made* — method, full resolved URL including
 * `?project=`, bearer, serialised body — **and** the value it returned, which is
 * always the unwrapped payload and never the server's envelope.
 */

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { W6wClient } from "../src/client.ts";
import type { FetchLike } from "../src/config.ts";
import { ApiError } from "../src/errors.ts";
import type { Doc } from "../src/types.ts";

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

const DOC: Doc = {
  id: "doc_1",
  key: "welcome-email-copy",
  content: "# Welcome",
  format: "markdown",
  description: "Body copy.",
  createdAt: "2026-07-01T12:00:00.000Z",
  updatedAt: "2026-07-22T18:03:00.000Z",
};

/** A client wired to a fake transport. `project` seeds the client-level default. */
function client(
  respond: (call: Call) => Response,
  project?: string,
): { client: W6wClient; calls: Call[] } {
  const fake = fakeFetch(respond);
  return {
    client: new W6wClient({
      baseUrl: "https://api.example.com",
      token: "tok_1",
      project,
      fetch: fake.fetch,
    }),
    calls: fake.calls,
  };
}

Deno.test("documents: all six operations are functions on a constructed client", () => {
  // Deliberately a runtime assertion, not a type-level one: a namespace that
  // silently loses a method would still typecheck in every OTHER file of this
  // suite (they call through the same object), so the suite has to look.
  const c = new W6wClient({ baseUrl: "https://api.example.com", token: "t" });
  for (const name of ["list", "get", "getByKey", "create", "update", "delete"] as const) {
    assertEquals(typeof c.documents[name], "function", `documents.${name} is missing`);
  }
});

Deno.test("documents.list unwraps the envelope and returns the array", async () => {
  const c = client(() => json({ documents: [DOC] }));

  const docs = await c.client.documents.list();

  // The array itself, not {documents: […]} — the caller never sees the wrapper.
  assertEquals(docs, [DOC]);
  assertEquals(c.calls.length, 1);
  assertEquals(c.calls[0].method, "GET");
  assertEquals(c.calls[0].url, "https://api.example.com/api/documents");
  assertEquals(c.calls[0].headers.get("authorization"), "Bearer tok_1");
});

Deno.test("documents send ?project= from the client default, overridable per call", async () => {
  const c = client(() => json({ documents: [] }), "prj_default");

  await c.client.documents.list();
  assertEquals(c.calls[0].url, "https://api.example.com/api/documents?project=prj_default");

  // Per-call wins over the client default…
  await c.client.documents.list({ project: "prj_other" });
  assertEquals(c.calls[1].url, "https://api.example.com/api/documents?project=prj_other");

  // …and every one of the five id-addressed routes carries it too, because the
  // server accepts it on all of them.
  const withDoc = client(() => json({ document: DOC }), "prj_default");
  await withDoc.client.documents.get("doc_1");
  await withDoc.client.documents.getByKey("welcome-email-copy");
  await withDoc.client.documents.create({ key: "k", content: "c" });
  await withDoc.client.documents.update("doc_1", { content: "c2" });
  await withDoc.client.documents.delete("doc_1");
  for (const call of withDoc.calls) {
    assertStringIncludes(call.url, "?project=prj_default");
  }
});

Deno.test("documents omit ?project= entirely when none is configured", async () => {
  // Omitted means "let the server resolve the account's default project" — an
  // empty `?project=` would be a different, and wrong, request.
  const c = client(() => json({ document: DOC }));

  await c.client.documents.get("doc_1");

  assertEquals(c.calls[0].url, "https://api.example.com/api/documents/doc_1");
});

Deno.test("documents.getByKey addresses the by-key route with the key encoded", async () => {
  const c = client(() => json({ document: DOC }));

  await c.client.documents.getByKey("a/b");
  await c.client.documents.getByKey("a b");
  await c.client.documents.getByKey("a?x=1");
  // Encoding, never validation: "../.." is a key the server accepts, so the
  // wrapper encodes and sends it and raises nothing client-side. Refusing it
  // here would make a document that exists unreadable through this client.
  const doc = await c.client.documents.getByKey("../..");

  assertEquals(c.calls[0].url, "https://api.example.com/api/documents/by-key/a%2Fb");
  assertEquals(c.calls[1].url, "https://api.example.com/api/documents/by-key/a%20b");
  assertEquals(c.calls[2].url, "https://api.example.com/api/documents/by-key/a%3Fx%3D1");
  assertEquals(c.calls[3].url, "https://api.example.com/api/documents/by-key/..%2F..");
  assertEquals(doc, DOC);
});

Deno.test("documents.create posts key+content+format+description and accepts 201", async () => {
  const c = client(() => json({ document: DOC }, 201));

  const created = await c.client.documents.create({
    key: "welcome-email-copy",
    content: "# Welcome",
    format: "markdown",
    description: "Body copy.",
  });

  assertEquals(created, DOC);
  assertEquals(c.calls[0].method, "POST");
  assertEquals(c.calls[0].url, "https://api.example.com/api/documents");
  assertEquals(c.calls[0].headers.get("content-type"), "application/json");
  assertEquals(JSON.parse(c.calls[0].body ?? "null"), {
    key: "welcome-email-copy",
    content: "# Welcome",
    format: "markdown",
    description: "Body copy.",
  });
});

Deno.test("documents.create omits the optional fields it was not given", async () => {
  const c = client(() => json({ document: DOC }, 201));

  await c.client.documents.create({ key: "k", content: "c" });

  // No `format: null`, no `description: null` — an absent field means "let the
  // server apply its default", which is not the same request as an explicit null.
  assertEquals(JSON.parse(c.calls[0].body ?? "null"), { key: "k", content: "c" });
});

Deno.test("documents.update patches by id and cannot carry a key", async () => {
  const c = client(() => json({ document: DOC }));

  const updated = await c.client.documents.update("doc_1", { content: "# Hello" });

  assertEquals(updated, DOC);
  assertEquals(c.calls[0].method, "PATCH");
  // Addressed by the server-issued id (D6), never by the key.
  assertEquals(c.calls[0].url, "https://api.example.com/api/documents/doc_1");
  // The server's PATCH body has no `key`; the wrapper's body must not grow one,
  // even when a caller passes an object that happens to carry one.
  const patch = { content: "# Hello", key: "sneaky" } as { content: string };
  await c.client.documents.update("doc_1", patch);
  assertEquals(JSON.parse(c.calls[1].body ?? "null"), { content: "# Hello" });
});

Deno.test("documents.delete returns nothing rather than {ok:true}", async () => {
  const c = client(() => json({ ok: true }));

  const result = await c.client.documents.delete("doc_1");

  assertEquals(result, undefined);
  assertEquals(c.calls[0].method, "DELETE");
  assertEquals(c.calls[0].url, "https://api.example.com/api/documents/doc_1");
  assertEquals(c.calls[0].body, null);
});

Deno.test("documents: a 404 unknown_document reaches the caller as an ApiError", async () => {
  const c = client(() => json({ error: { code: "unknown_document", message: "No such." } }, 404));

  const err = await assertRejects(() => c.client.documents.get("doc_missing"), ApiError);

  assertEquals(err.status, 404);
  assertEquals(err.code, "unknown_document");
  assertEquals(err.message, "No such.");
});

Deno.test("documents: a 409 document_exists surfaces its code, unswallowed", async () => {
  // The whole value of the conflict is the code: it is how a caller tells
  // "already there" from "your request was wrong" without parsing prose.
  const c = client(() =>
    json({ error: { code: "document_exists", message: "Key taken." } }, 409, "Conflict")
  );

  const err = await assertRejects(
    () => c.client.documents.create({ key: "welcome-email-copy", content: "x" }),
    ApiError,
  );

  assertEquals(err.status, 409);
  assertEquals(err.code, "document_exists");
});

Deno.test("documents: the id is percent-encoded into every id-addressed route", async () => {
  // The encoding pin is contract-wide, but every id fixture in this suite is the
  // tame `doc_1`, which encodes to itself — so dropping the `path` tag from the
  // id call sites left all gates green. An id carrying a `/` is what makes the
  // tag's absence visible: without it the request addresses a different route.
  const c = client(() => json({ document: DOC, ok: true }));

  await c.client.documents.get("doc/1");
  await c.client.documents.update("doc/1", { content: "c" });
  await c.client.documents.delete("doc/1");

  assertEquals(c.calls[0].url, "https://api.example.com/api/documents/doc%2F1");
  assertEquals(c.calls[1].url, "https://api.example.com/api/documents/doc%2F1");
  assertEquals(c.calls[2].url, "https://api.example.com/api/documents/doc%2F1");
});

Deno.test("documents.delete does not swallow a 404 — it is not a silent success", async () => {
  // "Not idempotent: a 404 is not a silent success" is documented behaviour with
  // no test until now — a `try {} catch {}` around the delete request kept the
  // whole suite green. It becomes user-visible in the CLI, whose exit code for
  // `w6w documents delete` is read straight off this error.
  const c = client(() => json({ error: { code: "unknown_document", message: "No such." } }, 404));

  const err = await assertRejects(() => c.client.documents.delete("doc_missing"), ApiError);

  assertEquals(err.status, 404);
  assertEquals(err.code, "unknown_document");
});

Deno.test("documents: an envelope key present but null is bad_response, not null", async () => {
  // `value !== undefined` let a JSON null through, so `documents.get()` resolved
  // to `null` typed `Doc` (measured) — precisely the deferred TypeError in the
  // caller that this whole envelope reader exists to prevent.
  const single = client(() => json({ document: null }));
  const errSingle = await assertRejects(() => single.client.documents.get("doc_1"), ApiError);
  assertEquals(errSingle.code, "bad_response");
  assertEquals(errSingle.status, 200);
  assertStringIncludes(errSingle.message, '"document"');

  const many = client(() => json({ documents: null }));
  const errMany = await assertRejects(() => many.client.documents.list(), ApiError);
  assertEquals(errMany.code, "bad_response");
  assertStringIncludes(errMany.message, '"documents"');
});

Deno.test("documents: a 200 missing its envelope key is bad_response, not undefined", async () => {
  // A server regression must fail here, loudly, rather than returning undefined
  // and surfacing as a TypeError somewhere in the caller minutes later.
  const c = client(() => json({ unexpected: true }));

  const err = await assertRejects(() => c.client.documents.get("doc_1"), ApiError);

  assertEquals(err.code, "bad_response");
  assertEquals(err.status, 200);
  assertStringIncludes(err.message, '"document"');
});
