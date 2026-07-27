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
asserts the client exposes every operation with `status: "required"`, under the
name in that operation's `naming` entry for its language.

The test asserts **existence and signature**, not behavior — it is a drift alarm,
not a substitute for the wrapper's own unit tests. What it catches is the actual
failure mode: an operation added to two wrappers and forgotten in the third.

Operations with `"status": "planned"` are exempt until the server implements them
and the status flips to `"required"` — that flip is what turns the endpoint from
a design note into a release blocker for all three.

Since `endpoints.json` lives in the monorepo and the wrappers are submodules, each
wrapper repo gets it via the submodule checkout in CI. A wrapper repo's own CI
(running standalone, without the monorepo) should fetch it from the monorepo's
`main` — pinning a stale copy inside the wrapper repo defeats the entire point.

## Adding an operation

The order is not negotiable, because each step depends on the previous one being
real:

1. **Server first.** The endpoint ships in the server and is deployed.
   Wrappers never lead the API — a client method for a route that returns 404 is
   worse than no method.
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

- All `required` operations implemented, conformance test green.
- Publishing automated from the monorepo, same as the others.
- Its manifest version written from `VERSION`.

Until all three hold, keep it out of the release workflow rather than shipping it
half-joined.
