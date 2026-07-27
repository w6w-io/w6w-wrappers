# w6w wrappers

Open-source client libraries that wrap the w6w HTTP API.

| Wrapper | Repo | Published as | Language |
|---------|------|--------------|----------|
| `node`   | `w6w-io/w6w-node`   | `@w6w/sdk` (npm)  | TypeScript |
| `cli`    | `w6w-io/w6w-cli`    | `@w6w/cli` (npm), binary `w6w` | TypeScript |
| `python` | `w6w-io/w6w-python` | `w6w` (PyPI)      | Python |

Each wrapper is its **own git repo**, open source, and attached here as a
**submodule**. This directory itself is tracked by the monorepo — it holds the
shared contract (`endpoints.json`, `VERSION`, these docs) plus the submodule
pointers. The release workflows live in the monorepo too, at
`.github/workflows/`, not in the wrapper repos.

## The two rules

**1. One surface.** [`endpoints.json`](./endpoints.json) is the machine-readable
source of truth for what every wrapper must expose. A wrapper is not conformant
until it implements every operation in it. See [docs/endpoints.md](./docs/endpoints.md)
for the catalog with wire shapes and per-language signatures.

**2. One version, released together.** [`VERSION`](./VERSION) holds the single
version all three wrappers publish under. There is no such thing as
`@w6w/sdk@0.2.0` without `@w6w/cli@0.2.0` and `w6w==0.2.0`. A user on any
wrapper at version *X* gets the same operations as a user on any other wrapper
at version *X* — that is the whole promise. See [docs/parity.md](./docs/parity.md).

## Layout

```
packages/wrappers/
├── README.md          # this file
├── VERSION            # the single version all three publish under
├── endpoints.json     # machine-readable surface contract (drives conformance tests)
├── docs/
│   ├── endpoints.md   # the endpoint catalog — wire shapes + per-language signatures
│   ├── cli.md         # the CLI help surface (--help), exit codes
│   ├── parity.md      # lockstep rules, conformance test, CI gate
│   └── release.md     # how a release actually runs (monorepo-driven)
├── node/              # submodule → w6w-io/w6w-node
├── cli/               # submodule → w6w-io/w6w-cli
└── python/            # submodule → w6w-io/w6w-python
```

## What a wrapper is

A thin, typed, ergonomic client over the HTTP API. It owns transport, auth,
retries, pagination, and error mapping.

It is **not** a place for business logic. If a wrapper needs to compose two calls
to make an operation useful, that composition probably belongs in the API. Keep
the wrappers boring — three of them have to stay in agreement forever, and every
clever thing you add is a thing that has to be re-implemented twice more, in
languages whose idioms disagree with yours.

## Working here

Adding or changing an operation is always the same four steps, in this order:

1. Land the endpoint in the server first — the API leads, wrappers follow.
2. Update `endpoints.json` and `docs/endpoints.md`.
3. Implement in all three wrapper repos; each opens its own PR upstream.
4. Bump `VERSION` and release all three together ([docs/release.md](./docs/release.md)).

Step 3 is not optional or deferrable. A wrapper that skips a release is a
wrapper whose users silently have a different API than everyone else's.
