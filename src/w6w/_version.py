"""The package version — one of the three copies the lockstep bet keeps equal.

The other two are `version` in `pyproject.toml` and the wrappers' shared
`VERSION` file. All three are written from that shared file at release time and
are never bumped independently; `tests/test_version.py` fails the build if they
disagree.

Kept in its own module (rather than read from installed package metadata) so
that `w6w.__version__` works from a source checkout with no install step, which
is exactly how this package is developed and tested.
"""

from __future__ import annotations

__version__: str = "0.1.1"
