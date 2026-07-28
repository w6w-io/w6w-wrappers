/**
 * Global flags → a configured client, and → what the user sees.
 *
 * Everything here runs against a **fake environment object** and a **fake
 * transport**. Neither is a convenience: the real process environment is one
 * shared, mutable thing that only one test at a time could own, and a real
 * server would make the precedence rules untestable in CI. The one test that
 * does touch the real environment does so to prove the CLI **ignores** it, and
 * puts it back.
 *
 * The rules being pinned:
 *
 *  1. **Precedence** — `--base-url` beats `W6W_BASE_URL`, `--token` beats
 *     `W6W_TOKEN`, and with neither there is a usage error naming both sources.
 *  2. **Blank is absent** — an environment variable set to `""`, to whitespace,
 *     or to a newline behaves exactly like an unset one, and none of the four
 *     cases may result in a request to a relative URL.
 *  3. **Unusable values fail as usage errors, before any request** — a relative
 *     base URL, and a token carrying a character no HTTP header can hold.
 *  4. **Output** — `--json` puts the payload on stdout and nothing else;
 *     `--no-color` (and `NO_COLOR`, and a non-terminal stdout) suppress colour;
 *     errors are on stderr, always.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { ApiError, ConfigError } from "@w6w/sdk";
import type { FetchLike } from "@w6w/sdk";
import {
  createClient,
  createOutput,
  ENV_BASE_URL,
  ENV_NO_COLOR,
  ENV_TOKEN,
  envValue,
  GLOBAL_FLAGS,
  main,
  runCli,
  useColor,
} from "../mod.ts";
import type { CommandRegistry, EnvReader, GlobalOptions } from "../mod.ts";

// ---------------------------------------------------------------------------
// Fakes.
// ---------------------------------------------------------------------------

/** An environment built from a plain object. Nothing else is visible to it. */
function fakeEnv(values: Record<string, string> = {}): EnvReader {
  return (name: string) => values[name];
}

/** A transport that answers everything with `{"ok":true}` and remembers the call. */
function recordingFetch(
  respond: () => Response = () =>
    new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const impl: FetchLike = (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return Promise.resolve(respond());
  };
  return { calls, impl };
}

/** Records what an invocation wrote, per stream. */
function recorder() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: { stdout: (text: string) => out.push(text), stderr: (text: string) => err.push(text) },
    get stdout(): string {
      return out.join("\n");
    },
    get stderr(): string {
      return err.join("\n");
    },
  };
}

/** The global flags, with everything off unless a test says otherwise. */
function globals(overrides: Partial<GlobalOptions> = {}): GlobalOptions {
  return { json: false, noColor: false, version: false, help: false, ...overrides };
}

/** The `Authorization` header of a recorded call. */
function authorizationOf(init: RequestInit | undefined): string | null {
  return new Headers(init?.headers).get("authorization");
}

/** Every request the CLI makes is to an absolute URL. Never a relative path. */
function assertAbsolute(calls: { url: string }[]): void {
  for (const call of calls) {
    assert(
      call.url.startsWith("http://") || call.url.startsWith("https://"),
      `request went to a relative URL: ${call.url}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Precedence.
// ---------------------------------------------------------------------------

Deno.test("--base-url beats W6W_BASE_URL, and --token beats W6W_TOKEN", async () => {
  const transport = recordingFetch();
  const client = createClient(
    globals({ baseUrl: "https://flag.example.com", token: "t_flag" }),
    fakeEnv({ [ENV_BASE_URL]: "https://env.example.com", [ENV_TOKEN]: "t_env" }),
    { fetch: transport.impl },
  );

  // The base-path join is the SDK's, and this is the CLI reading it back rather
  // than re-deriving it — there is exactly one implementation of that rule.
  assertEquals(client.config.baseUrl, "https://flag.example.com");
  await client.request({ method: "GET", path: "/ping" });

  assertEquals(transport.calls.length, 1);
  assertEquals(transport.calls[0].url, "https://flag.example.com/ping");
  assertEquals(authorizationOf(transport.calls[0].init), "Bearer t_flag");
  assertAbsolute(transport.calls);
});

Deno.test("the environment configures the client when no flag does", async () => {
  const transport = recordingFetch();
  const client = createClient(
    globals(),
    fakeEnv({ [ENV_BASE_URL]: "https://env.example.com/", [ENV_TOKEN]: "t_env" }),
    { fetch: transport.impl },
  );

  // A trailing slash does not double the base path — again, the SDK's rule.
  assertEquals(client.config.baseUrl, "https://env.example.com");
  await client.request({ method: "GET", path: "/ping" });
  assertEquals(transport.calls[0].url, "https://env.example.com/ping");
  assertEquals(authorizationOf(transport.calls[0].init), "Bearer t_env");
  assertAbsolute(transport.calls);
});

Deno.test("one flag overrides its own source only", () => {
  const fromEnv = fakeEnv({ [ENV_BASE_URL]: "https://env.example.com", [ENV_TOKEN]: "t_env" });
  const baseUrlOnly = createClient(globals({ baseUrl: "https://flag.example.com" }), fromEnv);
  assertEquals(baseUrlOnly.config.baseUrl, "https://flag.example.com");
  assertEquals(baseUrlOnly.config.token, "t_env");

  const tokenOnly = createClient(globals({ token: "t_flag" }), fromEnv);
  assertEquals(tokenOnly.config.baseUrl, "https://env.example.com");
  assertEquals(tokenOnly.config.token, "t_flag");
});

Deno.test("the CLI never reads the real process environment behind the flags", () => {
  // The mechanism being pinned: the CLI resolves the values itself and passes
  // them to the SDK explicitly, so the SDK's own environment reading is never
  // what configures a command. Proven by making the real environment say
  // something else entirely and showing it has no effect.
  const previous = { base: Deno.env.get(ENV_BASE_URL), token: Deno.env.get(ENV_TOKEN) };
  try {
    Deno.env.set(ENV_BASE_URL, "https://real-environment.example.com");
    Deno.env.set(ENV_TOKEN, "t_real_environment");
    const client = createClient(
      globals(),
      fakeEnv({ [ENV_BASE_URL]: "https://fake.example.com", [ENV_TOKEN]: "t_fake" }),
    );
    assertEquals(client.config.baseUrl, "https://fake.example.com");
    assertEquals(client.config.token, "t_fake");
  } finally {
    if (previous.base === undefined) Deno.env.delete(ENV_BASE_URL);
    else Deno.env.set(ENV_BASE_URL, previous.base);
    if (previous.token === undefined) Deno.env.delete(ENV_TOKEN);
    else Deno.env.set(ENV_TOKEN, previous.token);
  }
});

Deno.test("the environment variable names are the contract's, not this file's", () => {
  const declared = (flag: string) => GLOBAL_FLAGS.find((entry) => entry.name === flag)?.env;
  assertEquals(declared("--base-url"), ENV_BASE_URL);
  assertEquals(declared("--token"), ENV_TOKEN);
});

// ---------------------------------------------------------------------------
// Blank is absent — and nothing resolves to a relative URL.
// ---------------------------------------------------------------------------

Deno.test("a blank W6W_BASE_URL behaves exactly like an unset one", async () => {
  // Four inputs, one behaviour. Testing only the unset case is the gap this
  // closes: `??` would let "" through, and the join rule would turn it into the
  // relative "/api" — a request that fails somewhere else, about something else.
  for (const value of ["", "   ", "\n", undefined]) {
    const label = JSON.stringify(value);
    const env = value === undefined ? fakeEnv({}) : fakeEnv({ [ENV_BASE_URL]: value });
    const transport = recordingFetch();
    const io = recorder();

    const code = await main(["me"], io.io, {
      env,
      fetch: transport.impl,
      commands: { me: (context) => void context.client() },
    });

    assertEquals(code, 1, `W6W_BASE_URL=${label} should be a usage error`);
    assertEquals(transport.calls.length, 0, `W6W_BASE_URL=${label} made a request anyway`);
    assertStringIncludes(io.stderr, "--base-url");
    assertStringIncludes(io.stderr, ENV_BASE_URL);
    assertEquals(io.stdout, "", "an error must not be written to stdout");
  }
});

Deno.test("a blank W6W_TOKEN behaves exactly like an unset one", async () => {
  for (const value of ["", "   ", "\n", undefined]) {
    const label = JSON.stringify(value);
    const values: Record<string, string> = { [ENV_BASE_URL]: "https://env.example.com" };
    if (value !== undefined) values[ENV_TOKEN] = value;
    const transport = recordingFetch();
    const io = recorder();

    const code = await main(["me"], io.io, {
      env: fakeEnv(values),
      fetch: transport.impl,
      commands: { me: (context) => void context.client() },
    });

    assertEquals(code, 1, `W6W_TOKEN=${label} should be a usage error`);
    assertEquals(transport.calls.length, 0, `W6W_TOKEN=${label} made a request anyway`);
    assertStringIncludes(io.stderr, "--token");
    assertStringIncludes(io.stderr, ENV_TOKEN);
  }
});

Deno.test("envValue treats blank as absent and returns everything else verbatim", () => {
  const env = fakeEnv({ blank: "", spaces: "   ", newline: "\n", real: "  padded  " });
  assertEquals(envValue(env, "blank"), undefined);
  assertEquals(envValue(env, "spaces"), undefined);
  assertEquals(envValue(env, "newline"), undefined);
  assertEquals(envValue(env, "missing"), undefined);
  // Trimming is the emptiness test, not a normalisation of the value.
  assertEquals(envValue(env, "real"), "  padded  ");
});

Deno.test("an explicit empty flag does not fall through to the environment", () => {
  // A flag the user typed is a value they chose, so it wins — it just is not a
  // usable one. What it must not do is quietly consult the environment instead.
  const env = fakeEnv({ [ENV_BASE_URL]: "https://env.example.com", [ENV_TOKEN]: "t_env" });
  let raised: unknown = null;
  try {
    createClient(globals({ baseUrl: "" }), env);
  } catch (error) {
    raised = error;
  }
  assert(raised instanceof ConfigError, `expected a ConfigError, got ${raised}`);
  assertStringIncludes(raised.message, "--base-url");
  assertStringIncludes(raised.message, ENV_BASE_URL);
});

// ---------------------------------------------------------------------------
// Values that cannot work, rejected before a request rather than after one.
// ---------------------------------------------------------------------------

Deno.test("a relative or schemeless base URL is a usage error, not a dead server", async () => {
  // The failure mode this prevents: a relative base resolves, the request goes
  // nowhere, and the user is told the server may be down — so they go and
  // restart a server that was never the problem.
  for (const baseUrl of ["/api", "api.example.com", "localhost:8080", "ftp://api.example.com"]) {
    const transport = recordingFetch();
    const io = recorder();
    const code = await main(["me"], io.io, {
      env: fakeEnv({ [ENV_TOKEN]: "t_env" }),
      fetch: transport.impl,
      commands: { me: (context) => void context.client() },
    });
    assertEquals(code, 1, `\`${baseUrl}\` via the environment should be a usage error`);
    assertEquals(transport.calls.length, 0);

    const direct = recorder();
    const withFlag = await main(["me", "--base-url", baseUrl], direct.io, {
      env: fakeEnv({ [ENV_TOKEN]: "t_env" }),
      fetch: transport.impl,
      commands: { me: (context) => void context.client() },
    });
    assertEquals(withFlag, 1, `\`${baseUrl}\` via --base-url should be a usage error`);
    assertEquals(transport.calls.length, 0, `\`${baseUrl}\` made a request anyway`);
    assertStringIncludes(direct.stderr, "--base-url");
    assertStringIncludes(direct.stderr, ENV_BASE_URL);
  }
});

Deno.test("a token that cannot be sent in a header is a usage error, not a stack trace", async () => {
  // `\r`, `\n` and `\x00` all reach the header builder and come back as a bare
  // TypeError from outside anyone's error model. The newline is the one that
  // actually happens: W6W_TOKEN=$(cat token.txt).
  for (const token of ["t_ok\r", "t_ok\n", "t_ok\x00", "t_ ok", "t ok\x7f"]) {
    const transport = recordingFetch();
    const io = recorder();
    const code = await main(["me"], io.io, {
      env: fakeEnv({ [ENV_BASE_URL]: "https://env.example.com", [ENV_TOKEN]: token }),
      fetch: transport.impl,
      commands: { me: (context) => void context.client() },
    });
    assertEquals(code, 1, `${JSON.stringify(token)} should be a usage error`);
    assertEquals(transport.calls.length, 0, `${JSON.stringify(token)} made a request anyway`);
    assertStringIncludes(io.stderr, "--token");
    assertStringIncludes(io.stderr, ENV_TOKEN);
    assertEquals(io.stdout, "");
  }
});

Deno.test("an ordinary token is sent verbatim", async () => {
  const transport = recordingFetch();
  const client = createClient(
    globals({ token: "eyJhbGciOi.J9-_~+/=" }),
    fakeEnv({ [ENV_BASE_URL]: "https://env.example.com" }),
    { fetch: transport.impl },
  );
  await client.request({ method: "GET", path: "/ping" });
  assertEquals(authorizationOf(transport.calls[0].init), "Bearer eyJhbGciOi.J9-_~+/=");
});

// ---------------------------------------------------------------------------
// Laziness — the help path never configures anything.
// ---------------------------------------------------------------------------

Deno.test("nothing constructs a client until a command asks for one", async () => {
  const forbidden: EnvReader = (name) => {
    throw new Error(`the help path read the environment: ${name}`);
  };
  for (const argv of [["--help"], ["--version"], ["documents", "--help"], ["me", "--help"], []]) {
    const io = recorder();
    const code = await main(argv, io.io, { env: forbidden, isTty: true });
    assertEquals(code, 0, `\`w6w ${argv.join(" ")}\` should exit 0 with nothing configured`);
    assert(io.stdout.length > 0);
  }

  // And a command that answers without the API is never handed one either.
  const io = recorder();
  const code = await main(["me"], io.io, {
    env: forbidden,
    commands: { me: (context) => context.out.note("no API needed") },
  });
  assertEquals(code, 0);
  assertEquals(io.stdout, "no API needed");
});

Deno.test("a command that asks twice gets one client", async () => {
  const transport = recordingFetch();
  let first: unknown = null;
  let second: unknown = null;
  const commands: CommandRegistry = {
    me: (context) => {
      first = context.client();
      second = context.client();
    },
  };
  const code = await main(["me"], recorder().io, {
    env: fakeEnv({ [ENV_BASE_URL]: "https://env.example.com", [ENV_TOKEN]: "t_env" }),
    fetch: transport.impl,
    commands,
  });
  assertEquals(code, 0);
  assert(first !== null && first === second, "client() built a second client");
});

// ---------------------------------------------------------------------------
// Output: --json, --no-color, and which stream things land on.
// ---------------------------------------------------------------------------

Deno.test("--json prints the payload and nothing else", async () => {
  const payload = { id: "doc_1", key: "greeting", content: { hello: "world" } };
  const io = recorder();
  const code = await main(["me", "--json"], io.io, {
    isTty: true,
    commands: {
      me: (context) => {
        context.out.note("this line is for humans");
        context.out.emit(payload, () => "Human rendering");
      },
    },
  });
  assertEquals(code, 0);
  assertEquals(JSON.parse(io.stdout), payload);
  assertEquals(io.stderr, "");
});

Deno.test("without --json the human rendering is what reaches stdout", async () => {
  const io = recorder();
  await main(["me"], io.io, {
    commands: {
      me: (context) => {
        context.out.note("1 document");
        context.out.emit({ id: "doc_1" }, (styles) => styles.bold("doc_1"));
      },
    },
  });
  assertEquals(io.stdout, "1 document\ndoc_1");
});

Deno.test("errors are written to stderr, never to stdout", async () => {
  const transport = recordingFetch(() =>
    new Response(
      JSON.stringify({ error: { code: "unknown_document", message: "no such thing" } }),
      {
        status: 404,
        headers: { "content-type": "application/json" },
      },
    )
  );
  const io = recorder();
  const code = await main(["me", "--json"], io.io, {
    env: fakeEnv({ [ENV_BASE_URL]: "https://env.example.com", [ENV_TOKEN]: "t_env" }),
    fetch: transport.impl,
    commands: {
      me: async (context) => void await context.client().request({ method: "GET", path: "/ping" }),
    },
  });
  assertEquals(code, 2);
  assertEquals(io.stdout, "", "an error must never reach stdout — --json output is data");
  assertStringIncludes(io.stderr, "no such thing");
  assertAbsolute(transport.calls);
});

Deno.test("colour is suppressed by --no-color, by NO_COLOR, and by a non-terminal stdout", () => {
  const plain = fakeEnv({});
  assert(useColor({ isTty: true, env: plain }), "a terminal with nothing objecting should colour");
  assert(!useColor({ isTty: true, noColor: true, env: plain }), "--no-color must win");
  assert(!useColor({ isTty: false, env: plain }), "a pipe must never be coloured");
  assert(!useColor({ env: plain }), "an unknown stdout is treated as a pipe");
  assert(!useColor({ isTty: true, json: true, env: plain }), "--json must never be coloured");
  assert(
    !useColor({ isTty: true, env: fakeEnv({ [ENV_NO_COLOR]: "1" }) }),
    "NO_COLOR must be honoured",
  );
  // Blank is absent here too, for the same reason it is everywhere else.
  assert(
    useColor({ isTty: true, env: fakeEnv({ [ENV_NO_COLOR]: "  " }) }),
    "a blank NO_COLOR is not a NO_COLOR",
  );
});

Deno.test("the renderer decorates only when colour is on", () => {
  const io = recorder();
  const coloured = createOutput(io.io, { isTty: true });
  assert(coloured.color);
  assertEquals(coloured.styles.bold("x"), "\x1b[1mx\x1b[0m");

  const plain = createOutput(io.io, { isTty: true, noColor: true });
  assert(!plain.color);
  assertEquals(plain.styles.bold("x"), "x");
  assertEquals(plain.styles.dim("x"), "x");
  assertEquals(plain.styles.red("x"), "x");
  assertEquals(plain.styles.green("x"), "x");
  assertEquals(plain.styles.yellow("x"), "x");
});

Deno.test("a command's own flags reach its handler", async () => {
  // `--project` is declared by the `documents` commands rather than globally, so
  // it is unknown to the first parse — the dispatcher gives the resolved
  // command's own flags a second pass. Without that, no command flag could ever
  // reach a handler.
  let seen: unknown = null;
  const io = recorder();
  const code = await main(["documents", "list", "--project", "prj_1"], io.io, {
    commands: { "documents list": (context) => void (seen = context.invocation.options.project) },
  });
  assertEquals(code, 0);
  assertEquals(seen, "prj_1");

  // A flag that no level declares is still a usage error, on the command's help.
  const bad = recorder();
  assertEquals(await main(["documents", "list", "--bogus"], bad.io, {}), 1);
  assertStringIncludes(bad.stderr, "unknown flag: --bogus");
});

Deno.test("a command with no handler says so instead of exiting 0", async () => {
  const io = recorder();
  const code = await main(["me"], io.io, {});
  assertEquals(code, 1);
  assertEquals(io.stdout, "");
  assertStringIncludes(io.stderr, "not available in this build");
});

Deno.test("a handler that returns a code is obeyed; one that throws anything is not success", async () => {
  const explicit = recorder();
  assertEquals(await main(["me"], explicit.io, { commands: { me: () => 3 } }), 3);

  // `throw "boom"` is legal JavaScript, and it must not become an exit 0.
  const thrown = recorder();
  assertEquals(
    await main(["me"], thrown.io, {
      commands: {
        me: () => {
          throw "boom";
        },
      },
    }),
    1,
  );
  assertStringIncludes(thrown.stderr, "boom");
  assertEquals(thrown.stdout, "");
});

Deno.test("an unknown flag is a usage error at every level, with the right help", async () => {
  // The second parse pass only happens when the first failure named a command,
  // so each of these takes a different route to the same answer.
  const cases: [string[], string][] = [
    [["--bogus"], "w6w — command-line client"], // no command at all → root help
    [["documents", "--bogus"], "w6w documents — "], // a group → group help
    [["me", "--bogus"], "w6w me — "], // a command with no flags of its own
    [["workflows", "run", "--bogus"], "w6w workflows run — "], // one that has them
  ];
  for (const [argv, expected] of cases) {
    const io = recorder();
    assertEquals(
      await main(argv, io.io, {}),
      1,
      `\`w6w ${argv.join(" ")}\` should be a usage error`,
    );
    assertEquals(io.stdout, "");
    assertStringIncludes(io.stderr, "unknown flag: --bogus");
    assertStringIncludes(io.stderr, expected);
  }
});

Deno.test("the synchronous entry point answers help and refuses to run a command", () => {
  const help = recorder();
  assertEquals(runCli(["--help"], help.io), 0);
  assert(help.stdout.length > 0);

  const command = recorder();
  assertEquals(runCli(["me"], command.io), 1);
  assertEquals(command.stdout, "");
  assertStringIncludes(command.stderr, "needs the API");
});

Deno.test("an ApiError is what the SDK raises — the CLI adds no error type of its own", async () => {
  const transport = recordingFetch(() =>
    new Response("<html>gateway</html>", { status: 502, headers: { "content-type": "text/html" } })
  );
  const client = createClient(
    globals({ baseUrl: "https://env.example.com", token: "t_env" }),
    fakeEnv({}),
    { fetch: transport.impl },
  );
  let raised: unknown = null;
  try {
    await client.request({ method: "GET", path: "/ping" });
  } catch (error) {
    raised = error;
  }
  assert(raised instanceof ApiError, `expected the SDK's ApiError, got ${raised}`);
  assertEquals(raised.status, 502);
});
