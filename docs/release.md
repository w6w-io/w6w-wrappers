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
   - npm: `@w6w/sdk` and `@w6w/cli` already exist (published `0.1.1` from the
     archived per-language repos) — on npmjs.com, open each package → Settings →
     Trusted Publisher → add a GitHub Actions publisher for
     `w6w-io/w6w-wrappers`, workflow `release.yml`. Not "pending"; the project
     already exists, this just adds OIDC as a second way to publish it.
   - JSR: the `@w6w` scope already exists (`@w6w/types` is on it). `@w6w/sdk`
     is created and linked to `w6w-io/w6w-wrappers`; `@w6w/cli` still needs
     the same — create the package under the scope on jsr.io and link it to
     the repo (Settings → GitHub Actions on the package). Unlinked, `npx jsr
     publish` has no OIDC binding to use.
   - PyPI: `w6w` — as a **pending publisher**, since the project does not exist
     yet. The first upload creates it.
2. **Create the `pypi` GitHub environment** (Settings → Environments) on
   `w6w-io/w6w-wrappers`, named to match the PyPI registration exactly. npm and
   JSR bind on repo + workflow only, no environment involved.
3. Nothing else. There is no repo to create, no token to mint, no secret to
   store.

The registration is the **one-way step**: it hard-binds to whichever repo
publishes. It has not happened yet, which is fortunate timing — registering it
against the now-archived `w6w-io/w6w-node` and `w6w-io/w6w-cli` would have had
to be undone by hand.

### The PyPI name is not reserved until the first upload

There is no reserve-first option, and a pending publisher is not one.
[PyPI's own docs](https://docs.pypi.org/trusted-publishers/creating-a-project-through-oidc/):
a pending publisher *"does **not** create a project or reserve a project's name
**until** it is actually used to publish"*, and if someone else registers the
name first, the pending publisher is **invalidated**. PyPI has no scopes — `w6w`
is a flat global name, unlike the `@w6w` npm and JSR scopes, so it is
first-come.

**Do not wait on the organization to publish it.** A `w6w` **Company**
organization was requested on 2026-07-27 and is pending; PyPI states it *"is
unable to specify a timeline"* for approval and reviews requests
*"periodically"*. The org name and the project name are separate things —
approving the org neither grants nor holds `w6w` as a project.

The sequence that does not depend on that queue: publish `w6w` from an
individual account (claiming the name), then, once the organization is
approved, use *Your organizations → Manage → Projects → Transfer existing
project*, which exists precisely for *"pre-existing projects associated with
[an] individual user account"*. **Re-check the trusted publisher after the
transfer** — it is bound to a GitHub repo and workflow rather than to the PyPI
owner, so it ought to survive a change of ownership, but that is worth
confirming on the project page before the next release rather than discovering
at upload time.

> `@w6w/sdk@0.1.1` and `@w6w/cli@0.1.1` were already on npm, published before
> this workflow existed. `@w6w/sdk@0.2.0` was since published manually (a
> stopgap while the trusted publisher was being registered) — which is why
> this release is `0.2.1`, not `0.2.0`: the first version is already taken on
> npm and re-publishing it would be rejected. `0.2.1` is the first version
> this workflow itself publishes, and the first that will carry a
> `repository.directory` pointing into this repo, on every registry.

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
4. **Tag** `v0.2.1`. (For a dry run, invoke `release.yml` via
   `workflow_dispatch` with an explicit `version` input — it verifies and runs
   conformance without publishing.)
5. **`verify`** reads `VERSION` and compares it against the tag and all eight
   version literals — three manifests and a source constant per TypeScript lane,
   `pyproject.toml` and `_version.py` for python — echoing every value *before*
   deciding, so a failing log already answers "which one disagreed". Fails with
   `::error::` naming it. This mirrors `publish-types.yml:33-48` in the core repo.
6. **`test`** (`needs: verify`) runs every lane's suite: `unittest` for python,
   `deno task test` for `node` and `cli`. **The conformance runners live inside
   those suites** — `python/tests/test_surface.py`, `cli/tests/help_test.ts`, and
   each lane's version guard — and they read `endpoints.json` and `VERSION` from
   the same checkout as siblings. So the lockstep bet is enforced here: *an
   operation added to two wrappers and forgotten in a third fails this job, and
   nothing is uploaded.* It is not a separate job because it is not separate
   work; a standalone `conformance` job would re-run the same assertions.
7. **`publish`** (`needs: [verify, test]`) builds and uploads over OIDC, with
   `permissions: {id-token: write}` — the `id-token` is what replaces every
   token. The PyPI job additionally declares `environment: pypi`, which **must**
   match the environment named in the publisher registration: it travels in the
   OIDC claim and a mismatch is rejected at upload.
8. **Confirm every artifact landed**, then bump the monorepo's submodule pointer
   in a `chore(wrappers): bump submodule` commit.

Build before uploading. npm, JSR and PyPI releases cannot be unpublished in any
way that helps — a version that exists on npm but failed to build for PyPI is a
permanent inconsistency, and the only fix is burning a version number.

## Notes on the npm and JSR lanes

Five jobs (`npm-sdk`, `npm-cli`, `npm-react`, `jsr-sdk`, `jsr-cli`), and the
shape is copied from the house pattern — `w6w-core`'s `publish-types.yml`
ships `@w6w/types` to npm and JSR over OIDC with no stored credential. What
was *not* copyable is written out here, because each item is a thing that
would otherwise be discovered at upload time:

- **This repo is public** (verified live: `gh repo view w6w-io/w6w-wrappers` →
  `PUBLIC`), so
  [GitHub's retirement of provenance for private source repositories](https://github.blog/changelog/2023-07-26-publishing-with-npm-provenance-from-private-source-repositories-is-no-longer-supported/)
  no longer applies here — `npm publish --provenance` is available, and modern
  npm emits provenance **automatically** under trusted publishing without the
  flag. The npm jobs stay off it anyway: this is a **deliberate, tracked
  deferral**, not a technical blocker — see `FOLLOWUPS.md` (G-8). Turning it on
  touches the already-working `npm-sdk`/`npm-cli` jobs and is a separate
  decision from adding a new lane.
- **`@w6w/cli` and `@w6w/react` both publish *after* `@w6w/sdk`** —
  `needs: [verify, test, npm-sdk]`, not just the shared gate — because each
  declares a real npm dependency on it, and its `npm install` step needs that
  version already live on the registry. Otherwise there is a window in which
  that install resolves to nothing. (The `test` job's own react step hits the
  same gap earlier and for a different reason — see the note below.)
- **All three npm jobs use `npm install`, not `npm ci`.** There is no committed
  `package-lock.json` for any of the three lanes — dev and CI both run on the
  Deno tasks in `deno.json` for `node`/`cli` (react has no `deno.json`; its own
  local gate is `npm test`), and the npm manifests exist only to build and
  publish. `dist/` is produced by `tsc -p tsconfig.build.json`/`tsconfig.json`
  (the CLI additionally runs `scripts/fix-shebang.mjs`), and the CLI's and
  react's sources both import the bare specifier `@w6w/sdk`, which resolves
  from `node_modules` — not through the Deno import map, which points at
  `../node/mod.ts` and is a *development* convenience.
- **The `test` job builds `node/` and substitutes it into `react/`'s
  `node_modules` before running react's own suite** (`npm install --no-save
  ../node`, after a plain `npm install`) — react imports `@w6w/sdk/console`, a
  subpath no published `@w6w/sdk` carried until after this lane was added, so
  a bare registry install would fail the very first CI run. This step stays
  even once a console-bearing `@w6w/sdk` is on the registry: every other lane
  already tests against the sibling checkout rather than the last release, and
  a test job that silently measures a stale published package is the failure
  this repo's one-repo layout exists to prevent. The `npm-react` publish job
  does **not** do this substitution — it installs from the registry like every
  other publish job, which is correct there: a publish job must build against
  exactly what consumers will resolve, and by the time it runs `npm-sdk` has
  already uploaded.
- **JSR needs the `@w6w` scope to exist and each package linked to this repo**
  before OIDC publishing works; confirmed with `deno publish --dry-run` for
  the `node`/`cli` lanes, including the CLI's cross-package `@w6w/sdk` import.
  The publish step itself is `npx --yes jsr publish` from the lane directory,
  no build. There is no `jsr-react` job — react is a JSX+`react`-peer package,
  not the `.ts`-source-verbatim shape JSR publishing here assumes.
- **The trusted publishers for all five artifacts register against
  `w6w-io/w6w-wrappers` + `release.yml`**, exactly as PyPI's does. Registering
  them against the archived `w6w-node` / `w6w-cli` repos would have to be
  undone. **`@w6w/react` needs one extra, one-time step first**: unlike PyPI's
  pending-publisher flow, npm's trusted-publisher registration requires the
  package to already exist on the registry — the same situation
  `@w6w/sdk@0.1.1`/`@w6w/cli@0.1.1` were already in, above ("published before
  this workflow existed"). A human publishes `@w6w/react`'s first version
  manually from an authenticated local shell, then registers the trusted
  publisher exactly as for the other two npm packages; every release after
  that goes out from CI, tokenless, like its siblings.

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

For a release candidate, use `VERSION` values like `0.2.1-rc.1` — valid for npm
(dist-tag `next`) and for PyPI after normalization to `0.2.1rc1`, which the
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
