# Releasing the wrappers

All three publish together, from the monorepo. The wrapper repos contain **no**
release workflows — they only run their own tests and the conformance check.

## Why the monorepo drives it

A simultaneous release needs one actor that can see all three repos at once.
If each wrapper published itself on its own tag, "simultaneous" would be an
aspiration enforced by human diligence, and the first hotfix at 2am would break
it. Here it is a single job that either publishes all three or fails.

The tradeoff: publishing credentials (npm, PyPI) live as monorepo secrets, and
the release job needs write access to the submodules. That is the price of the
guarantee — accept it deliberately rather than discovering it later.

## The flow

1. Land the wrapper changes in each wrapper repo, upstream (`w6w-io`), on `main`.
2. In the monorepo, bump [`../VERSION`](../VERSION) and move each submodule
   pointer to the commit being released.
3. Commit the pointer bumps (`chore(wrappers): bump to 0.2.0`) and tag
   `wrappers-v0.2.0`.
4. The tag triggers `.github/workflows/wrappers-release.yml`, which:
   - checks out the monorepo **with submodules**;
   - verifies every submodule's HEAD is on its repo's `main` — a release must
     never ship a detached commit that exists only here;
   - runs the conformance test in all three against `endpoints.json`, and aborts
     the whole release if any fails;
   - writes `VERSION` into `node/package.json`, `cli/package.json`, and
     `python/pyproject.toml`;
   - builds all three, **then** publishes: `npm publish` × 2 and `twine upload`.

Build everything before publishing anything. npm and PyPI releases cannot be
unpublished in any way that helps — a version that exists on npm but failed to
build for PyPI is a permanent inconsistency, and the only fix is burning a
version number.

## Partial-failure reality

The publish step is not atomic. Three registries, three network calls; the
second can fail after the first succeeded. When it does:

- **Do not retry the whole job** — the succeeded publishes will fail as
  duplicates and mask the real error.
- **Do not reuse the version.** Bump `VERSION` to the next patch and release
  again, so the set is consistent at the new number. The half-published version
  is abandoned, not repaired.

Since this leaves an orphan version on one registry, the release notes should
say which version was skipped and why. Users comparing versions across languages
will notice the gap and should not have to guess.

## Prerelease

For a release candidate, use `VERSION` values like `0.2.0-rc.1`, which are valid
for both npm (dist-tag `next`) and PyPI (`0.2.0rc1` after normalization — the
workflow does that conversion when writing `pyproject.toml`). The lockstep rule
applies to prereleases exactly as it does to finals.

## Required secrets

In the monorepo, not the wrapper repos:

| Secret | Used for |
|--------|----------|
| `NPM_TOKEN` | publishing `@w6w/sdk` and `@w6w/cli` |
| `PYPI_TOKEN` | publishing `w6w` |
| `SUBMODULE_TOKEN` | checking out the wrapper repos (or a deploy key per repo) |

Prefer PyPI **trusted publishing** (OIDC) over a long-lived `PYPI_TOKEN` if the
monorepo's CI supports it — one less credential that can leak from a repo that
also holds deploy config.
