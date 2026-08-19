/**
 * `client.console.passkeys.*`, against an injected fake `fetch`.
 *
 * No case here needs a live server (`docs/implementation.md` §9). Mirrors
 * `tests/console/auth_test.ts`'s `fakeFetch`/`json`/`client` harness. Beyond
 * the per-operation wire assertions, this suite pins the split the module
 * header documents: the management quartet
 * (`registrationOptions`/`registrationVerify`/`list`/`revoke`) is
 * AUTHENTICATED, the login pair
 * (`authenticationOptions`/`authenticationVerify`) is PUBLIC
 * (`requireAuth: false`, HITL-5's token-bearing verify response), and every
 * WebAuthn payload and id travels correctly — never in the URL, and
 * percent-encoded where it is caller-supplied.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { W6WClient } from "../../src/client.ts";
import type { FetchLike } from "../../src/config.ts";
import type {
  Passkey,
  PasskeyAuthenticationVerifyResponse,
  PasskeyCeremonyOptions,
} from "../../src/console/passkeys.ts";

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

const PASSKEY: Passkey = {
  id: "pk_1",
  label: "MacBook Touch ID",
  createdAt: "2026-08-01T00:00:00.000Z",
  lastUsedAt: null,
  transports: ["internal", "hybrid"],
};

const CEREMONY_OPTIONS: PasskeyCeremonyOptions = {
  options: { challenge: "chal_placeholder_abc", rp: { id: "example.com", name: "w6w" } },
  challengeToken: "cht_placeholder_1",
};

const VERIFY_RESPONSE: PasskeyAuthenticationVerifyResponse = {
  token: "tok_new",
  user: { username: "alice@example.com", role: "user", tenant: "ten_1", emailVerified: true },
  expiresIn: 3600,
};

Deno.test("console.passkeys: all six operations are functions on a constructed client", () => {
  // Runtime, not type-level: a namespace that silently lost a method would
  // still typecheck everywhere else in this suite.
  const c = new W6WClient({ baseUrl: "https://api.example.com", token: "t" });
  for (
    const name of [
      "registrationOptions",
      "registrationVerify",
      "authenticationOptions",
      "authenticationVerify",
      "list",
      "revoke",
    ] as const
  ) {
    assertEquals(
      typeof c.console.passkeys[name],
      "function",
      `console.passkeys.${name} is missing`,
    );
  }
});

Deno.test(
  "console.passkeys.registrationOptions POSTs /me/passkeys/options with body {}",
  async () => {
    const c = client(() => json(CEREMONY_OPTIONS));

    const res = await c.client.console.passkeys.registrationOptions();

    assertEquals(res, CEREMONY_OPTIONS);
    assertEquals(c.calls.length, 1);
    assertEquals(c.calls[0].method, "POST");
    assertEquals(c.calls[0].url, "https://api.example.com/me/passkeys/options");
    assertEquals(JSON.parse(c.calls[0].body ?? "null"), {});
  },
);

Deno.test(
  "console.passkeys.registrationVerify POSTs /me/passkeys and unwraps the passkey envelope",
  async () => {
    const c = client(() => json({ passkey: PASSKEY }, 201));

    const res = await c.client.console.passkeys.registrationVerify({
      challengeToken: "cht_placeholder_1",
      response: { id: "cred_placeholder_1", type: "public-key" },
      label: "MacBook Touch ID",
    });

    assertEquals(res, PASSKEY);
    assertEquals(c.calls[0].method, "POST");
    assertEquals(c.calls[0].url, "https://api.example.com/me/passkeys");
    assertEquals(JSON.parse(c.calls[0].body ?? "null"), {
      challengeToken: "cht_placeholder_1",
      response: { id: "cred_placeholder_1", type: "public-key" },
      label: "MacBook Touch ID",
    });
  },
);

Deno.test(
  "console.passkeys.authenticationOptions POSTs /auth/passkey/options with body {}",
  async () => {
    const c = client(() => json(CEREMONY_OPTIONS));

    const res = await c.client.console.passkeys.authenticationOptions();

    assertEquals(res, CEREMONY_OPTIONS);
    assertEquals(c.calls[0].method, "POST");
    assertEquals(c.calls[0].url, "https://api.example.com/auth/passkey/options");
    assertEquals(JSON.parse(c.calls[0].body ?? "null"), {});
  },
);

Deno.test(
  "console.passkeys.authenticationVerify POSTs /auth/passkey/verify and mints a session, like login",
  async () => {
    const c = client(() => json(VERIFY_RESPONSE));

    const res = await c.client.console.passkeys.authenticationVerify({
      challengeToken: "cht_placeholder_1",
      response: { id: "cred_placeholder_1", type: "public-key" },
    });

    assertEquals(res, VERIFY_RESPONSE);
    assertEquals(c.calls[0].method, "POST");
    assertEquals(c.calls[0].url, "https://api.example.com/auth/passkey/verify");
    assertEquals(JSON.parse(c.calls[0].body ?? "null"), {
      challengeToken: "cht_placeholder_1",
      response: { id: "cred_placeholder_1", type: "public-key" },
    });
  },
);

Deno.test("console.passkeys.list GETs /me/passkeys and unwraps the passkeys envelope", async () => {
  const c = client(() => json({ passkeys: [PASSKEY] }));

  const res = await c.client.console.passkeys.list();

  assertEquals(res, [PASSKEY]);
  assertEquals(c.calls[0].method, "GET");
  assertEquals(c.calls[0].url, "https://api.example.com/me/passkeys");
  assertEquals(c.calls[0].body, null);
});

Deno.test("console.passkeys.revoke DELETEs /me/passkeys/:id and resolves void", async () => {
  const c = client(() => new Response(null, { status: 204 }));

  const res = await c.client.console.passkeys.revoke("pk_1");

  assertEquals(res, undefined);
  assertEquals(c.calls[0].method, "DELETE");
  assertEquals(c.calls[0].url, "https://api.example.com/me/passkeys/pk_1");
});

Deno.test("console.passkeys.revoke: the id is percent-encoded into the route", async () => {
  // Same gap as the vars/documents suites: an id fixture that already encodes
  // to itself would leave a dropped `path` tag invisible. An id carrying `/`
  // and `#` makes the tag load-bearing.
  const c = client(() => new Response(null, { status: 204 }));

  await c.client.console.passkeys.revoke("pk/1#x");

  assertStringIncludes(c.calls[0].url, "pk%2F1%23x");
});

Deno.test(
  "authenticationOptions/authenticationVerify send NO authorization header, even on a client holding a token",
  async () => {
    const c = client(() => json(CEREMONY_OPTIONS));
    await c.client.console.passkeys.authenticationOptions();
    assertEquals(c.calls[0].headers.get("authorization"), null);

    const c2 = client(() => json(VERIFY_RESPONSE));
    await c2.client.console.passkeys.authenticationVerify({
      challengeToken: "cht_placeholder_1",
      response: { id: "cred_placeholder_1" },
    });
    assertEquals(c2.calls[0].headers.get("authorization"), null);
  },
);

Deno.test(
  "authenticationOptions/authenticationVerify work on a TOKENLESS client — the actual bug requireAuth fixes",
  async () => {
    const fake = fakeFetch(() => json(CEREMONY_OPTIONS));
    const c = new W6WClient({ baseUrl: "https://api.example.com", fetch: fake.fetch }); // no token

    // Must resolve, not throw ConfigError.
    const res = await c.console.passkeys.authenticationOptions();
    assertEquals(res, CEREMONY_OPTIONS);

    const fake2 = fakeFetch(() => json(VERIFY_RESPONSE));
    const c2 = new W6WClient({ baseUrl: "https://api.example.com", fetch: fake2.fetch });
    const res2 = await c2.console.passkeys.authenticationVerify({
      challengeToken: "cht_placeholder_1",
      response: { id: "cred_placeholder_1" },
    });
    assertEquals(res2, VERIFY_RESPONSE);
  },
);

Deno.test(
  "registrationOptions/registrationVerify/list/revoke DO send the bearer — the opposite mutant",
  async () => {
    const c1 = client(() => json(CEREMONY_OPTIONS));
    await c1.client.console.passkeys.registrationOptions();
    assertEquals(c1.calls[0].headers.get("authorization"), "Bearer tok_1");

    const c2 = client(() => json({ passkey: PASSKEY }, 201));
    await c2.client.console.passkeys.registrationVerify({
      challengeToken: "cht_placeholder_1",
      response: { id: "cred_placeholder_1" },
    });
    assertEquals(c2.calls[0].headers.get("authorization"), "Bearer tok_1");

    const c3 = client(() => json({ passkeys: [PASSKEY] }));
    await c3.client.console.passkeys.list();
    assertEquals(c3.calls[0].headers.get("authorization"), "Bearer tok_1");

    const c4 = client(() => new Response(null, { status: 204 }));
    await c4.client.console.passkeys.revoke("pk_1");
    assertEquals(c4.calls[0].headers.get("authorization"), "Bearer tok_1");
  },
);

Deno.test(
  "console.passkeys: the WebAuthn response payload travels in the body, never the URL",
  async () => {
    const c = client(() => json({ passkey: PASSKEY }, 201));
    await c.client.console.passkeys.registrationVerify({
      challengeToken: "cht_placeholder_1",
      response: { id: "cred_secret_placeholder", clientDataJSON: "cdj_placeholder" },
    });
    assertEquals(c.calls[0].url.includes("?"), false);
    assertEquals(c.calls[0].url.includes("cred_secret_placeholder"), false);
    assertStringIncludes(c.calls[0].body ?? "", "cred_secret_placeholder");

    const c2 = client(() => json(VERIFY_RESPONSE));
    await c2.client.console.passkeys.authenticationVerify({
      challengeToken: "cht_placeholder_1",
      response: { id: "cred_secret_placeholder", clientDataJSON: "cdj_placeholder" },
    });
    assertEquals(c2.calls[0].url.includes("?"), false);
    assertEquals(c2.calls[0].url.includes("cred_secret_placeholder"), false);
    assertStringIncludes(c2.calls[0].body ?? "", "cred_secret_placeholder");
  },
);
