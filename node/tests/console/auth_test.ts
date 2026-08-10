/**
 * `client.console.auth.*`, against an injected fake `fetch`.
 *
 * No case here needs a live server (`docs/implementation.md` §9). Beyond the
 * per-operation assertions, this suite pins the two things that are new here
 * relative to `console.reliability`: the server's response shapes carry **no
 * envelope key** (so each method must return the body verbatim rather than
 * calling `unwrap()`), and three of the five methods must send **no**
 * `authorization` header, even on a client constructed with a token
 * (`RequestOptions.requireAuth`, HITL-9) — the other two, `createAccount` and
 * `getMe`, are authenticated and must send the bearer like any other request.
 *
 * `getMe` additionally carries the studio-internal capability field
 * `tenantAdmin` (`plan-B.md` § WIRE PINS W1/W9) that the published `Me` does
 * not declare, so its cases pin the field's presence on the resolved value and
 * the bearer on the recorded call.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { W6wClient } from "../../src/client.ts";
import type { FetchLike } from "../../src/config.ts";
import type {
  AccountWire,
  ConsoleMe,
  CreateAccountResponse,
  LoginResponse,
  SignupResponse,
  SignupUser,
  SlugAvailabilityResponse,
} from "../../src/console/auth.ts";

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

const LOGIN: LoginResponse = {
  token: "tok_new",
  user: { username: "alice" },
  expiresIn: 3600,
};

const SIGNUP_USER: SignupUser = {
  id: "usr_1",
  email: "alice@example.com",
  displayName: "Alice",
  emailVerified: false,
  tenant: "ten_1",
};

const ACCOUNT: AccountWire = {
  id: "acc_1",
  tenant: "ten_1",
  name: "Acme",
  slug: "acme",
  status: "active",
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
};

const SIGNUP: SignupResponse = {
  token: "tok_new",
  expiresIn: 3600,
  user: SIGNUP_USER,
  account: null,
};

const SLUG: SlugAvailabilityResponse = {
  slug: "acme",
  available: false,
  suggestions: ["acme-1", "acme-2"],
};

const CREATE_ACCOUNT: CreateAccountResponse = {
  account: ACCOUNT,
  token: "tok_reissued",
  expiresIn: 3600,
};

/** The console projection of `GET /auth/me` — a superset of the published `Me`. */
const ME: ConsoleMe = {
  tenant: "ten_1",
  subject: "usr_1",
  account: "acc_1",
  role: "admin",
  invokeBaseUrl: "https://api.example.com",
  tenantAdmin: true,
  versions: { composition: "server@1a2b3c4" },
};

Deno.test("console.auth: all five operations are functions on a constructed client", () => {
  // Runtime, not type-level: a namespace that silently lost a method would
  // still typecheck everywhere else in this suite.
  const c = new W6wClient({ baseUrl: "https://api.example.com", token: "t" });
  for (const name of ["login", "signup", "checkAccountSlug", "createAccount", "getMe"] as const) {
    assertEquals(typeof c.console.auth[name], "function", `console.auth.${name} is missing`);
  }
});

Deno.test("console.auth.login resolves with the payload VERBATIM — no unwrap()", async () => {
  const c = client(() => json(LOGIN));

  const res = await c.client.console.auth.login("alice", "hunter2");

  assertEquals(res, LOGIN);
  assertEquals(c.calls.length, 1);
  assertEquals(c.calls[0].method, "POST");
  assertEquals(c.calls[0].url, "https://api.example.com/auth/login");
  assertEquals(JSON.parse(c.calls[0].body ?? "null"), { username: "alice", password: "hunter2" });
});

Deno.test("console.auth.signup resolves with the payload VERBATIM — no unwrap()", async () => {
  const c = client(() => json(SIGNUP, 201));

  const res = await c.client.console.auth.signup({ email: "alice@example.com", password: "x" });

  assertEquals(res, SIGNUP);
  assertEquals(c.calls[0].method, "POST");
  assertEquals(c.calls[0].url, "https://api.example.com/auth/signup");
  assertEquals(JSON.parse(c.calls[0].body ?? "null"), {
    email: "alice@example.com",
    password: "x",
  });
});

Deno.test(
  "console.auth.signup forwards the body as-is, including inviteToken when given",
  async () => {
    const c = client(() => json(SIGNUP, 201));

    await c.client.console.auth.signup({
      email: "alice@example.com",
      password: "x",
      displayName: "Alice",
      inviteToken: "inv_1",
    });

    assertEquals(JSON.parse(c.calls[0].body ?? "null"), {
      email: "alice@example.com",
      password: "x",
      displayName: "Alice",
      inviteToken: "inv_1",
    });
  },
);

Deno.test(
  "console.auth.checkAccountSlug resolves with the payload VERBATIM — no unwrap()",
  async () => {
    const c = client(() => json(SLUG));

    const res = await c.client.console.auth.checkAccountSlug("acme");

    assertEquals(res, SLUG);
    assertEquals(c.calls[0].method, "GET");
    assertEquals(
      c.calls[0].url,
      "https://api.example.com/auth/signup/slug-available?name=acme",
    );
  },
);

Deno.test(
  "console.auth.createAccount resolves with the payload VERBATIM — no unwrap()",
  async () => {
    const c = client(() => json(CREATE_ACCOUNT, 201));

    const res = await c.client.console.auth.createAccount("Acme", "acme");

    assertEquals(res, CREATE_ACCOUNT);
    assertEquals(c.calls[0].method, "POST");
    assertEquals(c.calls[0].url, "https://api.example.com/accounts");
    assertEquals(JSON.parse(c.calls[0].body ?? "null"), { name: "Acme", slug: "acme" });
  },
);

Deno.test(
  "login/signup/checkAccountSlug send NO authorization header, even on a client holding a token",
  async () => {
    const c = client(() => json(LOGIN));
    await c.client.console.auth.login("u", "p");
    assertEquals(c.calls[0].headers.get("authorization"), null);

    const c2 = client(() => json(SIGNUP, 201));
    await c2.client.console.auth.signup({ email: "a@b.com", password: "x" });
    assertEquals(c2.calls[0].headers.get("authorization"), null);

    const c3 = client(() => json(SLUG));
    await c3.client.console.auth.checkAccountSlug("acme");
    assertEquals(c3.calls[0].headers.get("authorization"), null);
  },
);

Deno.test("createAccount DOES send the bearer — the opposite mutant", async () => {
  const c = client(() => json(CREATE_ACCOUNT, 201));

  await c.client.console.auth.createAccount("Acme", "acme");

  assertEquals(c.calls[0].headers.get("authorization"), "Bearer tok_1");
});

Deno.test(
  "login and signup work on a TOKENLESS client — the actual bug requireAuth fixes",
  async () => {
    const fake = fakeFetch(() => json(LOGIN));
    const c = new W6wClient({ baseUrl: "https://api.example.com", fetch: fake.fetch }); // no token

    // Must resolve, not throw ConfigError.
    const res = await c.console.auth.login("u", "p");
    assertEquals(res, LOGIN);

    const fake2 = fakeFetch(() => json(SIGNUP, 201));
    const c2 = new W6wClient({ baseUrl: "https://api.example.com", fetch: fake2.fetch });
    const res2 = await c2.console.auth.signup({ email: "a@b.com", password: "x" });
    assertEquals(res2, SIGNUP);
  },
);

Deno.test(
  "console.auth.getMe GETs /auth/me and resolves the flat body VERBATIM — no unwrap()",
  async () => {
    const c = client(() => json(ME));

    const res = await c.client.console.auth.getMe();

    // Verbatim: this method adds nothing to the body. `client.me()` (the base
    // surface) fills in `versions.wrapper` from this package's own VERSION —
    // a mutant that routed this method through `fetchMe` would show up here as
    // an extra `wrapper` key.
    assertEquals(res, ME);
    assertEquals(res.versions, { composition: "server@1a2b3c4" });
    assertEquals(c.calls.length, 1);
    assertEquals(c.calls[0].method, "GET");
    assertEquals(c.calls[0].url, "https://api.example.com/auth/me");
    assertEquals(c.calls[0].body, null);
  },
);

Deno.test("console.auth.getMe carries tenantAdmin through, both ways", async () => {
  const c = client(() => json(ME));
  assertEquals((await c.client.console.auth.getMe()).tenantAdmin, true);

  const c2 = client(() => json({ ...ME, tenantAdmin: false }));
  assertEquals((await c2.client.console.auth.getMe()).tenantAdmin, false);

  // An older host that never learned the key: `undefined` is falsy, so every
  // `if (me.tenantAdmin)` fails CLOSED. Pinned because it is the whole reason
  // the field is declared required rather than optional.
  const { tenantAdmin: _drop, ...withoutField } = ME;
  const c3 = client(() => json(withoutField));
  // Widened deliberately: the type says `boolean`, the wire may say nothing.
  const older: { tenantAdmin?: boolean } = await c3.client.console.auth.getMe();
  assertEquals(older.tenantAdmin, undefined);
});

/**
 * `tenantAdmin` is REQUIRED on {@linkcode ConsoleMe}, and this is the only
 * thing that pins it: every runtime case above still passes if the field is
 * quietly made optional (measured — see this task's
 * `artifacts/TB3-gate-strength.sh`, mutant M7). A client forced to branch on
 * `undefined` is a client that will branch wrong; the wire may omit the key
 * (an older host), and that case is handled by `undefined` being falsy at
 * runtime, not by relaxing the type a caller writes against.
 */
// @ts-expect-error — `tenantAdmin` is required; making it optional unpins the whole rule.
const _meWithoutCapability: ConsoleMe = { tenant: "t", subject: "s", account: "a", role: "r" };

Deno.test("ConsoleMe requires tenantAdmin — the type-level guard above is live", () => {
  assertEquals(typeof _meWithoutCapability, "object");
});

Deno.test("console.auth.getMe DOES send the bearer — it is not a public route", async () => {
  const c = client(() => json(ME));

  await c.client.console.auth.getMe();

  // `requireAuth` must be left at its default. A `requireAuth: false`
  // copy-pasted from `login` would make every call a 401 server-side.
  assertEquals(c.calls[0].headers.get("authorization"), "Bearer tok_1");
});

Deno.test(
  "checkAccountSlug's query param is encoded via `query`, not string concatenation",
  async () => {
    const c = client(() => json(SLUG));

    // `buildUrl` encodes via `URLSearchParams`, which is
    // application/x-www-form-urlencoded — a space becomes `+`, not `%20` (see
    // `http_test.ts`'s own "an unsafe key is encoded and sent" case, which
    // pins the identical `prj_a b` -> `prj_a+b` behaviour). A manual
    // `encodeURIComponent` concatenation would instead have produced `%20`, so
    // asserting the `+` form is what discriminates the two mechanisms.
    await c.client.console.auth.checkAccountSlug("a b");
    assertStringIncludes(c.calls[0].url, "name=a+b");

    const c2 = client(() => json(SLUG));
    await c2.client.console.auth.checkAccountSlug("a&b");
    assertStringIncludes(c2.calls[0].url, "name=a%26b");
  },
);
