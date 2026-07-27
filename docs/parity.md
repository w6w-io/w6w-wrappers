# Parity and versioning

Three wrappers, one surface, one version. This document is how that stays true
once it stops being convenient.

## The version is a shared fact

[`../VERSION`](../VERSION) is the single source of truth. Every wrapper's
manifest — `package.json` for node and cli, `pyproject.toml` for python — is
**written from** it during release, never edited by hand. If a wrapper repo's
manifest disagrees with `VERSION`, the manifest is wrong.

Consequences worth accepting deliberately:

- **A wrapper releases even when it did not change.** If only the Python client
  needed a fix, all three still go out at the new version. The alternative —
  letting versions drift — means `@w6w/sdk@0.4.0` and `w6w==0.4.0` are different
  APIs, and every support conversation starts with archaeology. An empty release
  is cheap; a divergent one is not.
- **Semver applies to the surface, not to any one language.** A breaking change
  in any wrapper is a major bump for all of them.

Below `1.0.0`, breaking changes may land in a minor bump. That grace ends at
`1.0.0` — say so in each wrapper's README so nobody plans around it.

## Conformance

Each wrapper repo carries a conformance test that reads `endpoints.json` and
asserts the client exposes **every** operation in `operations[]` — **regardless of
its `status`** — under the name in that operation's `naming` entry for its
language. The mechanics of resolving a `naming` string to a symbol or a CLI
command are pinned in
[implementation.md §10](./implementation.md#10-conformance-runner); this section
and that one must agree, and that one is the newer, pinned spec.

The test asserts **existence and signature**, not behavior — it is a drift alarm,
not a substitute for the wrapper's own unit tests. What it catches is the actual
failure mode: an operation added to two wrappers and forgotten in the third.

**`status` records *server readiness*, not wrapper obligation, so the runner
exempts nothing.** An operation is `"planned"` when its route is not live yet — a
statement about the server, aimed at a *user* deciding whether a call will
reach anything today. It tells an *implementer* nothing: this project implements
all of the operations ahead of the server, some of them `planned` only because the
server work is fenced. A wrapper that skipped an operation "because it is planned"
would ship a surface that silently differs from its two siblings, and the drift
would surface only when the fence clears — exactly the failure the lockstep bet
exists to prevent. Implement all of them, unit-test all of them against a mocked
transport, and assert all of them in conformance.

### Where the contract comes from in CI

`endpoints.json` lives in the monorepo, which is **private** — verified
2026-07-27, `gh repo view --json visibility,nameWithOwner` →
`{"nameWithOwner":"segevsh/w6w","visibility":"PRIVATE"}` — while the three
wrapper repos are public. So a wrapper repo's CI **cannot** fetch the contract
from the monorepo, and the fix is not a private-monorepo PAT in a public repo's
CI.

The route is a small **public mirror**, `w6w-io/w6w-contract`, holding
`endpoints.json` and `VERSION` and nothing else, which the monorepo pushes to
whenever either file changes. Each wrapper repo's `ci.yml` fetches both over
plain unauthenticated HTTPS and writes them **beside the checkout** —
`../endpoints.json` and `../VERSION` from the wrapper repo root, which is where
every lane already looks. The alternatives considered and the costs accepted are
in [release.md §Where the contract comes
from](./release.md#where-the-contract-comes-from); that section is the authority
if this one ever drifts from it.

Two rules that are not negotiable:

- **Fail loudly, never skip.** If the contract or `VERSION` cannot be fetched,
  the job fails naming the path it looked for. All three lanes' version guards
  already behave exactly this way — measured 2026-07-27 in
  `node/tests/version_test.ts:32-47`, `cli/tests/help_test.ts:286-305` and
  `python/tests/test_version.py:87-94` — and a guard that quietly passes when
  its input is missing is worse than no guard. A standalone clone is precisely
  the case a public repo's CI is, so this is the normal path, not an edge.
- **Never vendor a copy.** A committed copy inside a wrapper repo goes stale
  silently and defeats the whole mechanism — the same rule
  [implementation.md §10](./implementation.md#10-conformance-runner) pins.
  Fetching at CI time is not vendoring: nothing is committed.

> **Not submodules yet.** `packages/wrappers/{node,cli,python}` are plain local
> git repos **with no remotes** today; the `w6w-io` repos do not exist (HITL-1),
> so there is nothing to point a submodule at. When they do exist and are
> attached as submodules, a *monorepo-side* checkout will see the contract as a
> sibling directly — but the public mirror is still what each wrapper repo's own
> CI uses, because that runs standalone against a private monorepo either way.

## Adding an operation

The order is not negotiable, because each step depends on the previous one being
real:

1. **Server first — for `status`, not for the code.** The endpoint ships in
   the server, is deployed, and only then does its operation become
   `status: "required"`. That is what "wrappers never lead the API" means: no
   operation is ever *advertised as live* before its route is, because a client
   method that silently returns 404 is worse than no method.

   It does **not** mean a wrapper waits. An operation whose route is not live
   yet goes into `endpoints.json` as `status: "planned"`, and is implemented in
   all three wrappers, unit-tested against a mocked transport, and asserted in
   conformance — exactly as §Conformance requires. `status` is the honesty
   mechanism that lets both rules hold at once: the **contract** records what
   the server can serve today, and the **wrappers** stay in lockstep regardless.
   This project is the live example — it implements the whole surface ahead of a
   server whose work is fenced, and marks what is not reachable yet.
2. **Contract second.** Add the operation to `endpoints.json` (`status: "required"`)
   and document it in `docs/endpoints.md` with its wire shape and per-language
   naming. Decide the naming *here*, once, rather than three times in three PRs.
3. **All three wrappers third.** One PR per wrapper repo, opened against
   `w6w-io` upstream. Conformance CI in each will fail until its own PR lands —
   that failure is the mechanism, not an annoyance to route around.
4. **Release together.** Bump `VERSION`, tag, ship ([release.md](./release.md)).

## Adding a language

A fourth wrapper is a real commitment: it makes step 3 above wider forever. Before
adding one, be sure the language will get the same release-day attention the first
three get. A wrapper that lags a version behind is worse for its users than no
wrapper at all, because they will reasonably assume it is current.

The bar for a new wrapper joining the lockstep:

- **Every** operation in `endpoints.json` implemented — `required` and `planned`
  alike, per §Conformance — and the conformance test green.
- Publishing automated on the same trigger as the others — its own repo, its own
  OIDC workflow, fired by the monorepo's release dispatch
  ([release.md](./release.md)).
- Its manifest version written from `VERSION`.

Until all three hold, keep it out of the release workflow rather than shipping it
half-joined.
