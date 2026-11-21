# Releasing the wrappers

Every wrapper publishes together, at one version, from one workflow in this
repo. One actor decides, gates and uploads; **no publishing credential exists
anywhere**, because every upload is trusted publishing over OIDC minted inside
this repo.

> **This replaces a three-repo dispatch architecture** that existed only because
> the wrappers used to be three separate repos with the contract in a private
> monorepo. That layout is gone ([parity.md](./parity.md)), and with it went a
> cross-repo `repository_dispatch`, a fourth "contract mirror" repo, and the one
> long-lived token in the design. HITL-7 — _who publishes: the monorepo, each
> wrapper repo, or a hybrid?_ — is **closed, by not applying**: there is one
> repo, it publishes itself, and the cross-wrapper gate lives in the same run.

## The shape

| Owner                                 | Does                                                                                                                                                                 | Does not                           |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| **this repo** (`w6w-io/w6w-wrappers`) | owns [`../VERSION`](../VERSION); verifies every manifest agrees with it; runs conformance across every lane; builds and publishes all four artifacts over OIDC | hold any registry credential       |
| **the monorepo** (`segevsh/w6w`)      | consumes this repo as a submodule at `packages/wrappers` and bumps its pointer after a release                                                                       | decide, gate, or trigger a release |

One workflow file, `.github/workflows/release.yml`, does the whole thing. It
is **continuous delivery**: it triggers on every push to `main` that changes
`VERSION`, and publishes each package whose registry does not have that version
yet. **Merging a version bump is the release** — there is no tag or GitHub
Release to cut. `workflow_dispatch` runs the gates only (a dry run). Re-running a
release run is safe: the `verify` job asks each registry first and skips what is
already there.

**PR CI.** A second workflow, `.github/workflows/ci.yml`, runs on every pull
request and every push to `main`: one job, `verify`, that runs
[`scripts/verify.sh`](../scripts/verify.sh) — the lockstep version check
([`scripts/check-lockstep.py`](../scripts/check-lockstep.py)) plus the `python`,
`node`, `cli` and `react` lane gates (and `npm pack --dry-run`). The pre-push hook runs the same file, so a check is added there,
never only to `ci.yml`. It holds `contents: read` only — no secret, no
`id-token`, no publish step — so it is safe on forks. Publishing stays in
`release.yml`.

Before 2026-11-21 publishing needed a hand-cut GitHub Release, so the source
version could fall behind the registries: `0.9.8` was on `main` while all
registries were still at `0.6.0`. Publishing on merge closes that gap.
The `v0.6.0` run's red status was an obsolete `jsr-cli` job; its npm, JSR SDK,
and PyPI uploads all succeeded. That CLI job has since been removed.

### Release commands

There is nothing to run: merge the version-bump PR into `w6w-io/w6w-wrappers`'s
`main`. To watch it and confirm what landed:

```sh
gh run list --repo w6w-io/w6w-wrappers --workflow release.yml --limit 5
gh run watch <release-run-id> --repo w6w-io/w6w-wrappers --exit-status
npm view @w6w/sdk version
npm view @w6w/cli version
npm view @w6w/react version
```

To rehearse before merging, dispatch `release.yml` on the branch
(`gh workflow run release.yml --repo w6w-io/w6w-wrappers --ref <branch>`); a
dispatch never uploads. No registry token is required anywhere: GitHub Actions
performs the uploads through its registered trusted publishers.

## Why this is the simple version

Two problems forced the old design, and the layout dissolved both:

**1. Trusted publishing binds to a repo _and_ a workflow filename.** The
registration instructions are spelled out in
`packages/core/.github/workflows/publish-types.yml:7-12`: _add a GitHub Actions
publisher: org/repo, workflow filename_. When the wrappers lived in three repos,
a single publishing job was impossible without stored registry tokens — a job in
one repo cannot mint a credential registered to another. Now all four artifacts
are built in **one** repo, so all four publishers register against
`w6w-io/w6w-wrappers` + `release.yml`, and the keyless posture the rest of this
workspace already uses (`publish-types.yml` for npm and JSR,
`server-deploy.yml:72-77` for GCP via Workload Identity Federation) applies here
without an exception.

**2. Standalone conformance could not read the contract.** A public wrapper
repo's CI could not read `endpoints.json` out of a private monorepo, which is
why a public mirror repo was going to exist. The contract is now a sibling file
in this repo — see
[parity.md §Where the contract comes from in
CI](./parity.md#where-the-contract-comes-from-in-ci), which is the authority on
that and records why the mirror must not come back.

Lockstep needed one actor that _decides_. It turns out one repo that decides
**and** uploads is available for free once the lanes stop being scattered.

## Before any of this can run

Outward-facing, one-time, and human:

1. **Register a trusted publisher for each artifact**, against
   `w6w-io/w6w-wrappers` and workflow `release.yml`:
   - npm: `@w6w/sdk` and `@w6w/cli` already exist (published `0.1.1` from the
     archived per-language repos) — on npmjs.com, open each package → Settings →
     Trusted Publisher → add a GitHub Actions publisher for
     `w6w-io/w6w-wrappers`, workflow `release.yml`. Not "pending"; the project
     already exists, this just adds OIDC as a second way to publish it.
   - PyPI: `w6w` — as a **pending publisher**, since the project does not exist
     yet. The first upload creates it.
2. **Create the `pypi` GitHub environment** (Settings → Environments) on
   `w6w-io/w6w-wrappers`, named to match the PyPI registration exactly. npm
   binds on repo + workflow only, no environment involved.
3. Nothing else. There is no repo to create, no token to mint, no secret to
   store.

The registration is the **one-way step**: it hard-binds to whichever repo
publishes. It has not happened yet, which is fortunate timing — registering it
against the now-archived `w6w-io/w6w-node` and `w6w-io/w6w-cli` would have had
to be undone by hand.

### The PyPI name is not reserved until the first upload

There is no reserve-first option, and a pending publisher is not one.
[PyPI's own docs](https://docs.pypi.org/trusted-publishers/creating-a-project-through-oidc/):
a pending publisher _"does **not** create a project or reserve a project's name
**until** it is actually used to publish"_, and if someone else registers the
name first, the pending publisher is **invalidated**. PyPI has no scopes — `w6w`
is a flat global name, unlike the `@w6w` npm scope, so it is
first-come.

**Do not wait on the organization to publish it.** A `w6w` **Company**
organization was requested on 2026-07-27 and is pending; PyPI states it _"is
unable to specify a timeline"_ for approval and reviews requests
_"periodically"_. The org name and the project name are separate things —
approving the org neither grants nor holds `w6w` as a project.

The sequence that does not depend on that queue: publish `w6w` from an
individual account (claiming the name), then, once the organization is approved,
use _Your organizations → Manage → Projects → Transfer existing project_, which
exists precisely for _"pre-existing projects associated with [an] individual
user account"_. **Re-check the trusted publisher after the transfer** — it is
bound to a GitHub repo and workflow rather than to the PyPI owner, so it ought
to survive a change of ownership, but that is worth confirming on the project
page before the next release rather than discovering at upload time.

> `@w6w/sdk@0.1.1` and `@w6w/cli@0.1.1` were already on npm, published before
> this workflow existed. `@w6w/sdk@0.2.0` was since published manually (a
> stopgap while the trusted publisher was being registered) — which is why this
> release is `0.2.1`, not `0.2.0`: the first version is already taken on npm and
> re-publishing it would be rejected. `0.2.1` is the first version this workflow
> itself publishes, and the first that will carry a `repository.directory`
> pointing into this repo, on every registry.

## The flow

Steps 1–4 are human or ordinary-merge work. Steps 5–8 are machine. Step 9 is
human again, and is not optional.

1. **Land the change** — every lane, in one PR against this repo's `main`. [`ci.yml`](../.github/workflows/ci.yml)
   has already run every lane's unit suite and conformance test against the
   contract in the same checkout.
2. **Bump `VERSION`.** It is the single source of truth and the only place a
   human types the new number.
3. **Write that number into every manifest**, in the same commit — the nine files
   step 5 checks, and no others: `node/package.json` +
   `node/src/version.ts`, `cli/package.json` + `cli/deno.json` + `cli/mod.ts`,
   `python/pyproject.toml` + `python/src/w6w/_version.py`,
   `react/package.json` + `react/src/version.ts`. Never hand-pick a different
   value in a manifest; step 5 is a gate, not a writer. Two version literals are
   **not** gated by step 5 and must still move with them: the `@w6w/sdk` semver
   range in `react/package.json`'s and `cli/package.json`'s `dependencies`, each
   `^<the new VERSION>` (e.g. `^0.9.0`), and the three lanes' `package-lock.json`
   files. Regenerate the locks by running `npm install` in `node/`, then `cli/`,
   then `react/` once the manifests are written, and commit them in the same
   commit (`npm ci` still succeeds on a stale lock, so it is no guard). Each lane's own
   test pins the range and the lock's `version` against
   `VERSION` (`react/src/__tests__/version.test.ts`, `cli/tests/help_test.ts`), so
   a lane that leaves it behind fails `test`. The CLI's Deno tasks never fetch
   that not-yet-published version: `cli/deno.json`'s import map resolves
   `@w6w/sdk` to `../node/mod.ts`. `"nodeModulesDir": "manual"` prevents Deno
   from eagerly installing the npm dependency. With Deno 2.9.7, `"auto"` tries
   to fetch that range even with `"links": ["../node"]`, blocking a fresh release.
4. **Merge the version bump to `main`.** That push triggers `release.yml`. For a
   dry run, invoke `release.yml` via `workflow_dispatch` on the intended ref; it
   has no inputs and reads `VERSION` from that checkout.
5. **`verify`** asks npm and PyPI which packages lack `VERSION` (those jobs run,
   the rest are skipped), then compares `VERSION` against the nine
   version literals step 3 lists — two for `node` (one manifest and a source
   constant), three for `cli`, `pyproject.toml` and `_version.py` for python,
   and two for `react` (one manifest and one source constant) — echoing every value _before_ deciding, so a failing log
   already answers "which one disagreed". Fails with `::error::` naming it. This
   mirrors `publish-types.yml:33-48` in the core repo.
6. **`test`** (`needs: verify`) runs every lane's suite: `unittest` for python,
   `npm test` for `node` and `react`, `deno task test` for `cli`. **The conformance runners live inside
   those suites** — `python/tests/test_surface.py`, `cli/tests/help_test.ts`,
   `node/tests/conformance_test.ts`, and each lane's version guard — and they
   read `endpoints.json` and `VERSION` from the same checkout as siblings. So
   the lockstep bet is enforced here: _an operation added to two wrappers and
   forgotten in a third fails this job, and nothing is uploaded._ It is not a
   separate job because it is not separate work; a standalone `conformance` job
   would re-run the same assertions.
7. **`publish`** (`needs: [verify, test]`) builds and uploads over OIDC, with
   `permissions: {id-token: write}` — the `id-token` is what replaces every
   token. The PyPI job additionally declares `environment: pypi`, which **must**
   match the environment named in the publisher registration: it travels in the
   OIDC claim and a mismatch is rejected at upload.
8. **Confirm every artifact landed**, then bump the monorepo's submodule pointer
   in a `chore(wrappers): bump submodule` commit.

The `test` gate builds all three npm packages and the Python sdist/wheel, and checks
the npm tarball contents before any upload.
These checks also run on `workflow_dispatch`. npm and PyPI releases cannot be unpublished in any
way that helps — a version that exists on npm but failed to build for PyPI is a
permanent inconsistency, and the only fix is burning a version number.

## Notes on the npm lanes

Three JavaScript publishing jobs (`npm-sdk`, `npm-cli`, `npm-react`), and the
shape is copied from the house pattern — `w6w-core`'s `publish-types.yml` ships
`@w6w/types` to npm and JSR over OIDC with no stored credential. What was _not_
copyable is written out here, because each item is a thing that would otherwise
be discovered at upload time:

- **This repo is public** (verified live: `gh repo view w6w-io/w6w-wrappers` →
  `PUBLIC`), so
  [GitHub's retirement of provenance for private source repositories](https://github.blog/changelog/2023-07-26-publishing-with-npm-provenance-from-private-source-repositories-is-no-longer-supported/)
  no longer applies here — `npm publish --provenance` is available, and modern
  npm emits provenance **automatically** under trusted publishing without the
  flag. The npm jobs stay off it anyway: this is a **deliberate, tracked
  deferral**, not a technical blocker — see `FOLLOWUPS.md` (G-8). Turning it on
  touches the already-working `npm-sdk`/`npm-cli` jobs and is a separate
  decision from adding a new lane.
- **`@w6w/cli` and `@w6w/react` both publish _after_ `@w6w/sdk`** —
  `needs: [verify, test, npm-sdk]`, not just the shared gate — because each
  declares a real npm dependency on it. The committed locks link `@w6w/sdk` to
  `../node`, so the install no longer fetches it; the ordering still keeps the
  published `@w6w/cli`/`@w6w/react` from existing before the SDK they name. (The `test` job's own react step hits the
  same gap earlier and for a different reason — see the note below.)
- **`npm-sdk` and the `test` job's node build use `npm ci`; the `cli` and
  `react` lanes keep `npm install`.** `node/`, `cli/` and `react/` each commit a
  `package-lock.json`. node's is self-contained (dev tooling only: `typescript`, `@biomejs/biome`,
  `@types/node`), so `npm ci`
  reproduces it exactly. cli's and react's record `@w6w/sdk` as a **link to
  `../node`** (`"resolved": "../node", "link": true`), not a registry tarball,
  because the registry's latest `@w6w/sdk` can trail `VERSION` and the
  `^<VERSION>` range then resolves to nothing. That is also why `npm-cli` and
  `npm-react` first build `node/` (`npm ci && npm run build`): the link needs
  `../node/dist` to exist before cli's or react's build. Their own lane install
  stays `npm install`, which keeps the link and leaves the lock unchanged. A
  lock is never published, so the tarballs are unaffected. Dev and CI otherwise
  run on the npm scripts in `node/` and `react/` and on the Deno tasks in
  `cli/deno.json`. `dist/` is produced by
  `tsc -p tsconfig.build.json`/`tsconfig.json` (the CLI additionally runs
  `scripts/fix-shebang.mjs`), and the CLI's and react's sources both import the
  bare specifier `@w6w/sdk`, which resolves from `node_modules` — not through
  the Deno import map, which points at `../node/mod.ts` and is a _development_
  convenience.
- **The `test` job builds `node/` and substitutes it into `react/`'s
  `node_modules` before running react's own suite**
  (`npm install --no-save
  ../node`, after a plain `npm install`) — react
  imports `@w6w/sdk/console`, a subpath no published `@w6w/sdk` carried until
  after this lane was added, so a bare registry install would fail the very
  first CI run. This step stays even once a console-bearing `@w6w/sdk` is on the
  registry: every other lane already tests against the sibling checkout rather
  than the last release, and a test job that silently measures a stale published
  package is the failure this repo's one-repo layout exists to prevent. The
  `npm-react` publish job does **not** do this substitution: it builds `node/`
  first (`npm ci` there), then `npm install` in `react/`, whose committed lock links
  `@w6w/sdk` to `../node` (the install keeps that link). The publish build therefore measures the SDK source
  of this very release commit, not whatever the registry's latest `@w6w/sdk`
  is (which can trail `VERSION`); it still runs after `npm-sdk`, so the version
  react's range names has been uploaded.
- **The trusted publishers for all four artifacts register against
  `w6w-io/w6w-wrappers` + `release.yml`**, exactly as PyPI's does. Registering
  them against the archived `w6w-node` / `w6w-cli` repos would have to be
  undone. **`@w6w/react` needs one extra, one-time step first**: unlike PyPI's
  pending-publisher flow, npm's trusted-publisher registration requires the
  package to already exist on the registry — the same situation
  `@w6w/sdk@0.1.1`/`@w6w/cli@0.1.1` were already in, above ("published before
  this workflow existed"). A human publishes `@w6w/react`'s first version
  manually from an authenticated local shell, then registers the trusted
  publisher exactly as for the other two npm packages; every release after that
  goes out from CI, tokenless, like its siblings.

The test gate and all npm publishing jobs install the same pinned npm version
(`NPM_VERSION` in the workflow). Update it in one place and run the full dry
run before releasing. Do not replace it with `npm@latest`: npm 12 rejects the
React lane's pinned Git development dependency by default, whereas npm 11
accepts it.

## Partial-failure reality

`0.9.8` was partially published on 2026-10-14: npm SDK/CLI, JSR SDK, and PyPI
succeeded, but npm React failed during install because its publishing job
upgraded to npm 12 while the test gate used npm 11. `0.9.9` is the replacement
lockstep release with the same pinned npm in testing and publishing.


The gate is atomic. **The upload is not, and no design makes it so** — four
registry uploads are four ways to fail, and registries have no cross-registry
transaction to enlist in.

- **Nothing uploads unless `verify` and `test` (including conformance) pass.** A
  version mismatch, a missing operation or a failing suite can never half-ship.
  The dangerous window is only _inside_ step 8.
- **A transient registry error is re-runnable at the same version.** Re-run the
  workflow; the jobs that already succeeded will fail as duplicates, so prefer
  re-running the single failed job where the runner allows it.
- **A genuinely half-published version has to be burned.** If npm accepted
  `@w6w/sdk` and PyPI rejected `w6w`, that number is spent — registries refuse to
  overwrite. Bump `VERSION` to the next patch and release the whole set again,
  so the set is consistent at the new number. The half-published version is
  abandoned, not repaired.
- **Say which version was skipped.** An orphan version on one registry is
  visible to anyone comparing versions across languages. Put the skipped number
  and the reason in the release notes rather than making them guess.

The operator's rule of thumb: _if one upload was rejected, re-run it. If the set
half-landed across its registries, burn the version._

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
is unrelated: the server image is assembled from several _private_ repos. This
repo is public and self-contained.
