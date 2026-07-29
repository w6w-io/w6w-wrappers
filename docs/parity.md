# Parity and versioning

Every wrapper, one surface, one version. This document is how that stays true
once it stops being convenient.

They all live in **this repo**, one directory per language, beside the contract
they implement. That is what makes the rest of this document enforceable rather
than aspirational: a change that touches the surface touches every lane in the
same diff, and CI runs all of them together before it can merge.

## The version is a shared fact

[`../VERSION`](../VERSION) is the single source of truth. Every wrapper's
manifest — `package.json` for node and cli, `pyproject.toml` for python — is
**written from** it during release, never edited by hand. If a manifest
disagrees with `VERSION`, the manifest is wrong.

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

Each wrapper carries a conformance test that reads `endpoints.json` and
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
statement about the **server**, aimed at a *user* deciding whether a call will
reach anything today. It tells an *implementer* nothing: this project implements
all of the operations ahead of the server, some of them `planned` only because the
server work is fenced. A wrapper that skipped an operation "because it is planned"
would ship a surface that silently differs from its two siblings, and the drift
would surface only when the fence clears — exactly the failure the lockstep bet
exists to prevent. Implement all of them, unit-test all of them against a mocked
transport, and assert all of them in conformance.

### Where the contract comes from in CI

From the checkout. There is nothing to fetch.

`endpoints.json` and `VERSION` sit at the root of **this** repo,
`w6w-io/w6w-wrappers`, one level above every lane — so `../endpoints.json` from
`node/`, `cli/` or `python/` is a plain sibling path in the same working tree,
in CI exactly as on a laptop. Every lane's conformance and version guard already
resolves it that way, from the test file's own location rather than the process
working directory.

This is the single largest thing the one-repo layout buys, so it is worth
recording what it replaced. When the wrappers were three separate public repos
and the contract lived in the **private** monorepo, no wrapper's CI could read
it — and the answer was not a private-monorepo PAT in a public repo. The plan
was a third repo, `w6w-io/w6w-contract`, mirroring two files and nothing else,
plus a monorepo job to push to it on every change and a fetch step in each
wrapper's `ci.yml`. That repo was never created and never needs to be: a mirror
is a copy, a copy goes stale, and the staleness would have been invisible
precisely when the contract changed. **Do not reintroduce it.**

Two rules survive the change, because they were never about the mirror:

- **Fail loudly, never skip.** If the contract or `VERSION` cannot be read, the
  job fails naming the path it looked for. All four guards behave exactly this
  way — `node/tests/version_test.ts`, `cli/tests/help_test.ts`,
  `python/tests/test_version.py` and `python/tests/test_surface.py` — and a
  guard that quietly passes when its input is missing is worse than no guard.
- **Never vendor a copy.** A committed copy of the contract inside a lane
  directory goes stale silently and defeats the whole mechanism — the same rule
  [implementation.md §10](./implementation.md#10-conformance-runner) pins. Every
  lane reads the one file at the repo root.

> **On the monorepo side**, this repo is attached at `packages/wrappers` as a
> submodule of the private `w6w` monorepo — the same treatment `packages/core`
> gets. A monorepo checkout therefore sees exactly the layout above; the
> submodule pointer is bumped in its own `chore(wrappers): bump submodule`
> commit after a change lands here.

## Adding an operation

The order is not negotiable, because each step depends on the previous one being
real:

1. **Server first — for `status`, not for the code.** The endpoint ships in the
   server, is deployed, and only then does its operation become
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
3. **Every wrapper third — in one PR.** All lanes move together, in a single
   change against this repo, and conformance runs over every one of them in the
   same CI run. It cannot half-land.

   This used to be "one PR per wrapper repo", three PRs that had to be
   coordinated by hand and each of which was red until the others merged. That
   coordination *was* the drift risk this document exists to manage: a fourth
   language would have made it four PRs, and the failure mode — an operation
   added to two lanes and forgotten in the third — was only ever caught after
   the fact, by a conformance run in a repo nobody was looking at. Now it is
   caught before merge, in the diff.
4. **Release together.** Bump `VERSION`, tag, ship ([release.md](./release.md)).

## Adding a language

A new language is **a directory in this repo** — `go/`, `dart/`, beside the three
that are here. Not a repo, not a CI bootstrap, not a new set of publish secrets:
a directory, a lane in the existing workflow, and a conformance test.

That is the whole point of the layout, and it is worth being explicit about what
it does *not* make cheap. A wrapper is still a real commitment, because it makes
step 3 above wider forever: every future operation now has to be written a fourth
time, by someone who knows that language, on the same day. A wrapper that lags a
version behind is worse for its users than no wrapper at all — they will
reasonably assume it is current. The repo layout removes the *ceremony*, not the
obligation.

The bar for a new wrapper joining the lockstep:

- **Every** operation in `endpoints.json` implemented — `required` and `planned`
  alike, per §Conformance — and the conformance test green.
- Its own lane in this repo's CI workflow, running its gates on a path filter,
  and its own publish job on the shared release trigger
  ([release.md](./release.md)).
- Its manifest version written from `VERSION`.

Until all three hold, keep it out of the release workflow rather than shipping it
half-joined.
