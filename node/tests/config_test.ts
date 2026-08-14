/**
 * Configuration resolution: the base-URL rule, precedence, and the two ways a
 * client can be unusable.
 *
 * These are the cross-cutting tests `docs/implementation.md` §9 requires once
 * per wrapper (items 3, 4 and 8). They exercise the single environment seam —
 * `src/env.ts` — by setting real variables and restoring them, which is
 * possible precisely *because* there is only one seam to exercise.
 */

import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import {
  BASE_PATH,
  type FetchLike,
  joinBaseUrl,
  requireToken,
  resolveConfig,
} from "../src/config.ts";
import { ConfigError } from "../src/errors.ts";
import { W6WClient } from "../src/client.ts";

/**
 * Run `fn` with the given variables set (or deleted, for `undefined`), then put
 * the environment back exactly as it was — including variables the surrounding
 * shell had set, which a bare `delete` would otherwise destroy for later tests.
 */
function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const saved = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries(vars)) {
    saved.set(name, Deno.env.get(name));
    if (value === undefined) Deno.env.delete(name);
    else Deno.env.set(name, value);
  }
  try {
    fn();
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) Deno.env.delete(name);
      else Deno.env.set(name, value);
    }
  }
}

const NO_ENV = { W6W_BASE_URL: undefined, W6W_TOKEN: undefined };

Deno.test("a bare origin is used as-is — no base path is appended", () => {
  withEnv(NO_ENV, () => {
    assertEquals(
      resolveConfig({ baseUrl: "https://api.example.com" }).baseUrl,
      "https://api.example.com",
    );
  });
  assertEquals(joinBaseUrl("https://api.example.com"), "https://api.example.com");
  // Empty since 0.2.0: the API serves at the root of its own host.
  assertEquals(BASE_PATH, "");
});

Deno.test("joinBaseUrl and the client resolve to the same EXPECTED value", () => {
  // Both sides are asserted against a written-out expectation, never merely
  // against each other: once the helper and the resolver share one
  // implementation — which is the point of this pin — an equality-only
  // assertion between the two can never fail, whatever either of them does.
  // (The python lane shipped exactly that vacuous test and then caught it.)
  const cases: Array<[string, string]> = [
    ["https://api.example.com", "https://api.example.com"],
    ["https://api.example.com/", "https://api.example.com"],
    ["https://api.example.com///", "https://api.example.com"],
    // A configured path is PRESERVED, never stripped — it may be a real gateway
    // prefix. That includes a stale "/api" carried over from 0.1.x, which is
    // indistinguishable from one and is left to 404 rather than be guessed at.
    ["https://api.example.com/api", "https://api.example.com/api"],
    ["https://api.example.com/api/", "https://api.example.com/api"],
    ["https://api.example.com/myapi", "https://api.example.com/myapi"],
    // The divergence this pin closes: the helper used to skip the whitespace
    // trim the resolver did, so it answered "  https://api.example.com/  " for
    // the value the client resolved correctly.
    ["  https://api.example.com/  ", "https://api.example.com"],
    ["\thttps://api.example.com\n", "https://api.example.com"],
    ["http://localhost:8080", "http://localhost:8080"],
  ];
  withEnv(NO_ENV, () => {
    for (const [origin, expected] of cases) {
      assertEquals(joinBaseUrl(origin), expected, `joinBaseUrl(${JSON.stringify(origin)})`);
      assertEquals(
        resolveConfig({ baseUrl: origin }).baseUrl,
        expected,
        `resolveConfig(${JSON.stringify(origin)})`,
      );
    }
  });
});

Deno.test("a relative or hostless base URL is a configuration error, not an outage", () => {
  // The hole this closes: `resolveConfig({baseUrl: "/foo"})` used to SUCCEED,
  // yielding a relative base. The request then went nowhere useful and
  // surfaced as `network_error` — "It may be down or unreachable" — which sends
  // the user looking at the server instead of at their own configuration.
  //
  // `http:///foo` is in this list for a measured reason: the WHATWG parser does
  // not reject it and does not leave the host empty — `new URL("http:///foo")`
  // resolves to `http://foo/` — so a host-only check would accept it and then
  // talk to a server nobody named.
  const rejected = [
    "",
    "   ",
    "/foo",
    "http:///foo",
    "example.com",
    "//evil.com",
    "ftp://api.example.com",
    "file:///etc/passwd",
    "localhost:8080",
    // Shape is fine, but the parser refuses it: port out of range.
    "http://api.example.com:99999",
  ];
  withEnv(NO_ENV, () => {
    for (const origin of rejected) {
      const fromHelper = assertThrows(
        () => joinBaseUrl(origin),
        ConfigError,
        undefined,
        `joinBaseUrl(${JSON.stringify(origin)}) should raise`,
      );
      const fromConfig = assertThrows(
        () => resolveConfig({ baseUrl: origin }),
        ConfigError,
        undefined,
        `resolveConfig(${JSON.stringify(origin)}) should raise`,
      );
      // The two paths raise the SAME diagnosis, because there is one path.
      assertEquals(fromHelper.message, fromConfig.message);
      // It names the variable an operator would have to fix…
      assertStringIncludes(fromHelper.message, "W6W_BASE_URL");
      // …and it never blames the network for a configuration mistake.
      assertEquals(fromHelper.message.includes("may be down"), false);
      assertEquals(fromHelper.message.includes("unreachable"), false);
    }
  });
});

Deno.test("a relative base URL from the environment is rejected too", () => {
  // The empty-string env rule closes this hole from one side only: a blank
  // W6W_BASE_URL is absent, but a *present* relative one walked straight past it.
  withEnv({ W6W_BASE_URL: "/api", W6W_TOKEN: "tok_env" }, () => {
    const err = assertThrows(() => resolveConfig(), ConfigError);
    assertStringIncludes(err.message, "W6W_BASE_URL");
  });
});

Deno.test("a client with a relative base URL never issues a request", () => {
  // The behavioural half of the pin: the failure has to happen at construction,
  // before any transport is reached, or the diagnosis arrives as a network error.
  let calls = 0;
  const spy: FetchLike = () => {
    calls += 1;
    return Promise.resolve(new Response("{}", { status: 200 }));
  };
  withEnv(NO_ENV, () => {
    assertThrows(
      () => new W6WClient({ baseUrl: "/foo", token: "tok_1", fetch: spy }),
      ConfigError,
    );
  });
  assertEquals(calls, 0);
});

Deno.test("trailing slashes are stripped", () => {
  withEnv(NO_ENV, () => {
    assertEquals(
      resolveConfig({ baseUrl: "https://api.example.com/" }).baseUrl,
      "https://api.example.com",
    );
    // "All trailing slashes", not "one".
    assertEquals(
      resolveConfig({ baseUrl: "https://api.example.com///" }).baseUrl,
      "https://api.example.com",
    );
  });
});

Deno.test("a configured path is preserved, not stripped", () => {
  // Nothing is appended, so nothing can be doubled; the risk runs the other way
  // now. A path in the configured value may be a real gateway prefix, so it is
  // carried through verbatim — including a stale "/api" from 0.1.x, which is
  // indistinguishable from one. Only trailing slashes come off.
  withEnv(NO_ENV, () => {
    assertEquals(
      resolveConfig({ baseUrl: "https://api.example.com/api" }).baseUrl,
      "https://api.example.com/api",
    );
    assertEquals(
      resolveConfig({ baseUrl: "https://api.example.com/api/" }).baseUrl,
      "https://api.example.com/api",
    );
    assertEquals(
      resolveConfig({ baseUrl: "https://api.example.com/gw/v2" }).baseUrl,
      "https://api.example.com/gw/v2",
    );
  });
});

Deno.test("W6W_BASE_URL and W6W_TOKEN are read from the environment", () => {
  withEnv({ W6W_BASE_URL: "https://env.example.com/", W6W_TOKEN: "tok_env" }, () => {
    const config = resolveConfig();
    assertEquals(config.baseUrl, "https://env.example.com");
    assertEquals(config.token, "tok_env");
  });
});

Deno.test("an explicit argument overrides the environment", () => {
  withEnv({ W6W_BASE_URL: "https://env.example.com", W6W_TOKEN: "tok_env" }, () => {
    const config = resolveConfig({ baseUrl: "https://arg.example.com", token: "tok_arg" });
    assertEquals(config.baseUrl, "https://arg.example.com");
    assertEquals(config.token, "tok_arg");
  });
});

Deno.test("a missing base URL raises a ConfigError naming W6W_BASE_URL", () => {
  withEnv(NO_ENV, () => {
    const err = assertThrows(() => resolveConfig(), ConfigError);
    assertStringIncludes(err.message, "W6W_BASE_URL");
    // Actionable: it says what to pass as well as what to export.
    assertStringIncludes(err.message, "baseUrl");
  });
});

Deno.test("an empty or blank W6W_BASE_URL behaves exactly like an unset one", () => {
  // The regression this pins: `??` treats "" as a value, so an empty variable
  // would survive into the join rule and resolve to the RELATIVE url "/api" —
  // a browser same-origin assumption that has no meaning in a library. An
  // env var set to "" is how a Dockerfile spells "never given a value".
  for (const blank of ["", "   ", "\n"]) {
    withEnv({ W6W_BASE_URL: blank, W6W_TOKEN: undefined }, () => {
      const err = assertThrows(() => resolveConfig(), ConfigError);
      assertStringIncludes(err.message, "W6W_BASE_URL");
    });
  }
  // …and a blank W6W_TOKEN is absent too, rather than an empty bearer.
  withEnv({ W6W_BASE_URL: "https://api.example.com", W6W_TOKEN: "  " }, () => {
    assertEquals(resolveConfig().token, null);
  });
});

Deno.test("a base URL of nothing but slashes is still empty", () => {
  withEnv(NO_ENV, () => {
    assertThrows(() => resolveConfig({ baseUrl: "///" }), ConfigError);
  });
});

Deno.test("an explicit empty base URL does not fall through to the environment", () => {
  // "An explicitly passed empty string is an explicit value, not 'unset'" — it
  // must not silently pick up the ambient W6W_BASE_URL instead.
  withEnv({ W6W_BASE_URL: "https://env.example.com", W6W_TOKEN: undefined }, () => {
    const err = assertThrows(() => resolveConfig({ baseUrl: "" }), ConfigError);
    assertStringIncludes(err.message, "W6W_BASE_URL");
  });
});

Deno.test("a client with no token is constructible and fails only when used", () => {
  withEnv({ W6W_BASE_URL: "https://api.example.com", W6W_TOKEN: undefined }, () => {
    const config = resolveConfig();
    assertEquals(config.token, null);
    const err = assertThrows(() => requireToken(config), ConfigError);
    assertStringIncludes(err.message, "W6W_TOKEN");
  });
});

Deno.test("the default project is instance state and defaults to null", () => {
  withEnv(NO_ENV, () => {
    assertEquals(resolveConfig({ baseUrl: "https://a.example.com" }).project, null);
    assertEquals(
      resolveConfig({ baseUrl: "https://a.example.com", project: "prj_1" }).project,
      "prj_1",
    );
  });
});

Deno.test("two clients in one process hold different credentials and base URLs", () => {
  // The test that actually prevents the module-global regression: the browser
  // client this package transcribes keeps its token in a module variable, and
  // under that design the second construction would overwrite the first.
  withEnv({ W6W_BASE_URL: "https://env.example.com", W6W_TOKEN: "tok_env" }, () => {
    const a = new W6WClient({ baseUrl: "https://a.example.com", token: "tok_a" });
    const b = new W6WClient({ baseUrl: "https://b.example.com/api/", token: "tok_b" });
    const fromEnv = new W6WClient();

    assertEquals(a.config, { baseUrl: "https://a.example.com", token: "tok_a", project: null });
    // `b` configured an explicit "/api/" path: the trailing slash comes off, the
    // path itself is preserved (it may be a gateway prefix).
    assertEquals(b.config, { baseUrl: "https://b.example.com/api", token: "tok_b", project: null });
    assertEquals(fromEnv.config.baseUrl, "https://env.example.com");
    assertEquals(fromEnv.config.token, "tok_env");
  });
});
