# w6w

Typed Python client for the w6w workflow API.

It is a thin wrapper: transport, auth, error mapping. Documents, variables,
connections, workflows and runs — the same surface the Node SDK and the `w6w`
CLI expose, at the same version. All three wrappers implement one shared
contract and release together, so `w6w==X` gives you the same operations as
`@w6w/sdk@X`.

**Status: pre-release.** The transport core is in — `W6wClient`, configuration,
the error model and one request path. The named operations (`documents.*`,
`vars.*`, `workflows.*`, `me`, `run`) land in the releases that follow. Below
`1.0.0`, breaking changes may arrive in a minor bump — that grace ends at
`1.0.0`.

MIT licensed — see [LICENSE](./LICENSE).

## Install

```bash
pip install w6w
```

Python 3.9 or newer.

## Zero runtime dependencies

`dependencies` in `pyproject.toml` is empty and stays empty. HTTP goes through
`urllib.request` from the standard library — no `requests`, no `httpx`, no
`aiohttp`.

Two reasons, in order of importance:

1. **A client library should never join a dependency fight.** Installing this
   package cannot conflict with the versions you have already pinned.
2. **It is the only honest choice for how this package is developed.** The
   environment it is built in has no package installer available at all, so a
   third-party HTTP or test dependency would make the package untestable by the
   people writing it.

The package is fully annotated and ships a [PEP 561](https://peps.python.org/pep-0561/)
`py.typed` marker, so mypy and pyright see the types without a stub package.

## Usage

```python
from w6w import W6wClient, ApiError

client = W6wClient()                      # from the environment
# …or explicitly, which always wins over the environment:
client = W6wClient(base_url="https://api.example.com", token="tok_…")

try:
    status, body = client.request("GET", "/me")
except ApiError as err:
    print(err.status, err.code, err.message)
```

`client.request` returns `(status, body)` — the status comes back because a
`202` is a normal outcome on this API (a queued workflow run), not an error.
Named operations arrive in the next releases; `request` stays public so you can
reach an endpoint this version does not model yet.

When any part of a path comes from the caller, build it with `w6w.path` rather
than by concatenation — it percent-encodes every interpolated value:

```python
from w6w import path

client.request("GET", path("/documents/by-key/{key}", key="notes/2026"))
# -> GET https://api.example.com/api/documents/by-key/notes%2F2026
```

That is not defensive ceremony. Document keys are user-chosen and the server
accepts almost anything, so an unencoded `"notes/2026"` becomes two path
segments — a **different route**, answered with a `200` and no error anywhere.

## Configuration

Two environment variables, read once when a client is constructed:

| Variable | Meaning |
|---|---|
| `W6W_BASE_URL` | The **origin** of your w6w API — e.g. `https://api.example.com`. The client appends the `/api` base path itself; you never type it. There is no default. |
| `W6W_TOKEN` | Your API token. Sent as `Authorization: Bearer <token>` on every request. |

These variables are part of the published contract and are identical across all
three wrappers.

**Explicit constructor arguments always win over the environment.**
`W6wClient(base_url=…, token=…)` overrides `W6W_BASE_URL` / `W6W_TOKEN`, and an
argument you pass explicitly — including an empty string — is never quietly
replaced by an environment variable behind your back.

Credentials are per-client **instance state**, never module globals: two clients
in one process can point at two servers with two tokens and not interfere.

### `W6W_BASE_URL` is an origin

The `/api` base path is appended for you, and never doubled:

| You set | The client uses |
|---|---|
| `https://api.example.com` | `https://api.example.com/api` |
| `https://api.example.com/` | `https://api.example.com/api` |
| `https://api.example.com///` | `https://api.example.com/api` |
| `https://api.example.com/api` | `https://api.example.com/api` |
| `https://api.example.com/api/` | `https://api.example.com/api` |

**A blank value is not a base URL.** An environment variable that is set but
empty or whitespace-only is treated as **absent**: `W6W_BASE_URL=`,
`W6W_BASE_URL="   "` and an unset `W6W_BASE_URL` all behave identically and all
raise the same `ConfigError` naming the variable. (`export W6W_BASE_URL=`, a
Dockerfile `ENV` with no build arg, and a CI variable whose template did not
interpolate are the common cases, and they look unset in every log line.) The
same rule applies to `W6W_TOKEN`.

**It must be absolute.** `W6W_BASE_URL=/foo` or `W6W_BASE_URL=api.example.com`
raises a `ConfigError` naming the variable, at construction — not a confusing
"the server may be down" on the first request. Scheme and host, `http` or
`https`.

A client with no token can still be **constructed** — the error surfaces on the
first request instead, so offline `--help`-style uses work. A client with no
base URL raises immediately, at construction.

**A token is validated as a header value.** A token containing a carriage
return, newline or other control character raises a `ConfigError` before any
request is made, because CR/LF in a header value is header injection — and the
usual way this happens is entirely innocent: `W6W_TOKEN=$(cat token.txt)` keeps
the file's trailing newline. The message names the offending codepoint and
position and never echoes the token.

## Errors

Two exception types, and the split is deliberate:

| Type | Means |
|---|---|
| `ConfigError` | The client was never in a position to make a request — no base URL, or no token. No HTTP exchange happened. |
| `ApiError` | The server answered, or could not be reached. Carries `status`, `code`, `message` and `raw` (the parsed body, kept because error bodies carry fields the message drops). |

`ApiError` has exactly three shapes: `status=0` / `code="network_error"` for a
transport failure, `code="bad_response"` for a non-JSON body on a failing status
(a proxy's HTML error page), and the server's own `code` / `message` for an error
envelope. Classify by `status` and by a code *prefix* (`unknown_*` → 404,
`invalid_*` → 400, `*_exists` → 409) rather than by an exhaustive list of codes:
the server mints codes freely.

A `424` is an app or upstream **execute-phase** failure, not a transport fault
and not a server error — it is a 4xx on purpose. It reaches you with its code and
body intact.

## Tests

The suite runs from a source checkout with **no installation step and no test
runner to install** — `unittest` from the standard library:

```bash
PYTHONPATH=src python3 -m unittest discover -s tests -t . -v
```

Run it from the repository root. A single file:

```bash
PYTHONPATH=src python3 -m unittest tests.test_version -v
```

No test reaches the network. Client behaviour is exercised against an injected
transport seam, never a live server — conformance against a running server is a
separate, environment-dependent step and is not part of this suite.

### Why coverage is measured in CI and not locally

Coverage is gated at **90 %**, enforced by CI, and there is deliberately no
local coverage command.

`coverage` is the one development-only tool this repo uses, and it is a
third-party package. The environment this wrapper is developed in has **no
package installer available** (`python3 -m pip` and `python3 -m ensurepip` both
fail there), so `coverage` cannot be installed alongside the code it would
measure. Rather than publish a local gate that nobody can actually run, the
number is enforced where the tool does exist:

```bash
pip install -e '.[dev]'
coverage run -m unittest discover -s tests -t .
coverage report          # fail_under = 90, configured in pyproject.toml
```

The local bar is different and, for the thing that actually matters, stricter:
**the suite runs with no install, every operation is exercised, and every error
path has a test.** A percentage catches a whole operation going untested; it
does not catch an operation tested badly. If you are adding an operation, the
list above is your gate, not the number.

## Versioning

The version appears in three places — `src/w6w/_version.py`, `pyproject.toml`,
and the wrappers' shared `VERSION` contract that sits beside this repository —
and `tests/test_version.py` fails if any of them disagree. All three are
written from the shared file at release time; none is ever bumped on its own.
That is the mechanism behind "one surface, one version, released together".

## Contributing

Conventions worth knowing before the first patch:

- **`src/` layout.** Tests import the package via `PYTHONPATH=src` (or an
  install), never the working directory, so what is tested is what ships.
- **The barrel rule.** Every public symbol is re-exported from `w6w/__init__.py`
  and listed in `__all__`. Modules with a leading underscore are private
  implementation detail and may move.
- **Type annotations use `typing.Optional` / `Dict` / `List` form**, so they
  stay valid on Python 3.9 even where they are evaluated at runtime; every
  module also starts with `from __future__ import annotations`.
- **Exactly one module reads the environment** — `src/w6w/_env.py`. `os.environ`
  and `os.getenv` appear there and nowhere else; every other module receives
  resolved configuration as a value, so no operation can acquire a hidden
  dependency on ambient process state.
- **Every caller-supplied value in a URL goes through `w6w.path`.** One
  primitive at the transport seam, never a `quote()` at each call site — "every
  call site remembered to encode" is not a property anyone can verify later.
- **Stdlib only, in tests too.** No file in this repository imports a
  third-party module. The transport is constructor-injected, so no test opens a
  socket.
- **The surface is not decided here.** Which operations exist, and what each is
  called in each language, is pinned by the shared wrapper contract. Adding an
  operation to this client alone would break the promise the three wrappers
  make together.
