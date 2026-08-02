# Releasing the wrappers

Every wrapper publishes together, at one version, from one workflow in this
repo. One actor decides, gates and uploads. PyPI uploads over OIDC with no
stored credential; npm and JSR upload with a stored token each
(`NPM_TOKEN`, `JSR_TOKEN`) — see [§Required secrets](#required-secrets) for
why those two aren't OIDC too.

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
| **this repo** (`w6w-io/w6w-wrappers`) | owns [`../VERSION`](../VERSION); verifies every manifest agrees with it; runs conformance across every lane; tags; builds and publishes all five artifacts | hold a PyPI credential — that one's OIDC only |
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

Outward-facing, one-time, and human — but shorter than it was, because npm and
JSR moved off OIDC:

1. **PyPI: register a pending publisher** for `w6w` against
   `w6w-io/w6w-wrappers`, workflow `release.yml`, environment `pypi` — the
   project doesn't exist yet, the first upload creates it. This is the one
   registry where OIDC is worth the one-time setup: PyPI's is a single form,
   no per-package pre-creation step.
2. **Create the `pypi` GitHub environment** (Settings → Environments) on
   `w6w-io/w6w-wrappers`, named to match the PyPI registration exactly.
3. **npm and JSR: add repo secrets instead.** `NPM_TOKEN` (an npm automation
   token with publish rights on `@w6w/sdk` and `@w6w/cli`) and `JSR_TOKEN` (a
   JSR personal access token with Publish permission on the `@w6w` scope) —
   both under Settings → Secrets and variables → Actions on
   `w6w-io/w6w-wrappers`. Neither registry's OIDC path was worth taking: npm's
   Trusted Publisher is a per-package web form with no bulk/API equivalent,
   and JSR's OIDC additionally requires creating and linking each package by
   hand on jsr.io before a CI run can use it. A token sidesteps both, at the
   cost documented in [§Required secrets](#required-secrets).

The PyPI registration is the **one-way step** among these: it hard-binds to
whichever repo publishes. It has not happened against the archived
`w6w-io/w6w-node` / `w6w-io/w6w-cli` repos, which is fortunate timing — that
would have had to be undone by hand. Tokens carry no such binding; rotating
`NPM_TOKEN`/`JSR_TOKEN` is just re-pasting a repo secret.

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
7. **The five publish jobs** (`needs: [verify, test]`, `npm-cli` additionally
   needs `npm-sdk`) build and upload. `pypi` uses OIDC — `permissions:
   {id-token: write}` and `environment: pypi`, which **must** match the
   environment named in the publisher registration: it travels in the OIDC
   claim and a mismatch is rejected at upload. `npm-sdk`/`npm-cli`/`jsr-sdk`/
   `jsr-cli` use `secrets.NPM_TOKEN`/`secrets.JSR_TOKEN` instead.
8. **Confirm every artifact landed**, then bump the monorepo's submodule pointer
   in a `chore(wrappers): bump submodule` commit.

Build before uploading. npm, JSR and PyPI releases cannot be unpublished in any
way that helps — a version that exists on npm but failed to build for PyPI is a
permanent inconsistency, and the only fix is burning a version number.

## Notes on the npm and JSR lanes

Four jobs: `npm-sdk`, `npm-cli`, `jsr-sdk`, `jsr-cli`. Unlike `w6w-core`'s
`publish-types.yml` (which ships `@w6w/types` to npm and JSR over OIDC), these
authenticate with `secrets.NPM_TOKEN` / `secrets.JSR_TOKEN` — see
[§Required secrets](#required-secrets) for why. What's specific to these four
jobs, written out here because each item is a thing that would otherwise be
discovered at upload time:

- **`npm publish --provenance` cannot be used while this repo is private**,
  independent of the token-vs-OIDC choice —
  [GitHub retired provenance for private source repositories](https://github.blog/changelog/2023-07-26-publishing-with-npm-provenance-from-private-source-repositories-is-no-longer-supported/).
  Token-based publishing was never going to get provenance anyway (npm only
  attaches it under OIDC), so this repo going public later doesn't change
  anything here unless the npm jobs are migrated to OIDC at the same time.
- **`@w6w/cli` publishes *after* `@w6w/sdk`** — `needs: [verify, test, npm-sdk]`,
  not just the shared gate — because it declares a real npm dependency on it,
  and its `npm install` step needs `^0.2.0` already live on the registry.
  Otherwise there is a window in which that install resolves to nothing.
- **Both npm jobs use `npm install`, not `npm ci`.** There is no committed
  `package-lock.json` for either lane — dev and CI both run on the Deno tasks
  in `deno.json`, and the npm manifests exist only to build and publish. `dist/`
  is produced by `tsc -p tsconfig.build.json` (the CLI additionally runs
  `scripts/fix-shebang.mjs`), and the CLI's sources import the bare specifier
  `@w6w/sdk`, which resolves from `node_modules` — not through the Deno import
  map, which points at `../node/mod.ts` and is a *development* convenience.
- **JSR's `--token` flag needs no scope/package pre-creation** — that
  requirement (`@w6w` scope existing, each package linked to a repo) is
  specific to JSR's OIDC path. Confirmed the source itself is publishable with
  `deno publish --dry-run` for both lanes, including the CLI's cross-package
  `@w6w/sdk` import. The publish step is `npx --yes jsr publish --token
  "$JSR_TOKEN"` from the lane directory, no build.

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

**`NPM_TOKEN` and `JSR_TOKEN`. Not PyPI, and not a cross-repo dispatch PAT.**

This is a deliberate departure from the original all-OIDC design (`w6w-core`'s
`publish-types.yml` is still all-OIDC, and PyPI in this same workflow still is
too). The reason is asymmetric setup cost, not a change of principle:

- **PyPI's OIDC path is a single form** — register a pending publisher once,
  done. Worth it, so it stays OIDC.
- **npm's Trusted Publisher is a per-package web form** with no CLI/API way to
  register it, and **JSR's OIDC additionally requires creating and linking
  each package on jsr.io before a CI run can use it** — two more manual,
  per-package, web-only steps than PyPI needed, for two artifacts each (sdk,
  cli). A token collapses all four of those into one secret per registry,
  pasted once.

What this costs: `npm publish --provenance` is unavailable either way (see
[§Notes on the npm and JSR lanes](#notes-on-the-npm-and-jsr-lanes)), and the
tokens are long-lived credentials sitting in GitHub Actions secrets rather
than short-lived OIDC exchanges — rotate them the same way any other repo
secret gets rotated. If npm/JSR later grow a bulk or API way to register
Trusted Publishers, revisit; until then a token is the pragmatic choice, not
an oversight.

The `WRAPPER_DISPATCH_TOKEN` the previous architecture needed — a fine-grained
PAT with write access to four repos, whose only job was firing a
`repository_dispatch` and pushing to a contract mirror — **does not exist and
must not be reintroduced.** It was a consequence of the split, and the split is
gone. `NPM_TOKEN`/`JSR_TOKEN` are a different thing: registry credentials
scoped to this repo's own publish jobs, not cross-repo automation.

`SIBLING_REPO_PAT` (`.github/workflows/server-deploy.yml:11-14` in the monorepo)
is unrelated: the server image is assembled from several *private* repos. This
repo is public and self-contained.
