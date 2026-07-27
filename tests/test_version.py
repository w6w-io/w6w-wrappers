"""The lockstep guard: one VERSION, three copies, mechanically compared.

The wrappers' promise is that `w6w==X` exposes the same surface as every other
wrapper at `X`. That promise starts with the version literally agreeing in
three places:

    1. `w6w.__version__`          (src/w6w/_version.py)
    2. `project.version`          (pyproject.toml)
    3. the shared VERSION file    (../VERSION, next to endpoints.json)

(3) lives outside this repo on purpose. This repo is checked out at
`<contract>/python/`, so the shared contract is its sibling — reading it here
is what makes the guard *lockstep* rather than merely self-consistent. It is
resolved from THIS FILE's location, never from the process working directory,
so the suite gives the same answer from any cwd.

If the shared file is absent the test FAILS naming the path it looked for; it
never skips. A guard that quietly passes when its input is missing is worse
than no guard, and a vendored copy of VERSION inside this repo would defeat the
mechanism entirely. A standalone clone of this repo therefore has to check the
contract out beside it — which is exactly what its release/CI job does.

Parsing uses the standard library only: `tomllib` on 3.11+, and a small
purpose-built scanner on 3.9/3.10 where `tomllib` does not exist (PEP 680
landed in 3.11) and `tomli` cannot be installed here.
"""

from __future__ import annotations

import re
import unittest
from pathlib import Path
from typing import Optional

import w6w

_REPO_ROOT = Path(__file__).resolve().parent.parent
_PYPROJECT = _REPO_ROOT / "pyproject.toml"
_SHARED_VERSION = _REPO_ROOT.parent / "VERSION"  # i.e. ../../VERSION from here

_SEMVER_RE = re.compile(r"^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.\-]+)?$")
_TABLE_RE = re.compile(r"^\[([^\]]+)\]")
_VERSION_RE = re.compile(r"""^version\s*=\s*["']([^"']+)["']""")


def _version_from_toml_text(text: str) -> Optional[str]:
    """Return `project.version` from TOML source, without `tomllib`.

    Deliberately not a TOML parser: it tracks the current table header and
    returns the first `version = "..."` inside `[project]`. That is enough for
    a manifest this repo owns and formats, and it keeps 3.9/3.10 support from
    costing a dependency. `tomllib` is preferred wherever it exists.
    """
    table = ""
    for raw in text.splitlines():
        line = raw.strip()
        table_match = _TABLE_RE.match(line)
        if table_match:
            table = table_match.group(1).strip()
            continue
        if table == "project":
            version_match = _VERSION_RE.match(line)
            if version_match:
                return version_match.group(1)
    return None


def _pyproject_version() -> Optional[str]:
    text = _PYPROJECT.read_text(encoding="utf-8")
    try:
        import tomllib
    except ModuleNotFoundError:  # Python 3.9 / 3.10
        return _version_from_toml_text(text)
    return tomllib.loads(text).get("project", {}).get("version")


class VersionLockstepTest(unittest.TestCase):
    def test_package_version_matches_pyproject(self) -> None:
        self.assertEqual(
            w6w.__version__,
            _pyproject_version(),
            "w6w.__version__ (src/w6w/_version.py) disagrees with project.version "
            f"in {_PYPROJECT}. Both are written from the shared VERSION file; "
            "neither is bumped on its own.",
        )

    def test_package_version_matches_shared_contract(self) -> None:
        if not _SHARED_VERSION.is_file():
            self.fail(
                f"the wrappers' shared VERSION file was not found at {_SHARED_VERSION}. "
                "This repo is checked out beside the shared contract (VERSION, "
                "endpoints.json); check it out there rather than vendoring a copy — a "
                "pinned copy defeats the lockstep guard.",
            )
        shared = _SHARED_VERSION.read_text(encoding="utf-8").strip()
        self.assertEqual(
            w6w.__version__,
            shared,
            f"w6w.__version__ disagrees with the shared contract at {_SHARED_VERSION}. "
            "The shared file is the source of truth: if they differ, this package is "
            "wrong. All wrappers publish at one version, together.",
        )

    def test_version_is_a_release_number(self) -> None:
        self.assertRegex(
            w6w.__version__,
            _SEMVER_RE,
            "the version must be MAJOR.MINOR.PATCH — semver applies to the shared "
            "wrapper surface, not to this language alone.",
        )

    def test_fallback_toml_scanner_agrees_with_tomllib(self) -> None:
        # Keeps the 3.9/3.10 path honest on interpreters that have `tomllib`:
        # the branch is otherwise never executed where CI actually runs.
        self.assertEqual(
            _version_from_toml_text(_PYPROJECT.read_text(encoding="utf-8")),
            _pyproject_version(),
        )


class PackagingMarkerTest(unittest.TestCase):
    def test_py_typed_marker_is_present(self) -> None:
        # PEP 561: without this file a type checker ignores every annotation in
        # the package, which would make a typed client typed for nobody.
        marker = _REPO_ROOT / "src" / "w6w" / "py.typed"
        self.assertTrue(marker.is_file(), f"missing PEP 561 marker: {marker}")

    def test_barrel_exports_the_version(self) -> None:
        self.assertIn("__version__", w6w.__all__)


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
