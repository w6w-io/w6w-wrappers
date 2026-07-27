# w6w

Typed Python client for the w6w workflow API.

It is a thin wrapper: transport, auth, error mapping. Documents, variables,
connections, workflows and runs — the same surface the Node SDK and the `w6w`
CLI expose, at the same version. All three wrappers implement one shared
contract and release together, so `w6w==X` gives you the same operations as
`@w6w/sdk@X`.

**Status: pre-release skeleton.** This version establishes the package, its
toolchain and its test command; the client and its operations land in the
releases that follow. Below `1.0.0`, breaking changes may arrive in a minor
bump — that grace ends at `1.0.0`.

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

## Configuration

Two environment variables, read once when a client is constructed:

| Variable | Meaning |
|---|---|
| `W6W_BASE_URL` | The **origin** of your w6w API — e.g. `https://api.example.com`. The client appends the `/api` base path itself; you never type it. There is no default. |
| `W6W_TOKEN` | Your API token. Sent as `Authorization: Bearer <token>` on every request. |

Explicit constructor arguments always win over the environment. Credentials are
per-client instance state, never module globals: two clients in one process can
point at two servers with two tokens and not interfere.

> These variables are named here because they are part of the published
> contract and are identical across all three wrappers. The client class that
> reads them arrives in the next release of this package.

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
- **Stdlib only, in tests too.** No file in this repository imports a
  third-party module.
- **The surface is not decided here.** Which operations exist, and what each is
  called in each language, is pinned by the shared wrapper contract. Adding an
  operation to this client alone would break the promise the three wrappers
  make together.
