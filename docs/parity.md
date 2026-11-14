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

Each **contract lane** — `node`, `cli`, `python`, and any future language that
talks to `endpoints.json` directly — carries a conformance test that reads
`endpoints.json` and asserts the client exposes **every** operation in
`operations[]` — **regardless of its `status`** — under the name in that
operation's `naming` entry for its language. (Not every lane in this repo is a
contract lane — see below.) The mechanics of resolving a `naming` string to a
symbol or a CLI command are pinned in
[implementation.md §10](./implementation.md#10-conformance-runner); this section
and that one must agree, and that one is the newer, pinned spec.

The test asserts **existence and signature**, not behavior — it is a drift
alarm, not a substitute for the wrapper's own unit tests. What it catches is the
actual failure mode: an operation added to two wrappers and forgotten in the
third.

Not every lane in this repo carries this test, and the split has a name. A
**contract lane** — `node`, `cli`, `python` — implements every operation in
`endpoints.json` directly, appears in every operation's `naming` object, and
must have this test, green, with no exception. A **derived lane** — `react`, the
first one — composes an existing contract lane's already-conformant published
client instead of talking to `endpoints.json` itself, so it has no `naming`
entry to assert and carries no conformance test of its own; it still ships at
the same `VERSION` as everything else, because it only ever builds from a
contract lane's release, never from the contract independently. The missing
`naming.react` key is therefore not a gap the runner should have caught — it is
the shape of the category, and §Adding a language says the same for anyone
tempted to read it as a shortcut.

**`status` records _server readiness_, not wrapper obligation, so the runner
exempts nothing.** An operation is `"planned"` when its route is not live yet —
a statement about the **server**, aimed at a _user_ deciding whether a call will
reach anything today. It tells an _implementer_ nothing: this project implements
all of the operations ahead of the server, some of them `planned` only because
the server work is fenced. A wrapper that skipped an operation "because it is
planned" would ship a surface that silently differs from its two siblings, and
the drift would surface only when the fence clears — exactly the failure the
lockstep bet exists to prevent. Implement all of them, unit-test all of them
against a mocked transport, and assert all of them in conformance.

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
   operation is ever _advertised as live_ before its route is, because a client
   method that silently returns 404 is worse than no method.

   It does **not** mean a wrapper waits. An operation whose route is not live
   yet goes into `endpoints.json` as `status: "planned"`, and is implemented in
   all three wrappers, unit-tested against a mocked transport, and asserted in
   conformance — exactly as §Conformance requires. `status` is the honesty
   mechanism that lets both rules hold at once: the **contract** records what
   the server can serve today, and the **wrappers** stay in lockstep regardless.
   This project is the live example — it implements the whole surface ahead of a
   server whose work is fenced, and marks what is not reachable yet.
2. **Contract second.** Add the operation to `endpoints.json`
   (`status: "required"`) and document it in `docs/endpoints.md` with its wire
   shape and per-language naming. Decide the naming _here_, once, rather than
   three times in three PRs.
3. **Every wrapper third — in one PR.** All lanes move together, in a single
   change against this repo, and conformance runs over every one of them in the
   same CI run. It cannot half-land.

   This used to be "one PR per wrapper repo", three PRs that had to be
   coordinated by hand and each of which was red until the others merged. That
   coordination _was_ the drift risk this document exists to manage: a fourth
   language would have made it four PRs, and the failure mode — an operation
   added to two lanes and forgotten in the third — was only ever caught after
   the fact, by a conformance run in a repo nobody was looking at. Now it is
   caught before merge, in the diff.
4. **Release together.** Bump `VERSION`, tag, ship ([release.md](./release.md)).

## Adding a language

A new language is **a directory in this repo** — `go/`, `dart/`, beside the
three that are here. Not a repo, not a CI bootstrap, not a new set of publish
secrets: a directory, a lane in the existing workflow, and a conformance test.

That is the whole point of the layout, and it is worth being explicit about what
it does _not_ make cheap. A wrapper is still a real commitment, because it makes
step 3 above wider forever: every future operation now has to be written a
fourth time, by someone who knows that language, on the same day. A wrapper that
lags a version behind is worse for its users than no wrapper at all — they will
reasonably assume it is current. The repo layout removes the _ceremony_, not the
obligation.

The bar for a new wrapper joining the lockstep:

- **Every** operation in `endpoints.json` implemented — `required` and `planned`
  alike, per §Conformance — and the conformance test green.
- Its own lane in this repo's CI workflow, running its gates on a path filter,
  and its own publish job on the shared release trigger
  ([release.md](./release.md)).
- Its manifest version written from `VERSION`.

`react/` sits in this repo without meeting this bar because it is a **derived
lane** (§Conformance), not a contract lane — it composes `node/`'s client rather
than implementing `endpoints.json` directly, and that exemption is react's
alone, not a precedent for a contract lane like a prospective `go/` or `dart/`.

Until all three hold **for a would-be contract lane**, keep it out of the
release workflow rather than shipping it half-joined — a derived lane like
`react/` was never bound by this bar to begin with, so it does not apply here.

## Token callback lanes

Contract 0.3.0 added a per-request token supplier, an opt-in one-shot `401`
recovery retry, an `onUnauthorized`/`on_unauthorized` callback, and client-wide
default `headers` (`docs/implementation.md` §2–§3,
[`sdk-surface.md` §1](./sdk-surface.md#1-construction-and-configuration)). This
is a **new axis the conformance runner does not and should not check** — none of
it is an _operation_, so it has no `naming` entry in `endpoints.json` and no row
in `operations[]`. It is recorded here instead, the way §Conformance already
separates "every operation, every lane" from everything else a lane legitimately
differs on (§6 of `sdk-surface.md`).

- **node shares concurrent supplier calls; python does not.** node's `requireToken`
  lets requests in flight at the same time on one config share ONE supplier call
  (dropped on settle, never a cache; `{forceRefresh: true}` never joins it).
  python's sync transport has no concurrent requests to share, so it is unchanged.
- **node and python both carry the callback; the CLI does not.** `W6WClient` and
  `Client` both accept `refreshOnUnauthorized`/`refresh_on_unauthorized`,
  `onUnauthorized`/`on_unauthorized` and a function-typed `token`. `@w6w/cli`
  does not: `cli/src/client.ts`'s `createClient` resolves a single static string
  token once, at startup, from a `--token`-flag, then `W6W_TOKEN`-env, then the
  stored-token (`w6w auth login`) precedence chain with no supplier anywhere in
  it. There is nothing for a `401` recovery attempt to call a second time, and
  a CLI invocation is already a single short-lived process a user re-runs by
  hand, which is a different failure-recovery story than a long-lived server process holding a client
  across many calls. This is a **deliberate, permanent exclusion**, not a gap to
  close later: adding it would mean inventing a CLI-side token-refresh UX (a
  hook with nothing to register it against) for a surface that has none of the
  host-process lifetime this feature exists for. The stored-token tier is
  **CLI-only**: node, python and react never read the CLI's config file, since
  libraries do not read a per-user file the CLI owns. The CLI-only `auth`
  commands are declared in `endpoints.json` `cli.commands[]`, not in
  `operations[]`.
- **python's supplier is sync-only; node's may be sync or async.** R-1 (and
  `sdk-surface.md` §6): there is no `asyncio` anywhere in
  `packages/wrappers/python`, and its transport (`urllib`, blocking) has no
  async counterpart for a supplier to straddle. node's `TokenProvider` may
  return a `Promise`, which `request()` awaits before attaching the bearer;
  python's provider is called and used immediately. A python host with its own
  async token source resolves it _before_ handing the value to a sync callable —
  that resolution is the host's problem, not this package's, exactly like every
  other sync/async boundary `urllib` already draws for this lane.
- **`contractVersion` is unchanged, and `endpoints.json` is not touched at
  all.** `endpoints.json`'s `contractVersion` field tracks the **wire surface**
  — the operations, their shapes, their status — and this task changed none of
  them: `"auth": "bearer"` is still the only auth field any operation declares,
  and the new client options are not `operations[]` entries, so they have no
  `naming` object to add and nothing for a would-be fourth language to implement
  differently. A package-level `VERSION` bump for this change is a separate,
  later step (not part of landing this feature) — recorded here only to say that
  _this_ number, the contract's own, had no reason to move.

## Per-call cancellation (node only)

`CallOptions.signal?: AbortSignal` (R-7) is node-only, and deliberately not in
`endpoints.json`: it is a transport option on the _client_, not a parameter the
_server_ reads, so it does not describe the wire the way every other entry in
this contract does (the §Conformance test walks a built client and would have no
server-side shape to check it against). Every read method `@w6w/react`'s read
hooks call (`client.me`, `documents.list`/`get`/`getByKey`, `vars.list`/`get`,
`connections.list`, `workflows.list`/`get`, `functions.list`/`get`) accepts it,
forwarded to `src/http.ts`'s `request()` and from there straight to the injected
`fetch`'s own `RequestInit.signal` — never serialized into a query string or a
body.

**Python and the CLI have no analog, and this is not an oversight.** `signal`
mirrors a shape every JS runtime's own `fetch` already exposes (`AbortSignal`,
`AbortController`) — it is JS-idiomatic transport plumbing, not a capability the
_API_ grants. Python's `urllib`-based transport has no equivalent object to
thread one through, and a CLI invocation is a single short-lived process with
nothing in-process to cancel a call for — there is no "stale tab-switch request"
for either lane the way there is for a React hook re-rendering. Should a future
python transport (e.g. `httpx`) or a long-running CLI mode want the same thing,
it would need its own idiomatic mechanism (`httpx`'s own cancellation token, a
`SIGINT` handler) rather than a literal `signal` kwarg — unlike the lockstep
version bump (§The version is a shared fact), this axis is expected to stay
permanently node-only, not a gap pending a future PR.

## react's type-only edge onto `@w6w/ui`

`react/`'s `createW6WUiAdapter` targets `@w6w/ui`'s `W6WApi` contract
structurally, with no runtime import of the UI package. Its dev dependency pins
the published `@w6w/ui@0.1.0`, so a standalone checkout and CI install the same
contract without relying on a sibling repository.

`ui-conformance.test.ts` compiles the adapter and workflow converter against the
UI package's public type exports. `adapter-conformance.test.ts` reads member names
from the installed `dist/provider.d.ts`, then checks that every adapter member
exists and forwards requests and errors correctly. Neither check ships in `dist/`.

React remains a derived lane, exempt from the `endpoints.json` naming contract.
To update its UI contract, change the pinned npm version, refresh the lockfile,
and run the React tests and build.

## Console-only credential management

`client.console.credentials.*` (node) manages stored credentials: list, get, create, rename, rotate,
disable, enable, test, dependents, types (`GET /credential-types`, the type descriptors) and delete. It follows the same split as every connection write
op (D-E2): console-only, so `endpoints.json` gains no operation and the count stays 100. cli and
python have no credential commands. The one contract change is read-only and additive:
`ConnectionSummary.credentialId` (`string | null`, `null` = no stored credential) in node, cli (which
reuses node's type) and python, with the contract at `0.13.0`. react's `W6WApi` adapter implements the
eight optional credential members over the console namespace; they are not in
`adapter-conformance.test.ts`'s table, which must equal the pinned `@w6w/ui` member list.

## Connection keep-alive

Contract `0.19.0` is read-only and additive, like `0.13.0`: `ConnectionSummary` gains the optional
`autoRefresh`, `lastRefreshedAt` and `refreshFailingSince` in node, cli (which reuses node's type
and prints them with `connections get`) and python (`None` against an older server). No operation is
added; the count stays 122. The write side is console-only, for the same D-E2 reason: node's
`console.connections.create` / `update` and `console.apps.startOAuthFlow` take `autoRefresh`,
`AuthDef` gains `refreshable` and the manifest's token TTLs, and react's adapter passes
`autoRefresh` through `createConnection` and `startAppOAuthFlow`. The `422 credential_invalid`
sign-in refusal carries `error.hookCode`, read from `ApiError.raw` in every lane; no lane adds an
error field.

## Data stores

Contract `0.15.0` adds the 14 `dataStores.*` operations, taking the contract from 107 to 121
operations. They are stable (`operations[]`), not `console.*`, so node, cli and python all
implement them and §Conformance covers them. The names are `dataStores.*` and
`dataStores.entries.*`; the cli verbs are `data-stores <verb>` and `data-stores entry-<verb>`.

- **react** stays a derived lane: 13 hooks wrap `client.dataStores.*` (five read hooks and eight
  mutation hooks), and none has a route of its own. There is no hook for `exportCsv`.
- **No adapter method.** `createW6WUiAdapter` gains no `listDataStores`: the pinned `W6WApi` has no
  such member, and the adapter has no `listModelRoutes` either.
- **CSV is text mode.** `importCsv` declares `bodyEncoding: "csv"` and `exportCsv`
  `responseEncoding: "text"`. node and python carry the string verbatim, with `content-type: text/csv`
  on import, and never JSON-encode or JSON-parse it. See `implementation.md`.

## Server-only helpers

Server-only helpers (`@w6w/sdk/server`'s `exchangeToken` and `createEmbedSessionClient`;
`w6w.server`'s `exchange_token` and `EmbedSessionClient`) live outside `endpoints.json`
and are exempt from §Conformance. They are still lockstep: node and python ship them
together at the shared `VERSION`. The CLI deliberately has none: such a command would
hold the tenant client secret in an end-user tool. React is a derived lane wrapping
`@w6w/sdk` and is unchanged; it receives the browser-safe session object from the
host's own backend route. The surface is recorded in
[`sdk-surface.md`](./sdk-surface.md) "Server-only subpath".
