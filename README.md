# w6w wrappers

Open-source client libraries that wrap the w6w HTTP API.

| Wrapper | Directory | Published as | Language |
|---------|-----------|--------------|----------|
| SDK  | [`node/`](./node)     | `@w6w/sdk` (npm + JSR) | TypeScript |
| CLI  | [`cli/`](./cli)       | `@w6w/cli` (npm), binary `w6w` | TypeScript |
| SDK  | [`python/`](./python) | `w6w` (PyPI) | Python |
| SDK bindings | react/ | `@w6w/react` (npm) | TypeScript (React) |

## Install

```bash
npm install @w6w/sdk        # or: deno add jsr:@w6w/sdk
npm install -g @w6w/cli
pip install w6w
npm install @w6w/react      # composes @w6w/sdk — a derived lane, see docs/parity.md
```

Each install is a normal, tokenless publish from this repo's own CI, over OIDC —
see [docs/release.md](./docs/release.md). Full client docs, per language, live
in [`node/README.md`](./node/README.md), [`cli/README.md`](./cli/README.md) and
[`python/README.md`](./python/README.md).

**One repo, one directory per language, one version.** The wrappers live here
together with the contract they implement (`endpoints.json`, `VERSION`, these
docs), which is what lets a surface change touch every language in a single
diff — and lets every lane's CI read the contract as a plain sibling file
instead of fetching a mirror of it.

This repo is open source and public. The private `w6w` monorepo consumes it as a
**submodule** at `packages/wrappers`, the same way it consumes `w6w-io/w6w-core`;
after a change lands here, the monorepo bumps its pointer in a dedicated
`chore(wrappers): bump submodule` commit.

> **Adding a language is adding a directory** — `go/`, `dart/` — with a lane in
> this repo's CI and a publish job on the shared release trigger. There is no
> repo to create, no CI to bootstrap, and no fourth set of publish secrets. What
> it does still cost is the obligation in [docs/parity.md](./docs/parity.md):
> every future operation gets written one more time, on the same day. That
> obligation falls on a **contract lane** — a `go/` or `dart/` implementing
> `endpoints.json` directly — not on a **derived lane** like `react/`, which
> composes an existing lane's client instead and carries no such cost.

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
w6w-wrappers/                  # ← submodule of the w6w monorepo at packages/wrappers
├── README.md          # this file
├── VERSION            # the single version every wrapper publishes under
├── endpoints.json     # machine-readable surface contract (drives conformance tests)
├── docs/
│   ├── endpoints.md      # the endpoint catalog — wire shapes + per-language signatures
│   ├── sdk-surface.md    # the client catalog — every published symbol and how it behaves
│   ├── implementation.md # the cross-language spec — types, errors, env, toolchains, tests
│   ├── cli.md            # the CLI help surface (--help), exit codes
│   ├── parity.md         # lockstep rules, conformance test, CI gate
│   └── release.md        # how a release actually runs
├── node/              # @w6w/sdk   (npm + JSR)
├── cli/               # @w6w/cli   (npm, binary `w6w`)
├── python/            # w6w        (PyPI)
└── react/             # @w6w/react (npm, derived lane — composes node/)
```

Every lane reads the contract at `../endpoints.json` and `../VERSION` — resolved
from its own test file's location, never from the working directory, so the
answer is the same in CI, in a laptop checkout, and inside the monorepo's
submodule.

`endpoints.json` says *which* operations exist and `docs/endpoints.md` says *what
the API returns*; [`docs/implementation.md`](./docs/implementation.md) pins
everything else — types, error model, environment handling, toolchains, tests and
the conformance runner — so that three people implementing in three languages
produce the same client. Where it says "pinned", it is not a starting point for
discussion.

Those three describe the **API**. [`docs/sdk-surface.md`](./docs/sdk-surface.md)
describes the **client**: every symbol a wrapper publishes, side by side in both
languages, including the ones no contract entry covers — `request`, `path`,
`joinBaseUrl`, the error classes, the run predicates, `UNSET` — plus the handful
of places the two SDKs deliberately differ in idiom while agreeing on the wire.

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
3. Implement it in **every** language directory, in the same PR.
4. Bump `VERSION` and release them together ([docs/release.md](./docs/release.md)).

Step 3 is not optional or deferrable, and the layout is what makes it hard to
skip: one diff, one CI run, every lane's conformance test reading the same
`endpoints.json` you just edited. A wrapper that sits out a release is a wrapper
whose users silently have a different API than everyone else's.
