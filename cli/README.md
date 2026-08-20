# @w6w/cli

The `w6w` command-line client for the [w6w](https://w6w.dev) workflow platform.

It is a **thin** client, built on [`@w6w/sdk`](https://www.npmjs.com/package/@w6w/sdk): transport,
auth, output formatting and exit codes. No business logic, no client-side polling, no hidden
retries. Everything it can do, the HTTP API can do — the CLI just makes it typeable.

- **License:** MIT (see [LICENSE](./LICENSE)).
- **Version:** `0.1.1`.

## Install

```bash
npm install -g @w6w/cli
w6w --help
```

`@w6w/cli`, `@w6w/sdk` and the Python `w6w` package share one version number and are released
together. A given version means the same set of operations in every language.

## Configuration

Two environment variables:

| Variable       | Meaning                                                                                                                                                                                         | Required |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| `W6W_BASE_URL` | The **origin** of your w6w server, e.g. `https://api.example.com`. The API is served at the root of that host, so nothing is appended — and a stale `/api` suffix from `0.1.x` must be dropped. | Yes      |
| `W6W_TOKEN`    | Your API token, sent as `Authorization: Bearer <token>` on every request.                                                                                                                       | Yes      |

Both have a flag equivalent, and **a flag always wins over the environment**: `--base-url <url>` and
`--token <token>`.

```bash
export W6W_BASE_URL=https://api.example.com
export W6W_TOKEN=…
w6w workflows list
```

`--help` and `--version` deliberately need neither. They resolve with no token configured and no
server reachable, which is exactly when people need them most.

## Usage

```bash
w6w me                        # who am I, and which component versions am I talking to?

# Discover what you can run — a `conn_…`, `wf_…`, `fn_…` or `ep_…` id.
w6w connections list
w6w workflows list

# Run a connection action: a `conn_…` id needs --action.
w6w run conn_01H… --action send_email --payload '{"to":"a@b.com"}'

# A function or an endpoint runs the same way, with no --action.
w6w run fn_normalize_address --payload '{"address":"1 Infinite Loop"}'

# `w6w run wf_…` dispatches a workflow like anything else and always queues it.
# `w6w workflows run` is the typed path, and the only one that can wait:
w6w workflows run wf_01H… --wait

# Documents and vars are plain CRUD; the key/name is positional, the rest are flags.
w6w documents create welcome --content "# Hi"
w6w vars create greeting --type string --value hello
```

Add `--json` to any command for raw JSON instead of a table — the shape to script against.

## Help

Help resolves at three levels, and `-h` is an alias for `--help` at all of them:

```bash
w6w --help                   # what w6w is, the global flags, the command groups
w6w documents --help         # the commands in a group
w6w documents create --help  # arguments, flags, examples
w6w help documents create    # the same thing, spelled the other way
```

Help is **generated** from the machine-readable surface contract all three w6w wrappers implement,
so the CLI cannot document an operation it does not have, or omit one it does. A bare `w6w` prints
the root help and exits `0`.

## Exit codes

| Code | Meaning                                                                  |
| ---- | ------------------------------------------------------------------------ |
| `0`  | Success — including help, and including a _queued_ or _running_ workflow |
| `1`  | Usage error — unknown command, missing argument, bad flag                |
| `2`  | API error — 4xx/5xx from the server, including auth failure              |
| `3`  | Run failure — `--wait` returned a run with status `failed`               |

Code `3` exists so `w6w workflows run --wait` is usable in CI without parsing stdout. Keeping it
distinct from `2` matters: a failed workflow and an unreachable API demand opposite responses, and a
script that cannot tell them apart will retry the wrong one.

## The surface

What commands exist is not decided in this repo. It is defined by the shared machine-readable
contract `endpoints.json`, which sits beside this repo alongside its two sibling wrapper repos and
which each wrapper's conformance test reads directly — the same file, never a vendored copy. A
command missing from a wrapper is a failing test, not a preference.

Some operations are marked `planned` in that contract: they are implemented and unit-tested here,
but the corresponding server route is not live yet, so calling them against a server today returns
`404`. Their help says so. The marker records **server** readiness, not CLI completeness.

## Versioning

The version is a shared fact across all three wrappers, so a release may go out for this package
even when nothing in it changed — a divergent version is far more expensive than an empty release.

Below `1.0.0`, **breaking changes may land in a minor bump.** That grace ends at `1.0.0`; do not
plan around it.

## Development

The gates are Deno tasks. They need no network and no server:

```bash
deno task gen:help   # regenerate src/help.generated.ts from the shared contract
deno task check      # typecheck mod.ts, bin/, scripts/, src/ and tests/
deno task lint
deno task fmt:check
deno task test       # every test runs in-process, against no server
deno task cov        # test with coverage, then report it
```

`src/help.generated.ts` is generated — never edit it by hand. `deno task test` compares it
byte-for-byte against a fresh render, so a contract change that was not regenerated fails the suite
instead of shipping stale help.

Runtime access — argv, environment, exit — lives in exactly one module, `src/runtime.ts`. Everything
else uses Web-standard globals only, which is what lets the same source run under Deno during
development and under Node once published. The npm `dist/` build (`npm run build`, i.e.
`tsc -p tsconfig.build.json`) runs in CI only.
