# @w6w/sdk

The TypeScript client for the [w6w](https://w6w.dev) HTTP API.

It is a **thin** client: transport, auth, error mapping, and typed request/response shapes. No
business logic, no client-side polling, no hidden retries. If something useful needs two calls
composed, that composition belongs in the API, not here.

The package is authored as runtime-neutral TypeScript against Web standards (`fetch`, `Headers`,
`URL`, `AbortController`), so the same build runs under Node 18+, Deno and Bun.

- **License:** MIT (see [LICENSE](./LICENSE)).
- **Version:** `0.1.0`.

## Install

npm (compiled ESM + type declarations):

```bash
npm install @w6w/sdk
```

JSR (the TypeScript source, published verbatim):

```bash
deno add jsr:@w6w/sdk
```

Both registries publish the **same version at the same time** — `@w6w/sdk`, `@w6w/cli` and the
Python `w6w` package share one version number and are released together. A given version means the
same set of operations in every language.

## Configuration

Two environment variables, both read only at client construction:

| Variable       | Meaning                                                                                                                               | Required |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| `W6W_BASE_URL` | The **origin** of your w6w server, e.g. `https://api.example.com`. The API's base path is appended by the client — do not include it. | Yes      |
| `W6W_TOKEN`    | The bearer token, sent as `Authorization: Bearer <token>` on every request.                                                           | Yes      |

Explicit constructor arguments always win over the environment, and credentials are **instance
state**: two clients in one process can hold different tokens and point at different servers with no
interference. There is no default base URL — a client built without one and without `W6W_BASE_URL`
raises a configuration error naming the variable.

```ts
import { W6wClient } from "@w6w/sdk";

// Everything from the environment.
const client = new W6wClient();

// Explicit arguments override W6W_BASE_URL and W6W_TOKEN.
const other = new W6wClient({ baseUrl: "https://api.example.com", token: "…" });
```

### `W6W_BASE_URL` is an origin

The client appends the API's base path (`/api`) itself, and never doubles it — so a value that
already carries the prefix is left alone, and trailing slashes never matter:

| `W6W_BASE_URL`                | Requests go to                  |
| ----------------------------- | ------------------------------- |
| `https://api.example.com`     | `https://api.example.com/api/…` |
| `https://api.example.com/`    | `https://api.example.com/api/…` |
| `https://api.example.com///`  | `https://api.example.com/api/…` |
| `https://api.example.com/api` | `https://api.example.com/api/…` |

A variable that is **set but empty** — or whitespace-only — counts as **unset**, in both variables.
`W6W_BASE_URL=` is how a shell or a Dockerfile spells "I meant to set this and did not", so it
raises the same configuration error as an absent one rather than quietly producing a relative URL.
An empty string passed _explicitly_ to the constructor is likewise an error, and does not fall back
to the environment.

### `W6W_TOKEN`

Sent as `Authorization: Bearer <token>` on **every** request — there are no anonymous operations on
this API. A client with no token can still be constructed (so tools that only print help or a
version work offline); the configuration error naming `W6W_TOKEN` surfaces on the first request.

## Errors

Two error types, and the difference between them is diagnostic:

- **`ConfigError`** — the client never got as far as a request: no base URL, or no token.
- **`ApiError`** — carries `status`, `code`, `message` and `raw` (the parsed response body, kept
  because an error body carries fields the message drops). It covers exactly three cases: a
  transport failure (`status: 0`, code `network_error`), a non-JSON body on a failing status (code
  `bad_response`, with a snippet of what actually came back — usually a proxy's HTML error page),
  and the server's own error envelope (its `code` and `message`, verbatim).

Classify by `status`, and by a **prefix** of `code` (`unknown_*`, `invalid_*`, `*_exists`) — never
by an exhaustive list of codes, which the server extends freely. Note that a `424` means the target
app or its upstream vendor failed, not that w6w did; it is passed through untouched.

Nothing is retried, no token is refreshed, and a `401` has no side effect beyond the raised error.

## The surface

What operations exist is not decided in this repo. It is defined by the shared machine-readable
contract **`endpoints.json`**, which all three w6w wrappers implement and which each one's
conformance test reads directly — the same file, never a vendored copy. An operation missing from a
wrapper is a failing test, not a preference.

Some operations are marked `planned` in that contract: they are implemented and unit-tested here,
but the corresponding server route is not live yet, so calling them against a server today returns
`404`. The marker records **server** readiness, not wrapper completeness.

## Versioning

The version is a shared fact across all three wrappers, so a release may go out for this package
even when nothing in it changed — a divergent version is far more expensive than an empty release.

Below `1.0.0`, **breaking changes may land in a minor bump.** That grace ends at `1.0.0`; do not
plan around it.

## Development

The gates are Deno tasks. They need no network and no server:

```bash
deno task check      # typecheck mod.ts, src/ and tests/
deno task lint
deno task fmt:check
deno task test       # every test runs against a mocked transport
deno task cov        # test with coverage, then report it
```

Tests **never** require a live server. The npm `dist/` build (`npm run build`, i.e.
`tsc -p tsconfig.build.json`) runs in CI only; `src/*.ts` is the single authored source for both
registries.
