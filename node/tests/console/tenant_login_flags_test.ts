/**
 * `client.console.tenantLoginFlags.*`, against an injected fake `fetch`.
 *
 * No case here needs a live server (`docs/implementation.md` §9). Mirrors
 * `tests/console/tenant_oauth_apps_test.ts`'s harness and its case class:
 * every assertion on `put` is on the recorded body's exact KEY SET, never
 * merely "the value we set is present" — T2.1.1's wire pin states "absent
 * means preserve", so a serializer that sent both keys whenever only one was
 * meant to change would silently flip the field the caller never touched.
 */

import { assertEquals } from "@std/assert";
import { W6WClient } from "../../src/client.ts";
import type { FetchLike } from "../../src/config.ts";
import type {
  SetTenantLoginFlagsInput,
  TenantLoginFlags,
} from "../../src/console/tenant-login-flags.ts";

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

/** The parsed request body of a recorded call. `{}` for a bodiless request. */
function sentBody(call: Call): Record<string, unknown> {
  return JSON.parse(call.body ?? "{}") as Record<string, unknown>;
}

const FLAGS_OFF: TenantLoginFlags = { otpEnabled: false, passwordDisabled: false };
const FLAGS_OTP_ON: TenantLoginFlags = { otpEnabled: true, passwordDisabled: false };

Deno.test("console.tenantLoginFlags: get/put are functions on a constructed client", () => {
  // Runtime, not type-level: a namespace that silently lost a method would
  // still typecheck everywhere else in this suite.
  const c = new W6WClient({ baseUrl: "https://api.example.com", token: "t" });
  assertEquals(typeof c.console.tenantLoginFlags.get, "function");
  assertEquals(typeof c.console.tenantLoginFlags.put, "function");
});

Deno.test(
  "console.tenantLoginFlags.get GETs /tenant/login-flags and returns res.body.flags",
  async () => {
    const c = client(() => json({ flags: FLAGS_OFF }));

    const res = await c.client.console.tenantLoginFlags.get();

    assertEquals(res, FLAGS_OFF);
    assertEquals(c.calls.length, 1);
    assertEquals(c.calls[0].method, "GET");
    assertEquals(c.calls[0].url, "https://api.example.com/tenant/login-flags");
    // Authenticated: the tenant comes from the bearer, never from a parameter.
    assertEquals(c.calls[0].headers.get("authorization"), "Bearer tok_1");
  },
);

Deno.test(
  "console.tenantLoginFlags.put sends ONLY otpEnabled — {passwordDisabled:true} must not ride along",
  async () => {
    const c = client(() => json({ flags: FLAGS_OTP_ON }, 200));

    await c.client.console.tenantLoginFlags.put({ otpEnabled: true });

    // THE case. A serializer emitting {"otpEnabled":true,"passwordDisabled":false}
    // would silently ASSERT passwordDisabled:false to the server (a real,
    // meaningful value on this route) even though the caller never touched
    // it — the exact key set is what rejects that shape.
    const body = sentBody(c.calls[0]);
    assertEquals(Object.keys(body).sort(), ["otpEnabled"]);
    assertEquals(body.otpEnabled, true);
    assertEquals(c.calls[0].method, "PUT");
    assertEquals(c.calls[0].url, "https://api.example.com/tenant/login-flags");
  },
);

Deno.test(
  "console.tenantLoginFlags.put sends ONLY passwordDisabled",
  async () => {
    const c = client(() => json({ flags: FLAGS_OFF }, 200));

    await c.client.console.tenantLoginFlags.put({ passwordDisabled: true });

    const body = sentBody(c.calls[0]);
    assertEquals(Object.keys(body).sort(), ["passwordDisabled"]);
    assertEquals(body.passwordDisabled, true);
  },
);

Deno.test(
  "console.tenantLoginFlags.put drops an explicitly-undefined key rather than sending it",
  async () => {
    const c = client(() => json({ flags: FLAGS_OTP_ON }, 200));

    // The shape a form produces when a field was rendered but never touched.
    const input: SetTenantLoginFlagsInput = { otpEnabled: true, passwordDisabled: undefined };
    await c.client.console.tenantLoginFlags.put(input);

    const body = sentBody(c.calls[0]);
    assertEquals(Object.keys(body).sort(), ["otpEnabled"]);
    assertEquals(body.otpEnabled, true);
  },
);

Deno.test("console.tenantLoginFlags.put sends both keys the caller DID set", async () => {
  const c = client(() => json({ flags: FLAGS_OFF }, 200));

  await c.client.console.tenantLoginFlags.put({ otpEnabled: false, passwordDisabled: false });

  // The opposite mutant: an over-eager omission rule that dropped falsy
  // values would lose both keys here.
  const body = sentBody(c.calls[0]);
  assertEquals(Object.keys(body).sort(), ["otpEnabled", "passwordDisabled"]);
  assertEquals(body.otpEnabled, false);
  assertEquals(body.passwordDisabled, false);
});

Deno.test("console.tenantLoginFlags.put returns res.body.flags, not res.body", async () => {
  const c = client(() => json({ flags: FLAGS_OTP_ON }, 200));

  const res = await c.client.console.tenantLoginFlags.put({ otpEnabled: true });

  // A copy-paste from `get` would still pass here by coincidence unless the
  // envelope shape genuinely differs — pinned explicitly so a future
  // response-shape change (e.g. a flat body) is caught.
  assertEquals(res, FLAGS_OTP_ON);
});

Deno.test("console.tenantLoginFlags.put sends no body key when given {}", async () => {
  const c = client(() => json({ flags: FLAGS_OFF }, 200));

  await c.client.console.tenantLoginFlags.put({});

  assertEquals(sentBody(c.calls[0]), {});
});
