# Releasing the wrappers

All three publish together, at one version, from one decision point. The
monorepo **decides and gates** the release; each wrapper repo **publishes
itself**. Simultaneity still has a single actor, and no long-lived publishing
credential exists anywhere.

> **This architecture is the pinned default of an open decision (HITL-7), not a
> settled one.** It replaces the 2026-07-24 "the monorepo publishes everything"
> design for the two measured reasons in [§Why the 07-24 design
> changed](#why-the-07-24-design-changed). If that decision is answered
> differently, [§If this decision changes](#if-this-decision-changes) names
> exactly which files move. `.claude/docs/strategy/WRAPPERS.md` §4 still carries
> the 07-24 wording with the same review note attached; **this document is the
> one that decides**, and WRAPPERS.md follows it.

## The split

| Owner | Does | Does not |
|---|---|---|
| **monorepo** (`segevsh/w6w`) | owns [`../VERSION`](../VERSION); verifies every wrapper manifest agrees with it; runs the cross-wrapper conformance check; tags; fires one `repository_dispatch` per wrapper repo | publish anything, or hold any registry credential |
| **each wrapper repo** (`w6w-io/w6w-{node,cli,python}`) | listens for `repository_dispatch` type `wrappers-release`, re-verifies the requested version against its own manifests, builds, and publishes **itself** over OIDC trusted publishing | decide *when* a release happens, or what version it is |

The monorepo half is `.github/workflows/wrappers-release.yml`. The wrapper half
is each repo's own `.github/workflows/publish.yml`, which triggers on
`repository_dispatch` (type `wrappers-release`) and on `workflow_dispatch`,
never on a bare `push`.

**The cross-repo trigger is already proven in this workspace.**
`.github/workflows/server-deploy.yml:20-22` declares
`repository_dispatch: types: [server-src-updated]` and is fired today by the
sibling source repos on their merges. That file proves the *receiving* half —
the half that has to work inside a repo we do not control at trigger time. The
*sending* half is a `POST /repos/{owner}/{repo}/dispatches` API call, which
needs a token (see [§Required secrets](#required-secrets)).

## Why the 07-24 design changed

The original design had the monorepo build and publish all three. Two things
make it unrunnable as written, both checkable from files in this workspace.

**1. It forces long-lived publish tokens — which this workspace does not use.**
Trusted publishing (npm, JSR and PyPI OIDC) binds a credential to a *specific*
`org/repo` **and workflow filename**. The registration instructions are written
out in `packages/core/.github/workflows/publish-types.yml:7-12`: *add a GitHub
Actions publisher: org/repo `"w6w-io/w6w-core"`, workflow
`"publish-types.yml"`*. A job running in `segevsh/w6w` therefore cannot mint a
credential registered to `w6w-io/w6w-node`, so a monorepo-driven publish must
fall back to stored registry tokens — the exact thing the 07-24 text of this
document argued against in its own closing paragraph, while
`publish-types.yml:59-74` was already publishing `@w6w/types` to **npm and
JSR** with no stored credential at all, and
`.github/workflows/server-deploy.yml:72-77` was authenticating to GCP keylessly
via Workload Identity Federation. The house posture is keyless; the 07-24
release design was the only thing asking for an exception.

**2. Standalone conformance could not work.** The 07-24 text of
[`parity.md`](./parity.md) told a wrapper repo's own CI to fetch
`endpoints.json` from the monorepo's `main`. The monorepo is **private** —
verified 2026-07-27, `gh repo view --json visibility,nameWithOwner` →
`{"nameWithOwner":"segevsh/w6w","visibility":"PRIVATE"}`. A public repo's CI
cannot read it, and the fix is not a private-monorepo PAT in a public repo's
CI: `.github/workflows/server-deploy.yml:11-14` already documents what one of
those costs (`SIBLING_REPO_PAT`, read access to five private repos, held as a
repo secret), and that is a cost to stop repeating, not to extend to public
repos. See [§Where the contract comes from](#where-the-contract-comes-from).

Neither problem is a reason to abandon lockstep. Lockstep needs one actor that
*decides*; it does not need one actor that *uploads*.

## Before any of this can run

`packages/wrappers/{node,cli,python}` are plain local git repos
**with no remotes** today — verified 2026-07-27:
`git -C packages/wrappers/node remote -v`
prints nothing, and so do `cli` and `python`. The `w6w-io` repos named above do
not exist yet (HITL-1), no trusted publisher is registered anywhere, and the
PyPI name is unclaimed.

So **nothing in this document is runnable until a human does the outward-facing
steps**: create the three GitHub repos, push, create the npm/JSR/PyPI packages,
and register a trusted publisher on each against *that repo* and *that workflow
filename*. Those steps are enumerated, paste-ready, in
`artifacts/release-prerequisites.md` inside this project's harness folder
(`.ai/projects/.work/26-07-27-01-wrappers/artifacts/release-prerequisites.md`,
which moves to `.ai/projects/done/...` at closeout).

The trusted-publisher registration is the **one-way step**: it hard-binds to
whichever repo publishes. Registering it before HITL-7 is answered means
re-registering by hand if the answer is (a).

## The flow

Steps 1–5 are human or ordinary-merge work. Steps 6–9 are machine. Step 10 is
human again, and is not optional.

1. **Land the wrapper changes** in each wrapper repo's `main` (upstream
   `w6w-io`), one PR per repo. Each repo's own `ci.yml` has already run its unit
   suite and its conformance test against the published contract.
2. **Bump `VERSION` in the monorepo** — `packages/wrappers/VERSION` is the
   single source of truth and the only place a human types the new number.
3. **Write that number into every wrapper manifest**, one commit per wrapper
   repo: `node/deno.json` + `node/package.json` + `node/src/version.ts`,
   `cli/deno.json` + `cli/package.json` + `cli/mod.ts`'s `VERSION`, and
   `python/pyproject.toml` + `python/src/w6w/_version.py`. Never hand-pick a
   different value in a manifest. *This is a real consequence of the split*:
   under the 07-24 design a single release job rewrote all the manifests, but
   the monorepo cannot commit into repos it does not own at publish time. The
   bump is now one commit per repo, and step 6 is what makes them agree — a
   gate, not a writer.
4. **Mirror the contract** so the public side can see the new surface
   ([§Where the contract comes from](#where-the-contract-comes-from)).
5. **Tag the monorepo** `wrappers-v0.2.0`. (For a dry run, invoke
   `wrappers-release.yml` via `workflow_dispatch` with an explicit `version`
   input instead — it verifies and runs conformance without tagging.)
6. **`verify`** (monorepo) reads `packages/wrappers/VERSION` and compares it
   against the tag and all five manifests, echoing every value it compared
   before deciding, and failing with `::error::` naming the manifest that
   disagreed. This mirrors `publish-types.yml:33-48`, whose `verify` job strips
   the tag prefix and compares against both of its manifests the same way.
7. **`conformance`** (`needs: verify`) checks out all three wrapper repos and
   runs each one's conformance task against the monorepo's own
   [`../endpoints.json`](../endpoints.json). If any wrapper is missing an
   operation, the release stops here and nothing is dispatched. This is the
   whole lockstep bet: *an operation added to two wrappers and forgotten in the
   third must block the release, not ship*. It needs no credential — the wrapper
   repos are public, so the default `GITHUB_TOKEN` can read them. The privacy
   asymmetry that breaks the contract fetch in one direction costs nothing in
   this one.
8. **`dispatch`** (`needs: [verify, conformance]`) sends a `repository_dispatch`
   of type `wrappers-release` to each of the three wrapper repos, carrying the
   version in the payload. Either all three go out or none do — that is where
   simultaneity is enforced.
9. **Each wrapper repo publishes itself.** Its `publish.yml` re-verifies the
   dispatched version against its own manifests, builds, and uploads over OIDC
   trusted publishing: `@w6w/sdk` → npm + JSR, `@w6w/cli` → npm + JSR, `w6w` →
   PyPI. Five uploads, three repos, no stored credential in any of them.
10. **Confirm all three landed.** The dispatch API returns as soon as the event
    is *accepted*; it does not wait for the publish and reports nothing about
    it. The monorepo workflow therefore **cannot** tell you the release
    succeeded — only that it was authorised. Check the three registries (or the
    three workflow runs) before announcing anything. This is the honest cost of
    the split, and [§Partial-failure reality](#partial-failure-reality) is what
    to do when the answer is "two out of three".

Build before uploading, inside each repo. npm, JSR and PyPI releases cannot be
unpublished in any way that helps — a version that exists on npm but failed to
build for PyPI is a permanent inconsistency, and the only fix is burning a
version number.

## Where the contract comes from

`endpoints.json` lives in a **private** monorepo and is read by the CI of three
**public** repos. Something has to bridge that, and every option costs
something.

**Decision: mirror `endpoints.json` and `VERSION` to a small public repo,**
`w6w-io/w6w-contract`, holding nothing else. Each wrapper repo's `ci.yml`
fetches both files over plain unauthenticated HTTPS and writes them **beside the
checkout** — `../endpoints.json` and `../VERSION` relative to the wrapper repo
root, which is exactly where every lane already looks. Step 4 of the flow keeps
the mirror current.

Why the alternatives lost:

- **A release asset on an existing public repo** (`w6w-io/w6w-core` is public)
  is the cheapest-looking option and has a concrete trap:
  `packages/core/.github/workflows/publish-types.yml:19-21` triggers on
  `release: types: [published]` with **no tag filter**, so publishing a
  `wrappers-vX.Y.Z` release in that repo would fire the `@w6w/types` publish
  workflow, whose `verify` job would then fail on a tag it cannot parse. A red
  workflow on every wrapper release is not a foundation. `core` is also the
  transport-free spec repo; a server HTTP-API contract does not belong in it.
- **Vendoring a copy in each wrapper repo with a freshness check** is
  explicitly forbidden by the pinned spec:
  [implementation.md §10](./implementation.md#10-conformance-runner) says the
  runner "must never fall back to a copy vendored inside the wrapper repo — a
  stale pinned copy defeats the entire mechanism", and all three lanes already
  say so in the guard itself (`node/tests/version_test.ts:37-38`,
  `cli/tests/help_test.ts:294-295`, `python/tests/test_version.py:90-93`). A
  freshness check against an unreachable source is not a check.
- **Conformance only in the monorepo** would leave a public contributor's PR
  green while non-conformant, and the drift would surface at release time in a
  repo they cannot see. The drift alarm has to ring where the drift happens.

The cost accepted: a **fourth repo** to create and keep in sync, a mirror that
can lag, and the contract — including its `planned` operations, i.e. a partial
roadmap — becoming public. The lag is bounded to where it does not matter:
the *release* gate (flow step 7) runs against the monorepo's own working copy
and never touches the mirror, so a stale mirror can produce a spurious CI
failure in a wrapper repo but can never let a bad release through.

**Materialising the contract is mandatory in CI, not best-effort.** All three
lanes' version guards **fail loudly and name the path** when `../VERSION` is
absent, and never skip — measured 2026-07-27 in
`packages/wrappers/node/tests/version_test.ts:32-47`,
`packages/wrappers/cli/tests/help_test.ts:286-305` and
`packages/wrappers/python/tests/test_version.py:87-94`. A standalone clone —
which is exactly what a public wrapper repo's CI is — has no `../VERSION` and no
`../endpoints.json` unless CI puts them there. So every wrapper repo's `ci.yml`
must fetch **both** files before running its suite, and a failed fetch must fail
the job.

## Partial-failure reality

The publish is *more* fragmented than before, not less: three repos, five
registry uploads, five ways to fail. What the split buys is that the failure is
**isolated and independently re-runnable**, which the 07-24 design could not
offer.

- **The gate is atomic; the upload is not.** Nothing is dispatched unless
  `verify` and `conformance` both pass, so the dangerous window is only *after*
  step 8. A version mismatch or a missing operation can never half-ship.
- **Re-run the failed repo, not the release.** Each `publish.yml` also takes
  `workflow_dispatch`, so a transient registry error is repaired by re-running
  that one repo's workflow at the same version. Do **not** re-tag the monorepo
  and re-dispatch: the two repos that succeeded would fail as duplicates and
  bury the real error in noise.
- **A repo that half-published across two registries has to burn the version.**
  `node` and `cli` each upload to npm *and* JSR. If npm succeeded and JSR did
  not, re-running that repo fails at the npm job — registries refuse to
  overwrite an existing version. Bump `VERSION` to the next patch and release
  the whole set again, so the set is consistent at the new number. The
  half-published version is abandoned, not repaired.
- **Say which version was skipped.** An orphan version on one registry is
  visible to users comparing versions across languages. Put the skipped number
  and the reason in the release notes rather than making them guess.

The operator's rule of thumb: *if one registry rejected one upload, re-run that
repo. If one repo half-landed, burn the version.*

## Prerelease

For a release candidate, use `VERSION` values like `0.2.0-rc.1`, valid for both
npm (dist-tag `next`) and PyPI (`0.2.0rc1` after normalization — the python
repo's own publish workflow does that conversion when it writes
`pyproject.toml`, since under this split the monorepo does not write manifests).
The lockstep rule applies to prereleases exactly as it does to finals.

## Required secrets

**No publish credential exists anywhere in this design** — not in the monorepo,
not in any wrapper repo. No stored npm token, no stored PyPI token, no `twine`
password. Every upload is trusted publishing over OIDC, the same mechanism
`packages/core/.github/workflows/publish-types.yml` already uses to ship
`@w6w/types` to npm and JSR. Each wrapper's `publish.yml` declares
`permissions: {contents: read, id-token: write}`; the `id-token` is what
replaces the token.

One secret remains, in the **monorepo only**:

| Secret | Used for | Why not keyless |
|--------|----------|-----------------|
| `WRAPPER_DISPATCH_TOKEN` | firing the `repository_dispatch` to the three wrapper repos (flow step 8), and pushing the mirrored contract to `w6w-io/w6w-contract` (step 4) | the workflow's built-in `GITHUB_TOKEN` is scoped to the repo it runs in, and GitHub offers no OIDC path to a cross-repo dispatch |

Scope it as tightly as the API allows: a **fine-grained** PAT — or, better, a
GitHub App installation token — limited to
`w6w-io/w6w-{node,cli,python,contract}` with the single permission
`Contents: read and write`, which is the minimum
`POST /repos/{owner}/{repo}/dispatches` accepts. What it *cannot* do is the
point: it is not a credential at any package registry, so leaking it lets
someone trigger a release workflow, not publish a package. The publish still
demands an OIDC identity minted inside the wrapper repo itself.

`SIBLING_REPO_PAT` (`.github/workflows/server-deploy.yml:11-14`) is **not**
needed by this flow. It exists because the server image is assembled from five
*private* repos; the wrapper repos are public, so flow step 7 reads them with
the default token.

## If this decision changes

HITL-7 is open. This document implements option **(c) hybrid**. If the answer is
different, here is the whole blast radius — a paragraph, not an excavation.

**If (a), the monorepo publishes everything** (the 07-24 design, accepting
stored tokens):

- delete `packages/wrappers/{node,cli,python}/.github/workflows/publish.yml`
  — all three;
- rewrite `.github/workflows/wrappers-release.yml`: the `dispatch` job becomes
  npm / JSR / PyPI publish jobs, and the monorepo checks out each wrapper at the
  released commit and builds it;
- add stored registry credentials as monorepo secrets — unavoidable, per
  [§Why the 07-24 design changed](#why-the-07-24-design-changed);
- **re-register every trusted publisher by hand** (npm ×2, JSR ×2, PyPI ×1)
  against `segevsh/w6w` + `wrappers-release.yml`, because the binding is to
  `org/repo` + workflow filename. This is the one-way step, and it is why the
  answer is wanted *before* the registrations happen;
- in this document: §The split, §The flow steps 8–9, §Partial-failure reality
  (back to one job, one failure, burn the version), §Required secrets;
- in `.claude/docs/strategy/WRAPPERS.md` §4: drop the "under review" note, the
  07-24 text stands as written.

**If (b), each wrapper repo publishes itself with no orchestrator:**

- delete `.github/workflows/wrappers-release.yml` entirely;
- change each `publish.yml`'s trigger from `repository_dispatch` to that repo's
  own release/tag event; the `verify` job stays exactly as it is;
- **the cross-wrapper conformance gate loses its home.** Nothing would check all
  three at once, so "released together" becomes convention enforced by human
  diligence — the failure mode the lockstep bet exists to prevent. If (b) is
  chosen, each repo's `ci.yml` must at minimum keep failing on its own drift,
  and `parity.md` should say plainly that simultaneity is no longer mechanical;
- `WRAPPER_DISPATCH_TOKEN` shrinks to the contract mirror, or disappears if the
  mirror moves elsewhere;
- in this document: §The split, §The flow steps 5–8, §Required secrets.

**Unaffected either way:**
[§Where the contract comes from](#where-the-contract-comes-from). The public
mirror exists because the monorepo is private and the wrapper repos are public
— a fact about repository visibility, not about who runs `npm publish`.
