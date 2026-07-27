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
import { BASE_PATH, joinBaseUrl, requireToken, resolveConfig } from "../src/config.ts";
import { ConfigError } from "../src/errors.ts";
import { W6wClient } from "../src/client.ts";

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

Deno.test("the base path is appended to a bare origin", () => {
  withEnv(NO_ENV, () => {
    assertEquals(
      resolveConfig({ baseUrl: "https://api.example.com" }).baseUrl,
      "https://api.example.com/api",
    );
  });
  assertEquals(joinBaseUrl("https://api.example.com"), "https://api.example.com/api");
  assertEquals(BASE_PATH, "/api");
});

Deno.test("trailing slashes are stripped before the base path is appended", () => {
  withEnv(NO_ENV, () => {
    assertEquals(
      resolveConfig({ baseUrl: "https://api.example.com/" }).baseUrl,
      "https://api.example.com/api",
    );
    // "All trailing slashes", not "one".
    assertEquals(
      resolveConfig({ baseUrl: "https://api.example.com///" }).baseUrl,
      "https://api.example.com/api",
    );
  });
});

Deno.test("a base URL that already ends in the base path is not doubled", () => {
  withEnv(NO_ENV, () => {
    assertEquals(
      resolveConfig({ baseUrl: "https://api.example.com/api" }).baseUrl,
      "https://api.example.com/api",
    );
    assertEquals(
      resolveConfig({ baseUrl: "https://api.example.com/api/" }).baseUrl,
      "https://api.example.com/api",
    );
  });
});

Deno.test("W6W_BASE_URL and W6W_TOKEN are read from the environment", () => {
  withEnv({ W6W_BASE_URL: "https://env.example.com/", W6W_TOKEN: "tok_env" }, () => {
    const config = resolveConfig();
    assertEquals(config.baseUrl, "https://env.example.com/api");
    assertEquals(config.token, "tok_env");
  });
});

Deno.test("an explicit argument overrides the environment", () => {
  withEnv({ W6W_BASE_URL: "https://env.example.com", W6W_TOKEN: "tok_env" }, () => {
    const config = resolveConfig({ baseUrl: "https://arg.example.com", token: "tok_arg" });
    assertEquals(config.baseUrl, "https://arg.example.com/api");
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
    const a = new W6wClient({ baseUrl: "https://a.example.com", token: "tok_a" });
    const b = new W6wClient({ baseUrl: "https://b.example.com/api/", token: "tok_b" });
    const fromEnv = new W6wClient();

    assertEquals(a.config, { baseUrl: "https://a.example.com/api", token: "tok_a", project: null });
    assertEquals(b.config, { baseUrl: "https://b.example.com/api", token: "tok_b", project: null });
    assertEquals(fromEnv.config.baseUrl, "https://env.example.com/api");
    assertEquals(fromEnv.config.token, "tok_env");
  });
});
