/**
 * `client.console.aliases.*`, against an injected fake `fetch`.
 *
 * No case here needs a live server (`docs/implementation.md` §9). The cases
 * that matter most:
 *
 * - `get` returns the `AliasDef` plainly — no splice, no server-computed
 *   field merged in (unlike `console.functions.get`'s `valid`-splice).
 * - `list`/`upsert` unwrap correctly (`aliases`/`alias` envelope keys), and
 *   `delete` resolves to `undefined`.
 * - There is no `console.aliases.invoke` — a direct check on the
 *   Requirement's anti-duplication pin, and the base `client.run` stays
 *   untouched.
 * - Every id-taking method routes its id through the `path` tag
 *   (percent-encoding).
 * - A typed fixture is declared for each of the four `target` arms
 *   (`action` / `function` / `workflow` / `endpoint`) — `deno task check`
 *   fails this file if `target` is ever narrowed to fewer arms. The
 *   `endpoint` arm is legal for `AliasDef.target` only — it is a SIBLING of
 *   `Callable`, never a third `Callable` arm, and `EndpointDef.target`'s own
 *   `console.endpoints.invoke` result (`EndpointInvokeResult`) can never
 *   answer an `endpoint` kind; two `@ts-expect-error` probes pin both
 *   refusals.
 */

import { assertEquals, assertRejects } from "@std/assert";
import { W6WClient } from "../../src/client.ts";
import type { FetchLike } from "../../src/config.ts";
import { ApiError } from "../../src/errors.ts";
import type { AliasDef, AliasSummary } from "../../src/console/aliases.ts";
import type { Callable, EndpointInvokeResult } from "../../src/console/endpoints.ts";

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

const ALIAS_ACTION: AliasDef = {
  id: "als_1",
  name: "send-email",
  displayName: "Send email",
  description: "",
  target: { kind: "action", uses: { app: "sendgrid", action: "send" } },
};

const ALIAS_FUNCTION: AliasDef = {
  id: "als_2",
  name: "notify",
  displayName: "Notify",
  description: "",
  target: { kind: "function", function: "fn_1" },
};

const ALIAS_WORKFLOW: AliasDef = {
  id: "als_3",
  name: "onboard",
  displayName: "Onboard",
  description: "",
  target: { kind: "workflow", workflow: "wf_1" },
};

const ALIAS_ENDPOINT: AliasDef = {
  id: "als_4",
  name: "billing-portal",
  displayName: "Billing portal",
  description: "",
  target: { kind: "endpoint", endpoint: "ep_1" },
};

const SUMMARY_A: AliasSummary = {
  id: "als_1",
  name: "send-email",
  displayName: "Send email",
  description: "",
  updatedAt: "2026-08-17T00:00:00.000Z",
  target: ALIAS_ACTION.target,
};

const SUMMARY_B: AliasSummary = {
  id: "als_2",
  name: "notify",
  displayName: "Notify",
  description: "",
  updatedAt: "2026-08-17T00:00:01.000Z",
  target: ALIAS_FUNCTION.target,
};

Deno.test(
  "console.aliases: list/get/upsert/delete are functions on a constructed client; invoke does NOT exist",
  () => {
    // Runtime, not type-level: a namespace that silently lost a method would
    // still typecheck everywhere else in this suite.
    const c = new W6WClient({ baseUrl: "https://api.example.com", token: "t" });
    assertEquals(typeof c.console.aliases.list, "function");
    assertEquals(typeof c.console.aliases.get, "function");
    assertEquals(typeof c.console.aliases.upsert, "function");
    assertEquals(typeof c.console.aliases.delete, "function");
    // Direct check on the Requirement's anti-duplication pin: no
    // console.aliases.invoke/run exists at all.
    // deno-lint-ignore no-explicit-any
    const aliasesAny = c.console.aliases as any;
    assertEquals(typeof aliasesAny.invoke, "undefined");
    assertEquals(typeof aliasesAny.run, "undefined");
    // Regression-proof: base client.run stays untouched.
    assertEquals(typeof c.run, "function");
  },
);

Deno.test("console.aliases.list unwraps the aliases envelope", async () => {
  const c = client(() => json({ aliases: [SUMMARY_A, SUMMARY_B] }));

  const res = await c.client.console.aliases.list();

  assertEquals(res, [SUMMARY_A, SUMMARY_B]);
  assertEquals(c.calls[0].method, "GET");
  assertEquals(c.calls[0].url, "https://api.example.com/aliases");
});

Deno.test("console.aliases.get returns the AliasDef as sent — no splice", async () => {
  const c = client(() => json({ alias: ALIAS_ACTION }));

  const res = await c.client.console.aliases.get("als_1");

  assertEquals(res, ALIAS_ACTION);
  assertEquals(Object.hasOwn(res, "valid"), false);
  assertEquals(c.calls[0].method, "GET");
  assertEquals(c.calls[0].url, "https://api.example.com/aliases/als_1");
});

Deno.test(
  "console.aliases.upsert sends the definition verbatim and unwraps {id,name} from the alias key",
  async () => {
    const c = client(() => json({ alias: { id: "als_1", name: "send-email" } }, 201));

    const res = await c.client.console.aliases.upsert(ALIAS_ACTION);

    assertEquals(res, { id: "als_1", name: "send-email" });
    assertEquals(JSON.parse(c.calls[0].body ?? "null"), ALIAS_ACTION);
    assertEquals(c.calls[0].method, "POST");
    assertEquals(c.calls[0].url, "https://api.example.com/aliases");
  },
);

Deno.test("console.aliases.delete sends DELETE to the right path and resolves void", async () => {
  const c = client(() => json({ ok: true }));

  const res = await c.client.console.aliases.delete("als_1");

  assertEquals(res, undefined);
  assertEquals(c.calls[0].method, "DELETE");
  assertEquals(c.calls[0].url, "https://api.example.com/aliases/als_1");
});

Deno.test(
  "console.aliases.get percent-encodes an id containing `/` into one path segment, not two",
  async () => {
    const c = client(() => json({ alias: ALIAS_ACTION }));

    await c.client.console.aliases.get("als/1");

    assertEquals(c.calls[0].url, "https://api.example.com/aliases/als%2F1");
  },
);

Deno.test(
  "console.aliases.delete percent-encodes an id containing `/` into one path segment, not two",
  async () => {
    const c = client(() => json({ ok: true }));

    await c.client.console.aliases.delete("als/1");

    assertEquals(c.calls[0].url, "https://api.example.com/aliases/als%2F1");
  },
);

Deno.test(
  "console.aliases.get: a 200 with no `alias` key is bad_response, not undefined",
  async () => {
    const c = client(() => json({}));

    const err = await assertRejects(() => c.client.console.aliases.get("als_1"), ApiError);

    assertEquals(err.code, "bad_response");
  },
);

Deno.test(
  "console.aliases.list: a 200 with no `aliases` key is bad_response, not undefined",
  async () => {
    const c = client(() => json({}));

    const err = await assertRejects(() => c.client.console.aliases.list(), ApiError);

    assertEquals(err.code, "bad_response");
  },
);

Deno.test("console.aliases.get throws a 404 unknown_alias as ApiError carrying that code", async () => {
  const c = client(() =>
    json({ error: { code: "unknown_alias", message: "Not registered." } }, 404)
  );

  const err = await assertRejects(() => c.client.console.aliases.get("als_missing"), ApiError);

  assertEquals(err.status, 404);
  assertEquals(err.code, "unknown_alias");
});

Deno.test("console.aliases.upsert throws on a genuine non-2xx", async () => {
  const c = client(() => json({ error: { code: "alias_name_conflict", message: "Owned." } }, 409));

  const err = await assertRejects(() => c.client.console.aliases.upsert(ALIAS_ACTION), ApiError);

  assertEquals(err.status, 409);
  assertEquals(err.code, "alias_name_conflict");
});

Deno.test(
  "AliasDef.target admits all four EndpointTarget arms — action, function, workflow, endpoint",
  () => {
    // Compile-time, not runtime: this test's real assertion is that
    // `deno task check` accepts all four literals below as a valid
    // `AliasDef`. If `target` is ever narrowed to fewer arms, this file
    // fails to typecheck.
    const fixtures: AliasDef[] = [ALIAS_ACTION, ALIAS_FUNCTION, ALIAS_WORKFLOW, ALIAS_ENDPOINT];
    assertEquals(
      fixtures.map((a) => a.target.kind),
      ["action", "function", "workflow", "endpoint"],
    );
  },
);

Deno.test(
  "the endpoint arm is a SIBLING of Callable, never a third Callable arm",
  () => {
    // D-P1: EndpointRefTarget must NOT be assignable to Callable — it is a
    // sibling member of EndpointTarget, never a third Callable arm. An
    // unused `@ts-expect-error` is itself a `deno check` error (TS2578),
    // which is what makes this a gate and not just a comment.
    // @ts-expect-error — "endpoint" is not a legal Callable.kind
    const notCallable: Callable = { kind: "endpoint", endpoint: "ep_1" };
    // EndpointInvokeResult also stays exactly three arms: an Endpoint's own
    // target can never resolve to another Endpoint (console.endpoints.invoke
    // can never answer an "endpoint" kind).
    // @ts-expect-error — "endpoint" is not a legal EndpointInvokeResult.kind
    const notInvokeResult: EndpointInvokeResult = { kind: "endpoint", endpoint: "ep_1" };
    assertEquals((notCallable as { kind: string }).kind, "endpoint");
    assertEquals((notInvokeResult as { kind: string }).kind, "endpoint");
  },
);

Deno.test("AliasSummary.target is REQUIRED, not optional", () => {
  // @ts-expect-error — target is required; an AliasSummary literal omitting
  // it must fail to typecheck. If target is ever widened to optional, this
  // assignment stops erroring and the now-unused `@ts-expect-error` becomes
  // a `deno check` error (TS2578) in its own right.
  const missingTarget: AliasSummary = {
    id: "als_9",
    name: "billing-portal",
    displayName: "Billing portal",
    description: "",
    updatedAt: "2026-08-17T00:00:02.000Z",
  };
  assertEquals(Object.hasOwn(missingTarget, "target"), false);
});

Deno.test(
  "console.aliases.list carries each row's target through unwrap unchanged",
  async () => {
    const c = client(() => json({ aliases: [SUMMARY_A, SUMMARY_B] }));

    const res = await c.client.console.aliases.list();

    assertEquals(res.map((r) => r.target), [SUMMARY_A.target, SUMMARY_B.target]);
  },
);
