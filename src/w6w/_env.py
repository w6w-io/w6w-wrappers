"""The **only** module in this package that reads the environment.

`docs/implementation.md` §2 (MECHANISM PIN — instance state, never globals) pins
exactly one environment-reading module per wrapper; everything else receives
resolved configuration as a plain value. That is not a style preference. It is
what keeps `os.environ` out of the operation modules, so no operation can
silently acquire a dependency on ambient process state, and so every env-var
behaviour has exactly **one** seam to exercise in tests (§9).

The spec names that module `w6w/_config.py`; this package splits the *reading*
(here) from the *resolving* (`_config.py`, which imports this file and is its
only caller). The invariant the pin is about — one place touches the
environment — is unchanged, and it is enforced mechanically: the repo gate greps
the whole `src/w6w` tree for `os.environ|os.getenv` and requires exactly one
matching file. The `node` wrapper made the same split for the same reason
(`src/env.ts` beside `src/config.ts`).

The mapping is **injectable** (`environ=`) so the whole precedence chain can be
tested without mutating the process environment: a module-patched global cannot
be exercised two different ways in one process, which is the same argument that
makes the credential and the transport constructor-injected.
"""

from __future__ import annotations

import os
from typing import Mapping, Optional

#: Environment variable holding the server **origin** (see `_config.py`).
ENV_BASE_URL: str = "W6W_BASE_URL"

#: Environment variable holding the bearer token.
ENV_TOKEN: str = "W6W_TOKEN"


def process_environ() -> Mapping[str, str]:
    """Return the live process environment.

    Factored out as a function so `read_env`'s default source is a named,
    assertable thing rather than a value captured at import time — and so this
    file stays the single grep-able point where `os.environ` appears.

    :returns: `os.environ` itself (not a copy — reads must see later changes).
    """
    return os.environ


def read_env(name: str, environ: Optional[Mapping[str, str]] = None) -> Optional[str]:
    """Read one environment variable, or `None` when it carries no usable value.

    **A variable that is set but empty — or whitespace-only — reads as ABSENT.**
    `W6W_BASE_URL=`, `W6W_BASE_URL="   "`, `W6W_BASE_URL=$'\\n'` and an unset
    `W6W_BASE_URL` are all the same thing here, and the precedence chain falls
    through all four to the next source (and ultimately to a `ConfigError`).

    The guard is therefore a **truthiness/strip** check and deliberately *not*
    an `is None` test. `os.environ.get` returns `""` for a set-but-empty
    variable, never `None`, so `is None` is the Python spelling of the same
    nullish-coalescing mistake that `docs/implementation.md` §2 forbids in the
    TypeScript wrappers: an empty `W6W_BASE_URL` would survive as a value and
    short-circuit the precedence chain, leaving the client on an empty base and
    issuing every request against a relative URL — exactly the browser
    same-origin default a library must not have. Do not "tidy" this into
    `if value is None`.

    An empty environment variable is not a hypothetical. `export W6W_BASE_URL=`,
    a Dockerfile `ENV W6W_BASE_URL=` with no build arg, and a CI variable whose
    template did not interpolate all produce exactly this, and it *looks* absent
    in every log line while behaving as present in every null check.

    The value is returned **verbatim**, not stripped: trimming applies to the
    emptiness *test*, not to the stored value. Normalising the shape of a base
    URL is the join rule's job (`_config.join_base_url`).

    :param name: The variable to read, e.g. :data:`ENV_BASE_URL`.
    :param environ: Mapping to read from. Defaults to the process environment;
        pass one to test the precedence chain without touching `os.environ`.
    :returns: The value, or `None` if unset, empty or whitespace-only.
    """
    source = process_environ() if environ is None else environ
    value = source.get(name)
    if value is None or not value.strip():
        return None
    return value
