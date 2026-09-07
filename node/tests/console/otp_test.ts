/**
 * `client.console.otp.*`, against an injected fake `fetch`.
 *
 * No case here needs a live server (`docs/implementation.md` §9). Mirrors
 * `tests/console/passkeys_test.ts`'s `fakeFetch`/`json`/`client` harness. The
 * property this suite exists to pin: all three methods are PUBLIC
 * (`requireAuth: false`) — the login screen has no token, so a tokenless
 * client must be able to reach every one of them, and a client that already
 * holds a token must still send no bearer on any of the three.
 */

import { assertEquals } from "@std/assert";
import { W6WClient } from "../../src/client.ts";
import type { FetchLike } from "../../src/config.ts";
import type { LoginProviders, OtpVerifyResponse } from "../../src/console/otp.ts";

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

/** A client wired to a fake transport, WITH a token — the interesting case for `requireAuth`. */
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

const PROVIDERS: LoginProviders = { password: true, passkey: true, otp: true };

const VERIFY_RESPONSE: OtpVerifyResponse = {
  token: "tok_new",
  user: { username: "alice@example.com", role: "user", tenant: "ten_1", emailVerified: true },
  expiresIn: 3600,
};

Deno.test("console.otp: all three operations are functions on a constructed client", () => {
  // Runtime, not type-level: a namespace that silently lost a method would
  // still typecheck everywhere else in this suite.
  const c = new W6WClient({ baseUrl: "https://api.example.com", token: "t" });
  for (const name of ["loginProviders", "requestCode", "verifyCode"] as const) {
    assertEquals(typeof c.console.otp[name], "function", `console.otp.${name} is missing`);
  }
});

Deno.test(
  "console.otp.loginProviders GETs /auth/login-providers and unwraps the providers envelope",
  async () => {
    const c = client(() => json({ providers: PROVIDERS }));

    const res = await c.client.console.otp.loginProviders();

    assertEquals(res, PROVIDERS);
    assertEquals(c.calls.length, 1);
    assertEquals(c.calls[0].method, "GET");
    assertEquals(c.calls[0].url, "https://api.example.com/auth/login-providers");
    assertEquals(c.calls[0].body, null);
  },
);

Deno.test(
  "console.otp.requestCode POSTs /auth/otp/request with {email} and resolves void",
  async () => {
    const c = client(() => json({ ok: true }, 202));

    const res = await c.client.console.otp.requestCode({ email: "alice@example.com" });

    assertEquals(res, undefined);
    assertEquals(c.calls[0].method, "POST");
    assertEquals(c.calls[0].url, "https://api.example.com/auth/otp/request");
    assertEquals(JSON.parse(c.calls[0].body ?? "null"), { email: "alice@example.com" });
  },
);

Deno.test(
  "console.otp.verifyCode POSTs /auth/otp/verify with {email, code} and mints a session",
  async () => {
    const c = client(() => json(VERIFY_RESPONSE));

    const res = await c.client.console.otp.verifyCode({
      email: "alice@example.com",
      code: "123456",
    });

    assertEquals(res, VERIFY_RESPONSE);
    assertEquals(c.calls[0].method, "POST");
    assertEquals(c.calls[0].url, "https://api.example.com/auth/otp/verify");
    assertEquals(JSON.parse(c.calls[0].body ?? "null"), {
      email: "alice@example.com",
      code: "123456",
    });
  },
);

Deno.test(
  "console.otp: all three methods send NO authorization header, even on a client holding a token",
  async () => {
    const c1 = client(() => json({ providers: PROVIDERS }));
    await c1.client.console.otp.loginProviders();
    assertEquals(c1.calls[0].headers.get("authorization"), null);

    const c2 = client(() => json({ ok: true }, 202));
    await c2.client.console.otp.requestCode({ email: "alice@example.com" });
    assertEquals(c2.calls[0].headers.get("authorization"), null);

    const c3 = client(() => json(VERIFY_RESPONSE));
    await c3.client.console.otp.verifyCode({ email: "alice@example.com", code: "123456" });
    assertEquals(c3.calls[0].headers.get("authorization"), null);
  },
);

Deno.test(
  "console.otp: all three methods work on a TOKENLESS client — the actual bug requireAuth fixes",
  async () => {
    const fake1 = fakeFetch(() => json({ providers: PROVIDERS }));
    const c1 = new W6WClient({ baseUrl: "https://api.example.com", fetch: fake1.fetch }); // no token
    // Must resolve, not throw ConfigError.
    const res1 = await c1.console.otp.loginProviders();
    assertEquals(res1, PROVIDERS);

    const fake2 = fakeFetch(() => json({ ok: true }, 202));
    const c2 = new W6WClient({ baseUrl: "https://api.example.com", fetch: fake2.fetch });
    await c2.console.otp.requestCode({ email: "alice@example.com" });
    assertEquals(fake2.calls.length, 1);

    const fake3 = fakeFetch(() => json(VERIFY_RESPONSE));
    const c3 = new W6WClient({ baseUrl: "https://api.example.com", fetch: fake3.fetch });
    const res3 = await c3.console.otp.verifyCode({ email: "alice@example.com", code: "123456" });
    assertEquals(res3, VERIFY_RESPONSE);
  },
);
