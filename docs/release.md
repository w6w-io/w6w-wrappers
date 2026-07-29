# Releasing the wrappers

Every wrapper publishes together, at one version, from one workflow in this
repo. One actor decides, gates and uploads; **no publishing credential exists
anywhere**, because every upload is trusted publishing over OIDC minted inside
this repo.

> **This replaces a three-repo dispatch architecture** that existed only because
> the wrappers used to be three separate repos with the contract in a private
> monorepo. That layout is gone ([parity.md](./parity.md)), and with it went a
> cross-repo `repository_dispatch`, a fourth "contract mirror" repo, and the one
> long-lived token in the design. HITL-7 — *who publishes: the monorepo, each
> wrapper repo, or a hybrid?* — is **closed, by not applying**: there is one repo,
> it publishes itself, and the cross-wrapper gate lives in the same run.

## The shape

| Owner | Does | Does not |
|---|---|---|
| **this repo** (`w6w-io/w6w-wrappers`) | owns [`../VERSION`](../VERSION); verifies every manifest agrees with it; runs conformance across every lane; tags; builds and publishes all five artifacts over OIDC | hold any registry credential |
| **the monorepo** (`segevsh/w6w`) | consumes this repo as a submodule at `packages/wrappers` and bumps its pointer after a release | decide, gate, or trigger a release |

One workflow file, `.github/workflows/release.yml`, does the whole thing. It
triggers on a `v*` tag and on `workflow_dispatch` (for a dry run), never on a
bare `push`.

## Why this is the simple version

Two problems forced the old design, and the layout dissolved both:

**1. Trusted publishing binds to a repo *and* a workflow filename.** The
registration instructions are spelled out in
`packages/core/.github/workflows/publish-types.yml:7-12`: *add a GitHub Actions
publisher: org/repo, workflow filename*. When the wrappers lived in three repos,
a single publishing job was impossible without stored registry tokens — a job in
one repo cannot mint a credential registered to another. Now all five artifacts
are built in **one** repo, so all five publishers register against
`w6w-io/w6w-wrappers` + `release.yml`, and the keyless posture the rest of this
workspace already uses (`publish-types.yml` for npm and JSR,
`server-deploy.yml:72-77` for GCP via Workload Identity Federation) applies here
without an exception.

**2. Standalone conformance could not read the contract.** A public wrapper
repo's CI could not read `endpoints.json` out of a private monorepo, which is
why a public mirror repo was going to exist. The contract is now a sibling file
in this repo — see [parity.md §Where the contract comes from in
CI](./parity.md#where-the-contract-comes-from-in-ci), which is the authority on
that and records why the mirror must not come back.

Lockstep needed one actor that *decides*. It turns out one repo that decides
**and** uploads is available for free once the lanes stop being scattered.

## Before any of this can run

Outward-facing, one-time, and human:

1. **Register a trusted publisher for each artifact**, against `w6w-io/w6w-wrappers`
   and workflow `release.yml`:
   - npm: `@w6w/sdk`, `@w6w/cli`
   - JSR: `@w6w/sdk`, `@w6w/cli`
   - PyPI: `w6w` (the name is unclaimed — claim it with the first upload, or
     reserve it first)
2. Nothing else. There is no repo to create, no token to mint, no secret to
   store.

The registration is the **one-way step**: it hard-binds to whichever repo
publishes. It has not happened yet, which is fortunate timing — registering it
against the now-archived `w6w-io/w6w-node` and `w6w-io/w6w-cli` would have had
to be undone by hand.

> `@w6w/sdk@0.1.1` and `@w6w/cli@0.1.1` are already on npm, published before
> this workflow existed. `0.2.0` is the first release this document describes,
> and the first that will carry a `repository.directory` pointing into this
> repo.

## The flow

Steps 1–4 are human or ordinary-merge work. Steps 5–8 are machine. Step 9 is
human again, and is not optional.

1. **Land the change** — every lane, in one PR against this repo's `main`. CI
   has already run every lane's unit suite and conformance test against the
   contract in the same checkout.
2. **Bump `VERSION`.** It is the single source of truth and the only place a
   human types the new number.
3. **Write that number into every manifest**, in the same commit:
   `node/deno.json` + `node/package.json` + `node/src/version.ts`,
   `cli/deno.json` + `cli/package.json` + `cli/src/version.ts`,
   `python/pyproject.toml` + `python/src/w6w/_version.py`. Never hand-pick a
   different value in a manifest; step 5 is a gate, not a writer.
4. **Tag** `v0.2.0`. (For a dry run, invoke `release.yml` via
   `workflow_dispatch` with an explicit `version` input — it verifies and runs
   conformance without publishing.)
5. **`verify`** reads `VERSION` and compares it against the tag and every
   manifest, echoing each value before deciding and failing with `::error::`
   naming the manifest that disagreed. This mirrors `publish-types.yml:33-48`.
6. **`conformance`** (`needs: verify`) runs every lane's conformance test
   against this repo's own [`../endpoints.json`](../endpoints.json). If any lane
   is missing an operation — or has grown one the contract does not have — the
   release stops here and nothing is uploaded. This is the whole lockstep bet:
   *an operation added to two wrappers and forgotten in a third must block the
   release, not ship.*
7. **`test`** (`needs: verify`) runs all three suites: `deno test` for `node`
   and `cli`, `unittest` for `python`, plus the coverage gate.
8. **`publish`** (`needs: [verify, conformance, test]`) builds and uploads all
   five artifacts over OIDC: `@w6w/sdk` → npm + JSR, `@w6w/cli` → npm + JSR,
   `w6w` → PyPI. `permissions: {contents: read, id-token: write}`; the
   `id-token` is what replaces every token.
9. **Confirm all five landed**, then bump the monorepo's submodule pointer in a
   `chore(wrappers): bump submodule` commit.

Build before uploading. npm, JSR and PyPI releases cannot be unpublished in any
way that helps — a version that exists on npm but failed to build for PyPI is a
permanent inconsistency, and the only fix is burning a version number.

## Partial-failure reality

The gate is atomic. **The upload is not, and no design makes it so** — five
registry uploads are five ways to fail, and registries have no cross-registry
transaction to enlist in.

- **Nothing uploads unless `verify`, `conformance` and `test` all pass.** A
  version mismatch, a missing operation or a failing suite can never half-ship.
  The dangerous window is only *inside* step 8.
- **A transient registry error is re-runnable at the same version.** Re-run the
  workflow; the jobs that already succeeded will fail as duplicates, so prefer
  re-running the single failed job where the runner allows it.
- **A genuinely half-published version has to be burned.** If npm accepted
  `@w6w/sdk` and JSR rejected it, that number is spent — registries refuse to
  overwrite. Bump `VERSION` to the next patch and release the whole set again,
  so the set is consistent at the new number. The half-published version is
  abandoned, not repaired.
- **Say which version was skipped.** An orphan version on one registry is
  visible to anyone comparing versions across languages. Put the skipped number
  and the reason in the release notes rather than making them guess.

The operator's rule of thumb: *if one upload was rejected, re-run it. If one
package half-landed across its two registries, burn the version.*

## Prerelease

For a release candidate, use `VERSION` values like `0.2.0-rc.1` — valid for npm
(dist-tag `next`) and for PyPI after normalization to `0.2.0rc1`, which the
publish job performs when it writes `pyproject.toml`. The lockstep rule applies
to prereleases exactly as it does to finals.

## Required secrets

**None.**

Not a stored npm token, not a PyPI token, not a `twine` password, not a
cross-repo dispatch PAT. Every upload is trusted publishing over OIDC, the same
mechanism `packages/core/.github/workflows/publish-types.yml` already uses to
ship `@w6w/types` to npm and JSR.

The `WRAPPER_DISPATCH_TOKEN` the previous architecture needed — a fine-grained
PAT with write access to four repos, whose only job was firing a
`repository_dispatch` and pushing to a contract mirror — **does not exist and
must not be reintroduced.** It was a consequence of the split, and the split is
gone.

`SIBLING_REPO_PAT` (`.github/workflows/server-deploy.yml:11-14` in the monorepo)
is unrelated: the server image is assembled from several *private* repos. This
repo is public and self-contained.
