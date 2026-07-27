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
