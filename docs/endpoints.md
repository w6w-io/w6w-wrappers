# Endpoint catalog

The operations every wrapper must support, at the current `VERSION`. The
machine-readable form is [`../endpoints.json`](../endpoints.json); this document
is the human one. They must agree; nothing checks the prose automatically, so a
change to either is hand-synced into the other (the node conformance test pins
the operation count and the `naming` entries, not this file).

The cross-language _implementation_ rules that sit behind this catalog — types,
error model, env handling, toolchains, conformance runner — are pinned in
[implementation.md](./implementation.md). This file says _what the API is_; that
file says _how three languages must render it identically_.

## Conventions

**Base URL.** All routes live at the **root** of the API's host — `main.ts`
mounts the router at `/`, because the host already says "api" and
`api.w6w.io/api/vars` reads as a mistake. A wrapper takes an **origin** like
`https://api-s2.w6w.dev` and appends **nothing**: `basePath` is `""` as of
contract 0.2.0. The exact join rule (strip trailing slashes, preserve any
configured path) is pinned in
[implementation.md §2](./implementation.md#2-configuration-and-environment).
With no base URL given, a wrapper targets `https://api.w6w.io` — the
`defaultBaseUrl` field of `endpoints.json`, one constant per lane.

> **Breaking, 0.1.x → 0.2.0.** `basePath` was `/api`. A client still pointed at
> `https://api.w6w.io/api` will 404 on every call; drop the suffix from
> `W6W_BASE_URL`. The wrappers do not strip it for you — a path is preserved
> verbatim, because it is indistinguishable from a real gateway prefix.

**Auth.** `Authorization: Bearer <token>`. Every route below requires it; there
are no anonymous operations in this surface.

**Errors.** The API returns a consistent envelope:

```json
{ "error": { "code": "unknown_workflow", "message": "Not registered." } }
```

Wrappers map this to an idiomatic raised error carrying `code`, `message`, the
HTTP status and the raw body — see
[implementation.md §3](./implementation.md#3-error-model). Never surface a raw
HTTP client error to the caller.

**Statuses that are not errors.** A `202` (queued/still-running run) is a
success, and a run that comes back `200` with `status: "failed"` is **data**,
not an exception. See
[implementation.md §4](./implementation.md#4-outcomes-that-are-not-errors).

**Addressing.** Assets are created by their human-chosen `key`/`name` and
updated or deleted by their server-issued `doc_…`/`var_…` id — the wrapper
mirrors the server exactly (D6). Read-by-key exists only where the server offers
a `by-key`/`by-name` route; there is **no client-side list-then-filter** in any
wrapper (D12, and `README.md` "What a wrapper is").

**What this file does not cite.** Route behaviour below is described and dated,
never traced to a file and line inside the server. The host is closed (STRATEGY
§5.1) and naming its handlers by path would tell a reader of this package
nothing it can act on — see the note at the top of
[implementation.md](./implementation.md), which applies here identically. Verify
a claim against the API, not against a path you cannot open.

**Binary bodies.** Every operation is JSON in and JSON out unless it says
otherwise. Two optional fields on an `endpoints.json` operation (added at
contract `0.11.0`) opt a route into raw bytes:

- `bodyEncoding: "octet-stream"` — the request body is the caller's bytes, sent
  as-is with `content-type: application/octet-stream`. Never JSON-encoded,
  quoted or base64'd. The wrapper takes `Uint8Array` (node/cli) or `bytes`
  (python) and hands them to the HTTP client untouched.
- `responseEncoding: "octet-stream"` — a **successful** response body is the
  payload, returned unmodified as `Uint8Array` / `bytes`. It is never decoded as
  text or JSON, so bytes that are not valid UTF-8 (`\xff\xfe\x00`) survive.

Byte mode changes only the _success_ path. A non-2xx response on a byte route is
still the JSON error envelope and raises the same typed error with its `code`
(implementation.md §3); an operation that declares neither field behaves exactly
as before. The two fields are independent: `assets.uploads.putEntry` declares
only `bodyEncoding`, `assets.content` and `assets.archiveDownload` only
`responseEncoding`.

**Text bodies.** Contract `0.15.0` adds one value of each field for text routes
(CSV), with the same success-path-only rule:

- `bodyEncoding: "csv"` — the request body is the caller's string, sent verbatim
  with `content-type: text/csv`. Never JSON-encoded or quoted. Declared only by
  `dataStores.importCsv`.
- `responseEncoding: "text"` — a **successful** response body is returned
  verbatim as a string, never JSON-parsed (a CSV body that happens to parse as
  JSON stays a string). Declared only by `dataStores.exportCsv`.

The mode is chosen by the explicit option alone, never by the argument's type: a
string body without `bodyEncoding` is still JSON-encoded (implementation.md §3,
"Text-mode (CSV) requests").

The encoded operations are exactly: `assets.uploads.putEntry` (`bodyEncoding:
"octet-stream"`), `assets.content` and `assets.archiveDownload`
(`responseEncoding: "octet-stream"`), `dataStores.importCsv` (`bodyEncoding:
"csv"`) and `dataStores.exportCsv` (`responseEncoding: "text"`).

**Naming.** Operation names in `endpoints.json` are the contract. Each language
renders them in its own idiom but the mapping is mechanical and must not drift.
This table is generated from each operation's `naming` entry and must match it
character-for-character:

| Operation            | Node / CLI (TS)                             | Python                                                                                   | CLI command                                                                                        |
| -------------------- | ------------------------------------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `me`                 | `client.me()`                               | `client.me()`                                                                            | `w6w me`                                                                                           |
| `connections.list`   | `client.connections.list()`                 | `client.connections.list()`                                                              | `w6w connections list`                                                                             |
| `workflows.list`     | `client.workflows.list(opts?)`              | `client.workflows.list(project=None, tag=None)`                                          | `w6w workflows list [--project <id>] [--tag <tag>]`                                                |
| `workflows.run`      | `client.workflows.run(id, opts?)`           | `client.workflows.run(id, wait=False, variables=None, trigger=None, input=None, allow_unpublished=False, entry=None)`         | `w6w workflows run <id> [--wait] [--input <json>] [--entry <value>]` |
| `documents.list`     | `client.documents.list(opts?)`              | `client.documents.list(project=None)`                                                    | `w6w documents list [--project <id>]`                                                              |
| `documents.get`      | `client.documents.get(id, opts?)`           | `client.documents.get(id, project=None)`                                                 | `w6w documents get <id> [--project <id>]`                                                          |
| `documents.getByKey` | `client.documents.getByKey(key, opts?)`     | `client.documents.get_by_key(key, project=None)`                                         | `w6w documents get-by-key <key> [--project <id>]`                                                  |
| `documents.create`   | `client.documents.create(input, opts?)`     | `client.documents.create(key, content, format=None, description=None, project=None)`     | `w6w documents create <key> --content <text> [--format <f>] [--description <d>] [--project <id>]`  |
| `documents.update`   | `client.documents.update(id, patch, opts?)` | `client.documents.update(id, content=None, format=None, description=None, project=None)` | `w6w documents update <id> [--content <text>] [--format <f>] [--description <d>] [--project <id>]` |
| `documents.delete`   | `client.documents.delete(id, opts?)`        | `client.documents.delete(id, project=None)`                                              | `w6w documents delete <id> [--project <id>]`                                                       |
| `vars.list`          | `client.vars.list()`                        | `client.vars.list()`                                                                     | `w6w vars list`                                                                                    |
| `vars.get`           | `client.vars.get(id)`                       | `client.vars.get(id)`                                                                    | `w6w vars get <id>`                                                                                |
| `vars.getByName`     | `client.vars.getByName(name)`               | `client.vars.get_by_name(name)`                                                          | `w6w vars get-by-name <name>`                                                                      |
| `vars.create`        | `client.vars.create(input)`                 | `client.vars.create(name, type, value, description=None)`                                | `w6w vars create <name> --type <t> --value <v> [--description <d>]`                                |
| `vars.update`        | `client.vars.update(id, patch)`             | `client.vars.update(id, type=None, value=None, description=None)`                        | `w6w vars update <id> [--type <t>] [--value <v>] [--description <d>]`                              |
| `vars.delete`        | `client.vars.delete(id)`                    | `client.vars.delete(id)`                                                                 | `w6w vars delete <id>`                                                                             |
| `functions.run`      | `client.functions.run(name, opts?)`         | `client.functions.run(name, payload=None)`                                               | `w6w functions run <name> [--payload <json>]`                                                      |
| `endpoints.list`     | `client.endpoints.list(opts?)`              | `client.endpoints.list(tag=None)`                                                        | `w6w endpoints list [--tag <tag>]`                                                                 |
| `endpoints.run`      | `client.endpoints.run(name, opts?)`         | `client.endpoints.run(name, payload=None)`                                               | `w6w endpoints run <name> [--payload <json>]`                                                      |
| `run`                | `client.run(input)`                         | `client.run(urn, action=None, payload=None)`                                             | `w6w run <urn> [--action <a>] [--payload <json>]`                                                  |

`me` additionally registers **`w6w info`** as a CLI alias (`cliAlias` in
`endpoints.json`, D8) — same operation, second spelling, so the word used in the
intake keeps working at the command line.

Every CLI command must also answer `--help` at group and command level,
generated from `endpoints.json` — see [cli.md](./cli.md).

**Status field.** `endpoints.json` holds ninety-three operations, all of them
`"status": "required"` (the six `team.*` operations' `/me/account/...` routes
are live server-side). Changing `status` regenerates the CLI's help (see
[cli.md](./cli.md)). This catalog does not yet describe the `team.*` wire
shapes; `endpoints.json`'s own `notes` for them are the reference until it does.
`documents.getByKey`, `vars.getByName` and `run` were implemented server-side
2026-07-28; `me` was fixed the same day to call the server's real `/auth/me`
route directly rather than wait on a never-built `/me` alias. `me`'s
`serverImplemented` is `true` since contract 0.15.1: the server sends
`versions: {server, composition}` on `GET /auth/me`, and every wrapper still
tolerates the block being absent (an older server). `status` records **server** readiness, not wrapper obligation — all
fifty-one are implemented and tested against a mocked transport in every wrapper
(see [implementation.md §10](./implementation.md#10-conformance-runner)).

---

## 1. `me` — caller identity and versions

```
GET /auth/me
```

`status: required` · `serverImplemented: true`

**Fixed 2026-07-28.** Every wrapper calls `/auth/me` directly — the server's
real, already-live identity route (verified live: `200`,
`{tenant, subject, account, role}`) — rather than waiting on the never-built
`/me` alias D15 originally specced. Its live consumer is the studio's Session
modal.

**Versions:** the server sends `versions.server` (the deployment's image
version, = `GET /version`'s `version`) and `versions.composition` (=
`GET /version`'s `composition`). Every wrapper tolerates the block being absent
and fills in `versions.wrapper` itself (below).

Returns who the caller is, plus the versions of the w6w components involved in
answering the call. The version block is the reason this operation earns its
place in a minimal surface: it is what makes a bug report actionable.

**Response `200`** — the body is **flat**. There is no wrapping object around
the identity fields; a nested envelope would need a second identity handler or
would break the studio (D15).

```json
{
  "tenant": "default",
  "subject": "user_01H…",
  "account": "default",
  "role": "admin",
  "versions": {
    "server": "1.2.3",
    "composition": "core:a11a7ca,server:1a2b3c4",
    "wrapper": "0.1.0"
  }
}
```

The four identity fields mirror the server's `Principal`.

`versions` is **optional and additive**:

- A wrapper must tolerate it being **absent entirely** (an older server), and
  must tolerate **unknown keys inside it** — the set will grow, and adding one
  must never break an older client. Model it as a string→string map, not as a
  closed struct.
- `versions.server` is the deployment's **image version** (the same string
  `GET /version` returns as `version`).
- `versions.composition` is a **build string** (the same string `GET /version`
  returns as `composition`) derived at build time from the
  composition the deploy workflow already computes, and is the literal string
  `"dev"` when that build arg is absent (D5).
- `versions.wrapper` is filled in **client-side** by the wrapper from its own
  package version — the server cannot know it.
- **Precedence on collision is server-wins.** The wrapper's own version is a
  **default** that any key the server supplied **overrides**. Concretely
  `{ wrapper: VERSION, ...body.versions }` in TypeScript,
  `{"wrapper": VERSION, **(body.get("versions") or {})}` in Python. Do **not**
  write the other order (`{**server, "wrapper": VERSION}`), which would make the
  wrapper's own value win: both readings satisfied the older wording, they
  differ observably, and this is the one field a bug report is read off — so it
  is pinned here rather than decided three times.
- **`versions` never _displays_ a literal `0.0.0`** (D5). Hand-maintained
  component version numbers are unreliable (`0.0.0`/`0.0.1` placeholders nobody
  bumps), and a banner that looks authoritative while reporting `0.0.0` forever
  is worse than one that honestly says `"dev"`. If a resolved value is `0.0.0`
  or the empty string, the wrapper presents `"dev"` instead.
- **The two rules above are independent and do not conflict**, because they act
  at different layers. _Server-wins_ governs the **value carried** in the
  returned object, which stays a faithful transcription of the wire.
  _Never-display-`0.0.0`_ governs what a banner such as `w6w info` **prints**.
  So a server that sends `versions.wrapper: "0.0.0"` is carried through
  unaltered in the data and rendered to the user as `dev` — one precedence rule,
  one display rule, and no lane inventing a third.

### Server work still required

One thing, and it is optional by construction: add the `versions` block, sourced
from the build-time composition string. Keep it cheap — this route is called on
every CLI invocation for the version banner, so it must not touch the catalog or
do per-request version discovery. Until it lands, every wrapper returns a
`versions` map carrying only its own `wrapper` entry, which is the contracted
behaviour and not a degraded one.

The `/me` alias this section used to ask for is **not** being built: the
wrappers call `/auth/me` directly instead (see above), which is one fewer route
to keep in step for no loss of anything.

**Since `0.18.0`** the body may carry `capabilities: { userScopedCredentials?: boolean }`; gate on `=== true` (absent means an older server).

---

## 2. `connections.list` — list connections

```
GET /connections
```

`status: required` · served today

Lists the calling principal's connections, scoped by tenant/account. Credentials
are never included — the server returns a redacted projection.

**Response `200`** — envelope key `connections`; the wrapper unwraps and returns
the array. Since `0.18.0` each row may carry `accessScope: "account" | "user"` (absent
means an older server; `subject` stays creator attribution). The server-side
`?accessScope=` filter exists but is not a param of this op in `0.18.0`.

Since `0.19.0` each row may also carry its keep-alive state, none of it secret:
`autoRefresh: boolean` (background credential refresh on or off; the server
defaults it to `true`), `lastRefreshedAt: string | null` (ISO; the last successful
refresh, or when the connection was made; `null` when unknown) and
`refreshFailingSince: string | null` (ISO; when the current streak of failing
background refreshes began; `null` when refresh is not failing). All three are
absent from an older server and from the synthetic `builtIn` row, so the wrappers
type them optional. `state` is unchanged as a union, but `broken` is now also set
at once when a refresh is refused in a way that needs a new sign-in, and after
background refreshes have failed for 3 days.

```json
{
  "connections": [
    {
      "id": "conn_01H…",
      "appId": "sendgrid",
      "authKey": "api_key",
      "tenant": "default",
      "subject": "user_01H…",
      "displayName": "Marketing SendGrid",
      "state": "connected",
      "profile": {},
      "lastTestOk": true,
      "lastTestedAt": "2026-07-20T09:14:00.000Z",
      "autoRefresh": true,
      "lastRefreshedAt": "2026-07-19T03:00:00.000Z",
      "refreshFailingSince": null,
      "createdAt": "2026-07-01T12:00:00.000Z",
      "updatedAt": "2026-07-20T09:14:00.000Z",
      "credentialId": "cred_01H…",
      "app": {
        "displayName": "SendGrid",
        "iconSvg": "data:image/svg+xml;base64,…",
        "iconSvgDark": "data:image/svg+xml;base64,…",
        "brandColor": "#1A82E2",
        "brandColorDark": "#51A9F0"
      }
    }
  ]
}
```

`app` is the connection's app, inlined as a top-level sibling of `appId` (never
flattened into the row), so a list needs no second fetch for names and icons.
Only `displayName` is always present inside it. `app` is `null` when the server
found no app row, and absent from an older server; the TypeScript wrappers keep
those two apart, Python reads both as `None`.

`credentialId` (contract `0.13.0`) is the id of the stored credential the
connection uses. It is `string | null`, and `null` means no stored credential
(tenantAuth, jit, none, or a zero-credential row). It is additive and
read-only here: creating and managing credentials is console-only
(`client.console.credentials.*`, see [parity.md](./parity.md)), so this contract
gains no credential operation.

Shape is `ConnectionSummary` (fields pinned in
[implementation.md §5](./implementation.md#5-wire-types)) — the stored
connection minus `credential`, which is redacted server-side. Wrappers must not
define a type that includes `credential` on a list result — do not invite
callers to look for a field that will never arrive. (`lastRefreshedAt` was listed
as redacted here before contract `0.19.0`; it is a non-secret timestamp and the
server now sends it.)

Kept in v0.1.0 (D4) because without it a user has no way to discover a `conn_…`
URN to pass to [`run`](#17-run--run-anything-addressable-by-urn).

---

## 3. `workflows.list` — list workflows

```
GET /workflows[?project=<id>][&tag=<tag>]
```

`status: required` · served today

Lists the caller's workflow definitions. The optional `project` query filters to
one project; wrappers expose it as an optional argument.

The optional `tag` query narrows the list: a row is kept when one of its tags equals
the value or starts with the value plus `.` (segment-bounded: `action.order` matches
`action.order` and `action.order.confirm`, not `action.orders`). Wrappers send
`?tag=` only when a non-blank tag was given; a single value, no multi-tag OR.

**Response `200`** — envelope key `workflows`; the wrapper unwraps.

```json
{
  "workflows": [
    {
      "id": "wf_01H…",
      "key": null,
      "name": "welcome-email",
      "displayName": "Welcome Email",
      "description": "Sends a welcome email on signup.",
      "status": "active",
      "tags": ["onboarding"],
      "runCount": 412,
      "updatedAt": "2026-07-22T18:03:00.000Z"
    }
  ]
}
```

Shape is `WorkflowSummary`. `status` is `draft | active`. `updatedAt` is
serialized from a `Date` and arrives as an ISO-8601 **string** over the wire, in
every language — see [implementation.md §5](./implementation.md#5-wire-types)
for the timestamp rule.

This endpoint is **not paginated today**. Wrappers must still return a list type
that can grow a cursor later without a breaking change.

Kept in v0.1.0 (D4): it is how a user discovers a `wf_…` URN to pass to `run`.

---

## 4. `workflows.run` — trigger a workflow

```
POST /workflows/:id/run[?wait=true]
```

`status: required` · served today

Enqueues a run. This is asynchronous by default: the server returns immediately
and the run queue executes it.

**Request body** (all fields optional)

```json
{
  "variables": { "email": "a@b.com" },
  "trigger": "manual",
  "input": { "email": "a@b.com" }
}
```

| Field       | Required | Notes                                                                                                                                                                                            |
| ----------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `variables` | no       | Object merged into the run's **variable scope**, read by downstream expressions as `vars.*`.                                                                                                     |
| `trigger`   | no       | A **string**, not an object. Defaults to `manual` server-side when omitted.                                                                                                                      |
| `input`     | no       | Object delivered to the **entry trigger node's own recorded output**, read by downstream nodes as `nodes.<triggerId>.output.<key>` (`steps.<triggerId>.output.<key>` is the permanent alias for the same value) — this is the field that reaches a trigger's declared fields. |
| `allowUnpublished` | no | Boolean. Run the **stored** definition even if it was never published (the draft run; a disabled one is still refused). Sent **only when `true`**; it runs the row as last saved, never a submitted body, so save first. Without it the run needs a published workflow (`409 workflow_not_published`); a disabled workflow is refused either way (`409 workflow_disabled`). |

**What a plain run executes.** Without `allowUnpublished`, `run` still executes the **stored** definition
as last saved — publishing is a precondition (the workflow must have at least one published version), not a
selector. Edits saved after a publish are what the next plain `run` executes. To execute exactly what was
published, call `runVersion(id, n)`.

**`variables` and `input` are not interchangeable, and reach the workflow
differently.** `variables` seeds the run's variable scope; a node reads it as
`vars.email`. `input` is injected into the entry trigger node's own output; a
node reads it as `nodes.<triggerId>.output.email` (or through the `steps.`
alias, which addresses the same object). A trigger's declared fields are only
ever reachable through `input` — passing them as `variables` puts them in the
wrong scope and they never arrive where the workflow expects them.

**`trigger` is a plain string.** The server reads it as `RunTrigger`, whose
known values today are `manual`, `schedule`, `webhook`, `event` and `replay`.
Those five are recorded in `endpoints.json` under `knownValues` (with
`closedEnum: false`) as **documentation only**: every wrapper types the
parameter as an open string (`trigger?: string`, `trigger: str | None`) and
passes it through **unvalidated**. A wrapper that hard-codes the five would
reject a request the server accepts the day a sixth value lands, and would need
a release to catch up.

**Response `202`** — queued (default, no `wait`)

```json
{ "runId": "run_01H…", "status": "queued" }
```

**Response `200`** — with `?wait=true`, if the run reached a terminal state

```json
{
  "runId": "run_01H…",
  "status": "succeeded",
  "output": {},
  "error": null,
  "nodes": {},
  "steps": {}
}
```

**Response `202`** — with `?wait=true`, if it timed out still running

```json
{ "runId": "run_01H…", "status": "running" }
```

`nodes` is the per-node state keyed by node id; `steps` is its alias, carrying
identical records, so read either. A failed node's error carries `nodeId`, with
`stepId` beside it holding the same id. A `202` carries neither map — the
wrappers normalise `nodes` to `{}` rather than leaving it absent.

**Response `404`** — `{ "error": { "code": "unknown_workflow", … } }` ·
**Response `400`** — `invalid_body` (unparseable JSON body).

Success statuses: **`200` and `202`**. Unlike every other operation here, the
response is **not** wrapped in an envelope key — the run fields are the body.

### The wait semantics matter

`?wait=true` polls **server-side** up to `RUN_WAIT_TIMEOUT_SEC` and then gives
up, returning `202` with whatever status it has. **A `202` from a waited call is
not a failure and not a timeout error** — the run is still going. Wrappers must
not raise on it. The distinction callers need is `status`, not the HTTP code, so
the wrapper's return type must expose `status` prominently and treat 200 and 202
identically.

A run that _failed_ also comes back `200` with `status: "failed"` and an `error`
in the envelope — a run-level failure is data, not an HTTP error. Do not map it
to a raised exception.

Wrappers expose wait as an option: `run(id, { wait: true })`,
`run(id, wait=True)`, `w6w workflows run <id> --wait`.

**No wrapper implements client-side run polling.** The server's `?wait=true` is
the mechanism; re-implementing a poll loop in three languages is exactly the
duplication this contract exists to prevent
([implementation.md §8](./implementation.md#8-do-not-carry-over)).

Kept alongside the unified `run` (D4), which is deliberately narrower: `?wait=`,
`variables`, `trigger` and `input` have no slot in the three-field
`{urn, action, payload}` shape.

### Companion: fetching a run

`GET /runs/:id` exists and returns run state. It is **not** part of this
version's contract (`runs.get` is in `outOfScope`). Prefer the server's
`?wait=true` and add `runs.get` as a first-class operation in a later version —
added to `endpoints.json` and shipped in all three at once, like everything
else.

---

## 5. `documents.list` — list documents

```
GET /documents[?project=<id>]
```

`status: required` · served today

Documents **are** project-scoped: every `documents.*` route accepts an optional
`?project=` and otherwise resolves the account's default project. An unknown
project id is `400 unknown_project`.

**Response `200`** — envelope key `documents`; the wrapper unwraps and returns
the array.

```json
{
  "documents": [
    {
      "id": "doc_01H…",
      "key": "welcome-email-copy",
      "content": "# Welcome\n\nGlad you're here.",
      "format": "markdown",
      "description": "Body copy for the signup email.",
      "createdAt": "2026-07-01T12:00:00.000Z",
      "updatedAt": "2026-07-22T18:03:00.000Z"
    }
  ]
}
```

---

## 6. `documents.get` — fetch a document by id

```
GET /documents/:id[?project=<id>]
```

`status: required` · served today

Addressed by the server-issued `doc_…` id, **not** by `key` (D6 — wrappers
mirror the server's addressing exactly).

**Response `200`** — envelope key `document`; the wrapper unwraps and returns
the object.

```json
{
  "document": {
    "id": "doc_01H…",
    "key": "welcome-email-copy",
    "content": "…",
    "format": "markdown",
    "description": "…",
    "createdAt": "…",
    "updatedAt": "…"
  }
}
```

**Response `404`** — `{ "error": { "code": "unknown_document", … } }`

---

## 7. `documents.getByKey` — fetch a document by key

```
GET /documents/by-key/:key[?project=<id>]
```

`status: required` · `serverImplemented: true` — implemented 2026-07-28.

The route trims the incoming key to match what `POST /documents` stores
(`key.trim()`), so a caller who round-trips a key exactly as returned always
finds it. Creation also rejects a key of exactly `.` or `..` — the one class no
HTTP client can round-trip through a URL path segment: `.` is unreserved (so
percent-encoding it is a no-op), and both collapse under RFC 3986 dot-segment
removal before the request is even sent — one client's normalizer turns
`by-key/..` into the **list** route, another sends it literally. Excluding the
two values at creation means `by-key/:key` never has to disambiguate an
unrepresentable key.

D12 (amending D6): a user who chose a key should be able to address by it, and
the alternative leaks internal `doc_…` ids to users who never saw them. **No
client-side list-then-filter** — `README.md` "What a wrapper is" forbids
composing two calls to make an operation useful. If the fence never clears,
wrappers ship id-addressed only and the limitation is documented.

Same envelope (`{ "document": … }`) and same `404 unknown_document` as
[`documents.get`](#6-documentsget--fetch-a-document-by-id).

---

## 8. `documents.create` — create a document

```
POST /documents[?project=<id>]
```

`status: required` · served today

**Request body**

```json
{
  "key": "welcome-email-copy",
  "content": "# Welcome\n\nGlad you're here.",
  "format": "markdown",
  "description": "Body copy for the signup email."
}
```

| Field         | Required | Notes                                                                                                                          |
| ------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `key`         | yes      | Non-empty string, **≤ 128 characters**, unique per scope + project. Create is addressed by `key` (D6).                         |
| `content`     | yes      | Raw text. Stored verbatim and **never parsed**.                                                                                |
| `format`      | no       | One of `text` \| `markdown` \| `yaml` \| `html` \| `json`. Defaults to `text`. A **hint only** — it does not gate the content. |
| `description` | no       | Free text.                                                                                                                     |

**Response `201`** — envelope key `document`; the wrapper unwraps.

**Response `409`** — `{ "error": { "code": "document_exists", … } }` on a
duplicate key. Wrappers must surface that code, not swallow it into a generic
error. **Response `400`** — `unknown_project` for an unknown `?project=`.

---

## 9. `documents.update` — patch a document

```
PATCH /documents/:id[?project=<id>]
```

`status: required` · served today

Addressed by the `doc_…` id, **not** by `key` (D6). `key` itself is
**immutable** — it is not in the patch body.

**Request body** (every field optional; an omitted field is left alone)

```json
{ "content": "…", "format": "markdown", "description": "…" }
```

**Response `200`** — envelope key `document`. **Response `404`** —
`unknown_document`.

---

## 10. `documents.delete` — delete a document

```
DELETE /documents/:id[?project=<id>]
```

`status: required` · served today

Addressed by the `doc_…` id (D6).

**Response `200`** — `{ "ok": true }`. The wrapper unwraps this to _nothing_ —
it returns no value; there is no payload to hand back. The declared return in
`endpoints.json` is therefore **`void`**, not an `Ok` object: `Promise<void>` in
TypeScript, `None` in Python, no stdout payload in the CLI beyond its exit code.
`Ok` is not a public wrapper type — see
[implementation.md §5](./implementation.md#5-wire-types).

**Response `404`** — `unknown_document`. Deleting an unknown id is an error, not
a silent success — the delete is **not idempotent** and wrappers must not
pretend otherwise.

---

## 11. `vars.list` — list variables

```
GET /vars
```

`status: required` · served today

**Vars are NOT project-scoped.** Unlike documents, no `vars.*` route accepts
`?project=` — they are scoped by tenant/subject only. Do not add a `project`
option to any `vars.*` signature; adding one later would be additive, faking one
now would be a lie the server does not honour. The asymmetry is deliberate and
contracted — see [implementation.md §7](./implementation.md#7-asset-addressing).

**Response `200`** — envelope key `vars`; the wrapper unwraps and returns the
array.

```json
{
  "vars": [
    {
      "id": "var_01H…",
      "name": "sender_email",
      "type": "string",
      "value": "hello@example.com",
      "description": "From address for onboarding mail.",
      "createdAt": "2026-07-01T12:00:00.000Z",
      "updatedAt": "2026-07-22T18:03:00.000Z"
    }
  ]
}
```

---

## 12. `vars.get` — fetch a variable by id

```
GET /vars/:id
```

`status: required` · served today

Addressed by the server-issued `var_…` id, not by `name` (D6).

**Response `200`** — envelope key **`var`** (singular); the wrapper unwraps.
Note `var` is a reserved word in TypeScript: read it as a property
(`body["var"]` / `body.var`), never destructure it into a binding of that name.

```json
{
  "var": {
    "id": "var_01H…",
    "name": "sender_email",
    "type": "string",
    "value": "hello@example.com",
    "description": "…",
    "createdAt": "…",
    "updatedAt": "…"
  }
}
```

**Response `404`** — `{ "error": { "code": "unknown_var", … } }`

---

## 13. `vars.getByName` — fetch a variable by name

```
GET /vars/by-name/:name
```

`status: required` · `serverImplemented: true` — implemented 2026-07-28.

Names are already regex-validated (`[A-Za-z_][A-Za-z0-9_]*`) at create time, which is
URL-safe by construction — unlike documents' free-form `key`, no dot-segment
hazard exists here and no extra normalization is needed.

D12: key-addressed reads become server routes rather than client-side
composition. No list-then-filter workaround. If the fence never clears, wrappers
ship id-addressed only and the limitation is documented.

Same envelope (`{ "var": … }`) and same `404 unknown_var` as
[`vars.get`](#12-varsget--fetch-a-variable-by-id).

---

## 14. `vars.create` — create a variable

```
POST /vars
```

`status: required` · served today

**Request body**

```json
{
  "name": "sender_email",
  "type": "string",
  "value": "hello@example.com",
  "description": "From address for onboarding mail."
}
```

| Field         | Required | Notes                                                                |
| ------------- | -------- | -------------------------------------------------------------------- |
| `name`        | yes      | Must match `^[A-Za-z_][A-Za-z0-9_]*$` (case-sensitive). Create is addressed by `name` (D6). |
| `type`        | yes      | One of `string` \| `number` \| `boolean` \| `json`.                  |
| `value`       | yes      | Validated **server-side** against `type`.                            |
| `description` | no       | Free text.                                                           |

**Response `201`** — envelope key `var`; the wrapper unwraps.

**Errors** — `400 invalid_name` (name rule violated), `400 invalid_type`,
`400 invalid_value` (value does not match the declared type), `409 var_exists`
(duplicate name — surface the code, do not swallow it).

No `project` param: vars are not project-scoped.

---

## 15. `vars.update` — patch a variable

```
PATCH /vars/:id
```

`status: required` · served today

Addressed by the `var_…` id, **not** by `name` (D6). `name` itself is
**immutable** — it is not in the patch body.

**Request body** (every field optional)

```json
{ "type": "string", "value": "new@example.com", "description": "…" }
```

A `value` sent **without** a `type` is validated against the variable's
**existing** type.

**Response `200`** — envelope key `var`. **Response `404`** — `unknown_var`. No
`project` param.

---

## 16. `vars.delete` — delete a variable

```
DELETE /vars/:id
```

`status: required` · served today

Addressed by the `var_…` id (D6).

**Response `200`** — `{ "ok": true }`; the wrapper returns no value. The
declared return in `endpoints.json` is **`void`**, not an `Ok` object:
`Promise<void>` in TypeScript, `None` in Python, no stdout payload in the CLI
beyond its exit code (`Ok` is not a public wrapper type — see
[implementation.md §5](./implementation.md#5-wire-types)). **Response `404`** —
`unknown_var`. Not a silent success. No `project` param.

---

## 17. `functions.run` — run a Function by name

`POST /functions/{idOrKey}/invoke` → `200`

```ts
const output = await client.functions.run("send-email", {
  payload: { to: "ada@example.com", subject: "Hi" },
});
```

**The name is the first argument**, matching `workflows.run(id, opts?)`, so all
three runnable kinds read alike. It is not a field inside an options object.

**The slot takes an id OR a key**, with no prefix, flag or tag to say which. The
two shapes cannot collide: an id carries a kind prefix and therefore an
underscore (`fn_…`), while a key is a kebab-slug that forbids one. Resolution is
id-first — a pure prefix test with no query — so this path cannot be used to
probe whether a key exists by supplying something id-shaped.

**Wrappers spell the body field `payload`** even though the wire spells it
`inputs`. One word across every runnable kind; reconciling the wire's
inconsistency is exactly what a wrapper is for (the Endpoint operation below
spells the same concept `input`).

**Returns the OUTPUT, not an envelope.** The unified `run` is kind-discriminated
because the caller does not know what a URN will resolve to; here the kind is
settled by the operation name, so a discriminant would be a field the caller
unwraps to learn nothing.

The wire body carries the **invocation frame** (`invocationId`, `status`,
`startedAt`, `finishedAt`, `durationMs`) alongside `output`, exactly as the
unified `run` does — see §19. Since this operation's contract is "hand back the
Function's output", a wrapper keeps unwrapping `output` and needs no change; the
frame is there for a caller who reads the raw response, and the `invocationId`
in it resolves through `GET /invocations/{id}`.

**Draft run.** `allowUnpublished: true` in the options runs the **stored**
definition even if it was never published (a disabled one is still refused). It is sent in the
body only when `true`, and it executes the row exactly as last saved — never a
definition passed in the call — so save first. Without it the call needs a
published Function (`422 function_not_published`); a disabled Function is refused either way (`422 function_disabled`).

**What a plain run executes.** Without `allowUnpublished`, `run` still executes the **stored** definition
as last saved — publishing is a precondition (the Function must have at least one published version), not a
selector. Edits saved after a publish are what the next plain `run` executes. To execute exactly what was
published, call `runVersion(id, n)`.

**A `null` output is a successful run**, not a malformed body: a Function's
output is an opaque pass-through, and an action that returns nothing yields
`{"output": null}`. Wrappers must guard on **presence** of the `output` key
rather than on its truthiness — the shared "unwrap this envelope key" helper
each lane carries rejects null and is the wrong tool here.

| Failure                                 | Status | Code                  |
| --------------------------------------- | ------ | --------------------- |
| No Function of that name for the caller | `404`  | `unknown_function`    |
| The Function has no runnable `impl`     | `422`  | `function_incomplete` |

Two unknown **keys** answer identically and neither is echoed back — a key is
short, human-chosen and guessable, so echoing it would make this an enumeration
oracle. An unknown **id** may still be echoed; nobody guesses a uuid.

## 18. `endpoints.run` — run an Endpoint by name

`POST /endpoints/{idOrKey}/invoke` → `200` | `202`

```ts
const envelope = await client.endpoints.run("send-email", { payload: { to } });
if (envelope.kind === "workflow") console.log(envelope.runId); // the async arm
```

Name-first and id-or-key, exactly as above; the body field is `payload` in every
wrapper though the wire spells it `input` (singular here, plural for a
Function).

**Unlike `functions.run`, this returns the kind-discriminated `RunEnvelope`**,
and the asymmetry is deliberate: an Endpoint dispatches to an app action, a
Function or a Workflow, so only the response says which answered — the
discriminant is information, not ceremony. The workflow arm returns `202`, which
is a **normal outcome, not an error**. Wrappers must tolerate an unknown future
`kind` rather than crashing, the same rule the unified `run` carries.

## 19. `run` — run anything addressable by URN

```
POST /run
```

`status: required` · `serverImplemented: true` — implemented 2026-07-28.
Dispatch lives in a third sibling BLL service, `bll/resolve-run.ts`, mirroring
`InvokeEndpointService`'s shape: every arm calls the same runner an existing
dedicated route already uses (`invokeAction` for `conn_`, the Function choke
point for `fn_`, `enqueueRun` for `wf_`, and `InvokeEndpointService` itself for
`ep_`, delegated verbatim). No new execution path, and core's `Callable` is not
widened — the connection/action arm is a server-only addition to this HTTP
surface.

Every arm resolves the URN with the caller's scope passed **explicitly**: two of
the underlying repos (`FunctionsRepo.load`, `EndpointsRepo.load`) accept an
optional scope and silently drop the tenant/subject predicate when it is omitted
(an ergonomic that exists for the trusted scheduler path) — the resolver never
omits it, and a URN belonging to another tenant resolves to "not found," never
to the resource.

Runs anything addressable by URN: a connection action, a workflow, a function,
or an endpoint.

**Request body**

```json
{
  "urn": "conn_01H…",
  "action": "send_email",
  "payload": { "to": "a@b.com", "subject": "Hi" }
}
```

| Field     | Required | Notes                                                                                                                                                                                                    |
| --------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `urn`     | yes      | Resolves over **four runnable arms only** — `conn_`, `wf_`, `fn_`, `ep_` (D16). `doc_` and `var_` are **not** URN arms in v0.1.0; assets are addressed by the `documents.*` / `vars.*` operations above. |
| `action`  | no       | Optional because a workflow, function or endpoint URN has no action. Required in practice for a `conn_…` URN.                                                                                            |
| `payload` | no       | Input object for the target.                                                                                                                                                                             |

**Response** — a `kind`-discriminated envelope with exactly three arms (D3), the
same shape the endpoint-invoke route already returns, wrapped in the
**invocation frame** the server added on 2026-08-20:

```json
{
  "kind": "action",
  "value": {},
  "output": {},
  "invocationId": "inv_9f1c…",
  "status": "succeeded",
  "startedAt": "2026-08-20T09:14:02.401Z",
  "finishedAt": "2026-08-20T09:14:02.826Z",
  "durationMs": 425
}
```

```json
{
  "kind": "function",
  "output": {},
  "invocationId": "inv_…",
  "status": "succeeded"
}
```

```json
{
  "kind": "workflow",
  "runId": "run_01H…",
  "status": "queued",
  "startedAt": "…"
}
```

The `action` and `function` arms return **`200`**; the `workflow` arm returns
**`202`**, and **`202` is a normal outcome, not an error** — the run is queued,
and `runId` is how the caller follows it.

Wrappers must **switch on `kind`** and must **tolerate an unknown future
`kind`** rather than crashing.

**The frame is additive.** Nothing was renamed, removed or re-typed, so a
wrapper written against the three-arm shape keeps working unchanged. What it
adds:

| Field                                     | Notes                                                                                                                                                         |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `invocationId`                            | This attempt's id, `inv_…`. Resolves through `GET /invocations/{id}` to the stored inputs, output, error and timing. **Not** the same as `runId` — see below. |
| `status`                                  | The **platform's** verdict on the attempt: `succeeded`, `failed`, or `queued` on the workflow arm.                                                            |
| `startedAt` / `finishedAt` / `durationMs` | When the attempt ran, and for how long.                                                                                                                       |
| `output` (action arm)                     | The action's return value under the name every arm shares. `value` carries the identical payload and is kept, now **deprecated** — new callers read `output`. |

**`invocationId` is not `runId`.** `invocationId` names the CALL; `runId` names
the queued workflow RUN a call may have started. On the workflow arm both are
present and they mean different things, which is exactly why the existing name
was not generalised.

**`status` is not the target's status.** A SendGrid send whose `output` reads
`{"statusCode": 202}` is SendGrid describing its own request. Whether _this_
platform considers the call a success is `status`, and only `status`.

**A failed call carries the frame too.** The `4xx` body puts `invocationId`,
`status: "failed"` and the timing beside its `error`, so the attempt you most
need to explain is exactly as lookup-able as one that worked.

Unlike `workflows.run`, this operation has no `?wait=`, no `variables`, no
`trigger` and no `input` — they have no slot in the three-field
`{urn, action, payload}` shape (D4). Use `workflows.run` when you need them.

**Errors** — the usual envelope. Note `424` in particular: an execute-phase
failure is the target's own hook throwing, almost always the upstream app
returning an error, and the server reports it as `424 Failed Dependency` rather
than a 5xx. The reason is in
[implementation.md §3](./implementation.md#3-error-model).

---

## 20. `workflows.get` — fetch a workflow definition

```
GET /workflows/:id
```

`status: required` · served today

**No envelope.** The response body _is_ the payload, all three fields of it —
there is no key to unwrap, and a wrapper's `unwrap` helper does not apply here.

**Response `200`**

```json
{
  "workflow": {
    "manifestVersion": "2",
    "id": "wf_01H…",
    "name": "welcome-email",
    "nodes": []
  },
  "sourceRef": null,
  "updatedAt": "2026-07-22T18:03:00.000Z"
}
```

`workflow` is the stored definition overlaid with the authoritative `status` and
`tags` columns, so a freshly created workflow that carries neither inline still
reports its real lifecycle state. It stays **opaque** in every lane
(`Record<string, unknown>` in TS, `dict` in Python): `nodes[]` carry node types
the engine owns and extends, and a wrapper that modelled them would reject a
workflow a newer server accepts.

A definition is stored and returned as `nodes[]`. `workflows.create` and
`workflows.update` also accept a body whose array is called `steps[]` — same
entries, older name — but not both at once: a body carrying both arrays, or
neither, is `400 invalid_workflow`.

**`updatedAt` is a top-level sibling of `workflow`, never a field inside it.**
The definition is the portable document — it can be exported, re-imported, or
committed to a repo — and a server timestamp must not enter it. It is also the
optimistic-concurrency token §22 takes as `ifUnmodifiedSince`.

Missing id is `404 unknown_workflow`.

---

## 21. `workflows.create` — create a workflow

```
POST /workflows[?project=<id>]
```

`status: required` · served today · **`201`**

The create half of the server's single upsert route, which is why §21 and §22
share a method and a path.

**The server mints an id only when the caller sends none.** `validateDefinition`
accepts a body with no `id` — the server mints `wf_<uuid>` itself — and accepts
a caller-supplied `id` only if it matches `^wf_[A-Za-z0-9-]{1,64}$`; anything
else is `400 invalid_workflow`. Every wrapper still mints one client-side
(`wf_<uuid>`) when the definition carries none and forwards an `id` the caller
supplied untouched, so what it sends already satisfies that grammar.

The definition is sent **verbatim as the body**, never wrapped in an envelope
key. `manifestVersion` must be `"2"`. A definition whose `trigger.cron` is set
also (re)applies a schedule, reported back as `scheduled`.

**Response `201`**

```json
{
  "workflow": { "id": "wf_01H…", "name": "welcome-email" },
  "scheduled": false,
  "updatedAt": "2026-07-22T18:03:00.000Z"
}
```

`scheduled: false` does not mean "not scheduled" — it means "not scheduled by
_this_ call"; a workflow that already had a schedule is not re-scheduled.

`400 unknown_project` when `project` names a project the account does not own;
`409 workflow_conflict` when another `(tenant, subject)` already owns that id.

---

## 22. `workflows.update` — overwrite a workflow

```
POST /workflows[?project=<id>]
x-w6w-if-unmodified-since: <updatedAt>
```

`status: required` · served today · **`201`**

**A full replacement, not a patch.** The server stores what it is given, so a
field left out is a field removed. Read with §20, change what you mean to
change, send the whole thing back.

`id` comes from the operation's **first argument** and is pinned into the body,
overriding any `id` the definition carries. Trusting the body instead makes
`update("wf_a", defOfB)` silently write to B and answer with B's id, which reads
like success.

`ifUnmodifiedSince` is the optimistic-concurrency precondition. It is a
**header**, not a query parameter, and it is sent **only when a value was
given** — never as an empty or `"null"` string, which the server answers
`400 invalid_precondition`, an error naming something the caller never asked
for. Pass the exact `updatedAt` from §20 or a prior save.

Two 409s, and the difference matters: `409 workflow_stale` means the
precondition did not match and **is** recoverable by reloading and re-saving;
`409 workflow_conflict` means someone else owns the id and is **not**.

Response is §21's, with the new `updatedAt`.

---

## 23. `workflows.archive` — archive a workflow

```
POST /workflows/:id/archive
```

`status: required` · served today

One-way: there is no unarchive route on this domain. **Idempotent** — archiving
an already-archived workflow re-returns it unchanged rather than erroring, so a
wrapper must not special-case the second call.

**Response `200`** — envelope key `workflow`; the wrapper unwraps. Same merged
shape §20 returns.

This is a **precondition of §24**, not a convenience: the delete refuses
anything still `draft` or `active`.

Missing id is `404 unknown_workflow`.

---

## 24. `workflows.delete` — delete an archived workflow

```
DELETE /workflows/:id
```

`status: required` · served today

The server returns `{ "ok": true }` and the wrapper unwraps it to **nothing** —
declared return is `void` (`Promise<void>` in TS, `None` in Python, no stdout
payload in the CLI beyond an exit code), the same pin §10 carries. `Ok` is not a
public wrapper type.

The workflow's runs, schedules and subscriptions cascade-delete server-side.

**Archive first.** A workflow that is not `archived` yet is
`409 workflow_not_archived`, and a wrapper must **not** catch that and archive
on the caller's behalf: a two-step destructive path completed silently is how a
caller deletes something they only meant to look at.

Deleting an unknown id is `404 unknown_workflow`, not a silent success.

---

## 25. `functions.list` — list Functions

```
GET /functions[?tag=<tag>]
```

`status: required` · served today

The discovery operation for this domain, in for the same reason §2 and §3 are
(D4): it is how a caller finds the `key` to pass to §17.

**No `project` parameter.** Unlike workflows and documents this route reads no
`?project=` at all, and sending one would be inventing a parameter.

The optional `tag` query narrows the list: a row is kept when one of its tags equals
the value or starts with the value plus `.` (segment-bounded: `action.order` matches
`action.order` and `action.order.confirm`, not `action.orders`). Wrappers send
`?tag=` only when a non-blank tag was given; a single value, no multi-tag OR. Each row carries `tags: string[]` (`[]` when none);
create/update definitions accept a top-level `tags?: string[]` (strings only, trimmed,
empties dropped, de-duplicated; an update replaces the stored tags only when supplied).

**Response `200`** — envelope key `functions`; the wrapper unwraps.

```json
{
  "functions": [
    {
      "id": "fn_01H…",
      "key": "send-email",
      "displayName": "Send email",
      "description": "Sends one transactional email.",
      "updatedAt": "2026-07-22T18:03:00.000Z",
      "valid": true,
      "tags": ["action.order"]
    }
  ]
}
```

Shape is `FunctionSummary`. `valid` is server-computed by the same predicate the
invoke path guards with, so runnability needs no second call. `displayName`
falls back to `key` server-side and is never a substitute for it — `key` is what
§17 takes. Unpaginated today, same as §3.

---

## 26. `functions.get` — fetch a Function definition

```
GET /functions/:idOrKey
```

`status: required` · served today

Takes an `fn_…` id **or** a `key`, the same either-or §17 takes and for the same
reason: an id carries an underscore and a key's grammar forbids one, so the two
cannot collide.

**Response `200`**

```json
{
  "function": {
    "manifestVersion": "1",
    "id": "fn_01H…",
    "key": "send-email",
    "inputs": []
  },
  "valid": true
}
```

Wrappers **must keep `valid` and `updatedAt` top-level siblings** rather than
splicing them into the definition: they are computed per request, they are not
part of the stored document (`rfcs/function.md`), and folding them in would put
them inside the object a caller sends straight back to §28. `updatedAt` is the
concurrency token to pass there as `ifUnmodifiedSince`. (The console surface's
own `console.functions.get` does splice both, for the studio's sake. That is not
this surface.)

The definition stays **opaque**: its `impl` is a union the server extends — an
app Action, another Function, or a Workflow since D-8 — and the whole point of a
Function is that `impl` is the part you swap.

Missing id is `404 unknown_function`.

---

## 27. `functions.create` — create a Function

```
POST /functions
```

`status: required` · served today · **`201`**

The create half of the server's single upsert route. **The server mints an id
only when the caller sends none** — a caller-supplied `id` is accepted only if
it matches `^fn_[A-Za-z0-9-]{1,64}$`, else `400 invalid_function`. Wrappers
still mint `fn_<uuid>` client-side when the definition carries none, exactly as
§21 does.

**`key` is not minted.** It is the name the Function is _called_ by, so it is
the caller's to choose. The server validates it on **first save only** (3–39
characters, starts lowercase, lowercase letters/digits/single hyphens, no `_`),
deliberately leaving legacy keys alone on update; that grammar is what keeps
`/functions/:idOrKey/invoke` unambiguous.

**`impl` is optional.** A Function with none is a valid draft that stores fine
and answers `valid: false`. Wrappers must not require it.

**Response `201`** — envelope key `function`, plus the first `updatedAt` as a
**top-level sibling** of it; the wrapper returns `{ id, key, updatedAt }`. Create
takes no precondition: there is nothing yet to be stale against.

Two distinct 409s, and a wrapper must surface both rather than flattening them:
`409 function_conflict` is an ownership clash on the id;
`409 function_key_conflict` is the key already being taken.

---

## 28. `functions.update` — overwrite a Function

```
POST /functions
```

`status: required` · served today · **`201`**

The update half of the same upsert route as §27. **A full replacement, not a
patch** — read with §26, change what you mean to change, send the whole thing
back. `id` comes from the first argument and is pinned into the body.

`ifUnmodifiedSince` is the optimistic-concurrency precondition, exactly as on
workflows: it is sent as the `x-w6w-if-unmodified-since` **header** (not a query
parameter) and **only when a value was given** — never as an empty or `"null"`
string, which the server answers `400 invalid_precondition`. Pass the exact
`updatedAt` from §26 or a prior save; a stale one is `409 function_stale`, which
is recoverable by reloading and re-saving, unlike `409 function_conflict`.
Omitted, the write is last-write-wins.

**Response `201`** — the `function` envelope plus the new `updatedAt` as a
**top-level sibling** of it; the wrapper returns `{ id, key, updatedAt }`, so a
caller can chain saves without a re-read.

Do not send `valid` or `updatedAt` back: neither is part of the stored document,
which is exactly why §26 leaves them outside the definition.

---

## 29. `functions.delete` — delete a Function

```
DELETE /functions/:idOrKey
```

`status: required` · served today

The server returns `{ "ok": true }` and the wrapper unwraps it to **nothing**
(`void` / `None` / exit code), same pin as §10. **Not idempotent**: deleting an
id that is not there is `404 unknown_function`, and wrappers must not pretend
otherwise.

**Archive first**, exactly as for a workflow (§30): a Function that is not
`archived` yet is `409 function_not_archived`, and a wrapper must **not** catch
that and archive on the caller's behalf.

**Nothing checks for callers first.** A Function may be referenced by an
Endpoint, by a Workflow step, or by another Function's `impl` (D-8), and the
server does not walk those references — they break at call time.

---

## 30. `functions.archive` — archive a Function

```
POST /functions/:id/archive
```

`status: required` · served today

One-way: there is no unarchive route. **Idempotent** — archiving an
already-archived Function re-returns it unchanged. **Response `200`** — envelope
key `function`; the wrapper unwraps.

This is a **precondition of §29**, not a convenience: deleting a Function that is
not archived is `409 function_not_archived`.

Names: TS `client.functions.archive(id)` · Python `client.functions.archive(id)` ·
CLI `w6w functions archive <id>`.

Missing id is `404 unknown_function`.

---

## 31. `workflows.listVersions` — list a workflow's versions

```
GET /workflows/:id/versions
```

`status: required` · served today

Returns the server's **whole body**: `enabled`, `currentPublishedVersion`
(`null` before the first publish) and `versions[]` — each row `versionNumber`,
`createdAt`, `createdBy` (`null` when unknown) and `isCurrentPublished`. Metadata
only, no `definition`; fetch one with §32.

Names: TS `client.workflows.listVersions(id)` · Python `client.workflows.list_versions(id)`
· CLI `w6w workflows versions <id>`.

Missing id is `404 unknown_workflow`.

---

## 32. `workflows.getVersion` — read one version of a workflow

```
GET /workflows/:id/versions/:n
```

`status: required` · served today

**Response `200`** — envelope key `version` (`versionNumber`, `createdAt`,
`createdBy`, `isCurrentPublished`, `definition`); the wrapper unwraps. The
`definition` is opaque and redacted server-side — a sealed secret envelope is
never returned.

Names: TS `client.workflows.getVersion(id, n)` · Python `client.workflows.get_version(id, n)`
· CLI `w6w workflows version <id> <n>`.

Errors: `404 unknown_version`, `404 unknown_workflow`, `400 invalid_version` when `n` is not
a positive integer.

---

## 33. `workflows.publish` — publish the stored workflow as a new version

```
POST /workflows/:id/publish
```

`status: required` · served today

Snapshots the **stored** row — not whatever an editor holds in memory — as a new
immutable version, so **flush any pending save first**. Publishing a workflow also activates a never-published workflow. The server takes no
precondition, and the wrapper adds none.

**Response `200`** — returned whole: `version` (`kind`, `callableId`,
`versionNumber`, `createdAt`, `createdBy`, `null` when unknown) and
`currentPublishedVersion`.

Names: TS `client.workflows.publish(id)` · Python `client.workflows.publish(id)` · CLI
`w6w workflows publish <id>`.

Missing id is `404 unknown_workflow`.

---

## 34. `workflows.revert` — rewrite the live workflow from a version

```
POST /workflows/:id/versions/:n/revert
```

`status: required` · served today

Rewrites the live definition from version `n`. It does **not** publish: the live
row becomes a draft matching version `n` until §33 is called again.
Revert **rewrites the live row**, so a following `workflows.update` that passes
`ifUnmodifiedSince` needs a **freshly read** `updatedAt` (§20), not the one from before
the revert, or it is `409 workflow_stale`.

**Response `200`** — envelope key `reverted` (`kind`, `callableId`,
`versionNumber`); the wrapper unwraps.

Names: TS `client.workflows.revert(id, n)` · Python `client.workflows.revert(id, n)` · CLI
`w6w workflows revert <id> <n>`.

Errors: `404 unknown_version`, `404 unknown_workflow`, `400 invalid_version`.

---

## 35. `workflows.enable` — enable a workflow

```
POST /workflows/:id/enable
```

`status: required` · served today

The server returns `{ "enabled": true }` and the wrapper unwraps it to
**nothing** (`void` / `None` / exit code), the same pin as §10. **Idempotent.** A
disabled workflow is refused by every run, version runs and draft runs included
(`workflow_disabled`).

Names: TS `client.workflows.enable(id)` · Python `client.workflows.enable(id)` · CLI
`w6w workflows enable <id>`.

Missing id is `404 unknown_workflow`.

---

## 36. `workflows.disable` — disable a workflow

```
POST /workflows/:id/disable
```

`status: required` · served today

The server returns `{ "enabled": false }` and the wrapper unwraps it to
**nothing** (`void` / `None` / exit code), the same pin as §10. **Idempotent.** A
disabled workflow is refused by every run, version runs and draft runs included
(`workflow_disabled`).

Names: TS `client.workflows.disable(id)` · Python `client.workflows.disable(id)` · CLI
`w6w workflows disable <id>`.

Missing id is `404 unknown_workflow`.

---

## 37. `workflows.runVersion` — run one version of a workflow

```
POST /workflows/:id/versions/:n/run[?wait=true]
```

`status: required` · served today

Same body (`variables`, `trigger`, `input`) and `?wait=true` as §4, against one
**published version** instead of the live row. The response is §4's, including the
`202` for a run still going; a failed run is `200` with status `failed` and is
not an error. There is no `allowUnpublished` here — a version is published by
definition.

Names: TS `client.workflows.runVersion(id, n, opts?)` · Python
`client.workflows.run_version(id, n, wait=False, variables=None, trigger=None, input=None)`
· CLI `w6w workflows run-version <id> <n> [--wait] [--input <json>]`.

Errors: `404 unknown_version`, `404 unknown_workflow`, `409 workflow_archived`,
`409 workflow_disabled`, `409 workflow_not_published`, `400 invalid_version`.

---

## 38. `functions.listVersions` — list a Function's versions

```
GET /functions/:id/versions
```

`status: required` · served today

Returns the server's **whole body**: `enabled`, `currentPublishedVersion`
(`null` before the first publish) and `versions[]` — each row `versionNumber`,
`createdAt`, `createdBy` (`null` when unknown) and `isCurrentPublished`. Metadata
only, no `definition`; fetch one with §39.

Names: TS `client.functions.listVersions(id)` · Python `client.functions.list_versions(id)`
· CLI `w6w functions versions <id>`.

Missing id is `404 unknown_function`.

---

## 39. `functions.getVersion` — read one version of a Function

```
GET /functions/:id/versions/:n
```

`status: required` · served today

**Response `200`** — envelope key `version` (`versionNumber`, `createdAt`,
`createdBy`, `isCurrentPublished`, `definition`); the wrapper unwraps. The
`definition` is opaque and redacted server-side — a sealed secret envelope is
never returned.

Names: TS `client.functions.getVersion(id, n)` · Python `client.functions.get_version(id, n)`
· CLI `w6w functions version <id> <n>`.

Errors: `404 unknown_version`, `404 unknown_function`, `400 invalid_version` when `n` is not
a positive integer.

---

## 40. `functions.publish` — publish the stored Function as a new version

```
POST /functions/:id/publish
```

`status: required` · served today

Snapshots the **stored** row — not whatever an editor holds in memory — as a new
immutable version, so **flush any pending save first**. The server takes no
precondition, and the wrapper adds none.

**Response `200`** — returned whole: `version` (`kind`, `callableId`,
`versionNumber`, `createdAt`, `createdBy`, `null` when unknown) and
`currentPublishedVersion`.

Names: TS `client.functions.publish(id)` · Python `client.functions.publish(id)` · CLI
`w6w functions publish <id>`.

Missing id is `404 unknown_function`.

---

## 41. `functions.revert` — rewrite the live Function from a version

```
POST /functions/:id/versions/:n/revert
```

`status: required` · served today

Rewrites the live definition from version `n`. It does **not** publish: the live
row becomes a draft matching version `n` until §40 is called again.
Revert itself is unguarded, but it rewrites the stored row, so its `updatedAt`
moves: a token read before a revert is stale after it (`409 function_stale` on
the next guarded §28).

**Response `200`** — envelope key `reverted` (`kind`, `callableId`,
`versionNumber`); the wrapper unwraps.

Names: TS `client.functions.revert(id, n)` · Python `client.functions.revert(id, n)` · CLI
`w6w functions revert <id> <n>`.

Errors: `404 unknown_version`, `404 unknown_function`, `400 invalid_version`.

---

## 42. `functions.enable` — enable a Function

```
POST /functions/:id/enable
```

`status: required` · served today

The server returns `{ "enabled": true }` and the wrapper unwraps it to
**nothing** (`void` / `None` / exit code), the same pin as §10. **Idempotent.** A
disabled Function is refused by every run, version runs and draft runs included
(`function_disabled`).

Names: TS `client.functions.enable(id)` · Python `client.functions.enable(id)` · CLI
`w6w functions enable <id>`.

Missing id is `404 unknown_function`.

---

## 43. `functions.disable` — disable a Function

```
POST /functions/:id/disable
```

`status: required` · served today

The server returns `{ "enabled": false }` and the wrapper unwraps it to
**nothing** (`void` / `None` / exit code), the same pin as §10. **Idempotent.** A
disabled Function is refused by every run, version runs and draft runs included
(`function_disabled`).

Names: TS `client.functions.disable(id)` · Python `client.functions.disable(id)` · CLI
`w6w functions disable <id>`.

Missing id is `404 unknown_function`.

---

## 44. `functions.runVersion` — run one version of a Function

```
POST /functions/:id/versions/:n/invoke
```

`status: required` · served today

Same body (`inputs`, spelled `payload` by wrappers) as §17, against one
**published version**. Note the wire verb is `invoke`, not `run`. Returns the
Function's **output**, unwrapped exactly as §17 does (a `null` output is a
successful run).

Names: TS `client.functions.runVersion(id, n, opts?)` · Python
`client.functions.run_version(id, n, payload=None)` · CLI
`w6w functions run-version <id> <n> [--payload <json>]`.

Errors: `404 unknown_version`, `404 unknown_function`, `422 function_incomplete`,
`422 function_disabled`, `422 function_not_published`, `400 invalid_version`.

---

## 45. `connections.get` — fetch one connection

```
GET /connections/:id
```

`status: required` · served today

**Response `200`** — envelope key `connection`; the wrapper unwraps and returns
one `ConnectionSummary` (the same redacted projection as §2, including the
optional `app` and `builtIn`, and the nullable `credentialId`). Since `0.18.0` the row
may carry `accessScope: "account" | "user"` (absent means an older server). Since
`0.19.0` it may carry `autoRefresh`, `lastRefreshedAt` and `refreshFailingSince`,
as in §2.

**Account-owned.** Another account's id answers the same `404 unknown_connection`
as an id that does not exist. The built-in zero-credential row that §2 can include
(a `zerocred:` id, `builtIn: true`) is synthetic and not fetchable: `404`.

---

## 46. `connections.delete` — delete a connection

```
DELETE /connections/:id
```

`status: required` · served today

The server returns `{ "ok": true }` and the wrapper unwraps it to **nothing**
(`void` / `None` / exit code), same pin as §10. **Not idempotent**: a second
delete is `404 unknown_connection`.

Authorization is the server's existing rule, unchanged: the connection must be
owned by the caller's account. Another account's id is the uniform `404` and
destroys nothing; so is a `zerocred:` built-in row, which is not stored. Before
the row is removed the server **tears down every trigger subscription** bound to
the connection, so the vendor webhook is removed while the credential can still
sign that call.

**`force` (optional, boolean, query).** While live callables (Functions / Endpoints)
still use the connection, the server refuses with `409 connection_in_use`; the body is
`{ "error": { "code", "message", "dependents" } }` with
`dependents = { callables: [{ id, kind, key, displayName, enabled, sites }], subscriptions: [{ id, appId, triggerKey, workflowId }] }`.
It surfaces as the lane's ordinary API error (no new error class); read `dependents`
from its parsed body. `force` is sent as `?force=true` **only when true** — `false` or
omitted sends no query string. A forced delete **disables** the dependent callables
(it never edits them) and succeeds; the success body then carries
`{ "ok": true, "disabled": [...] }` and the wrapper still unwraps to nothing.
Subscriptions are torn down either way and never cause the `409`.

**Model routes (contract `0.10.0`).** `dependents` also carries
`routes: [{ id, name, project, status }]` — the model routes bound to the connection —
and a routes-only dependent refuses with the same `409 connection_in_use`. A forced
delete marks those routes `broken` (it never edits or deletes them), and the success
body then also carries `brokenRoutes: string[]` (the route names):
`{ "ok": true, "disabled": [...], "brokenRoutes": [...] }`. The wrapper still unwraps to nothing.

Connection create, update, test and OAuth are **not** in the contract (see
"Explicitly out of scope").

---

## 47. `apps.byIds` — resolve app ids to catalog summaries

```
GET /apps?ids=a,b,c
```

`status: required` · served today

A bounded lookup, not catalog browsing. The server caps `ids` at **100** per
request (`400 too_many_ids` beyond that), so the wrapper **chunks to 100
client-side**: one request per chunk, issued concurrently, the `apps` of every
page concatenated in chunk order. Duplicate ids are collapsed first; an empty set
returns `[]` with **no request at all** — never an unfiltered page. Unknown ids
are simply absent from the result.

The inline `app` object on §2 / §45 is the **primary** icon and label source for
a connection's app and needs no extra request; use `apps.byIds` for ids that do
not come from a connection.

---

## 48. `dashboard.stats` — account-scoped run rollup

```
GET /dashboard/stats?from=&to=&bucket=
```

`status: required` · served today

**Account-scoped**: the account comes from the credential, there is no `project`
parameter, and the client's default project is never sent. No envelope key — the
rollup (`range`, `headline`, `series`, `recent`) is the body. `from` / `to` are
ISO-8601 instants and `bucket` is `day` or `week`; each is sent only when given.

---

## 49. `projects.list` — list the account's projects

```
GET /projects
```

`status: required` · served today

Envelope key `projects`; the wrapper unwraps and returns the array. **Read-only**
— project create, rename, archive and delete are not in the contract. Archived
projects are not listed. Each row carries `isDefault`.

**Side effect:** the GET ensures the account has a default project and *creates
it when there is none*, so a first call on a fresh account returns one
`isDefault: true` row, not `[]`.

---

## 50. `reliability.list` — reliability board for a set of apps

```
GET /reliability/services?project=&apps=a,b&days=&limit=
```

`status: required` · served today

No envelope key — the board is the body. `project` and `apps` are required, and
the server accepts **at most 10** app ids: zero or more than ten is
`400 invalid_app_filter`, a missing `project` is `400 missing_project`. The
wrapper sends exactly the ids it is given and surfaces the 400 unchanged; it has
**no batching helper** — splitting a larger set across calls, and scheduling or
polling them, is the host's job.

---

## 51. `reliability.members` — apps a project's calls touch

```
GET /reliability/services/members?project=&days=
```

`status: required` · served today

Identifier-only discovery: no status probes. No envelope key; `appIds` is the list
to feed, at most ten at a time, to §50. `project` is required.

---

## 52. `models.list — list the model catalog`

```
GET /models?provider=&status=&limit=&cursor=
```

`status: required` · served today

Keyset-paged. The server answers `{ "models": Model[], "nextCursor": string | null }` and the wrapper returns that page object as-is. `status` is `active | deprecated | blocked`. Errors: `400 invalid_limit`, `400 invalid_cursor`.

---

## 53. `models.get — fetch one catalog model`

```
GET /models/:id
```

`status: required` · served today

Addressed by the server-issued catalog id (`mdl_…`), not a provider-native model id such as `gpt-4o`. The server wraps the body as `{ "model": Model }`; the wrapper unwraps. `Model.currentRate` is the effective `ModelRate` or `null`. An unknown id is the uniform `404`.

---

## 54. `modelRoutes.list — list model routes`

```
GET /model-routes?project=
```

`status: required` · served today

Project-scoped like the `documents.*` operations: optional `?project=`, else the default project; unknown project is `400 unknown_project`. The server wraps the body as `{ "routes": ModelRoute[] }`; the wrapper unwraps. Since `0.18.0` each route may carry `credentialMode` (`account` | `invoking_user`), `credentialSelection` (`{ mode: "account", connectionId }` | `{ mode: "invoking_user" }`) and `connectionId: string | null`; each fallback carries the same.

---

## 55. `modelRoutes.get — fetch one model route`

```
GET /model-routes/:name?project=
```

`status: required` · served today

Addressed by route `name`. The server wraps the body as `{ "route": ModelRoute }`; the wrapper unwraps. A missing name is `404 model_route_not_found`. Since `0.18.0` the route carries `credentialMode`, `credentialSelection` and `connectionId: string | null`, as in §54.

---

## 56. `modelRoutes.complete — run a completion through a route`

```
POST /model-routes/:name/complete?project=&dialect=&response=
```

`status: required` · served today

Body is a `BridgeInput`, sent as-is. The result is the **flat envelope** `{ provider, key, model, dialect, output?, usage, raw?, meta, invocationId, status, startedAt, finishedAt, durationMs }` returned exactly as sent — **no unwrap to `output`** (`key` is the answering connection id). `dialect` is `openai | anthropic | ollama`; `response` is `both | output | raw` (`output` omits `raw`, `raw` omits `output`). Each query key is sent only when given. Errors: `429 model_budget_exceeded`, `424 model_provider_failed`, `409 model_route_broken`, `403 model_egress_denied`, `404 model_route_not_found`. Since `0.18.0`: `409 personal_key_required`, `409 personal_key_unavailable`, `403 ai_credential_policy_denied` and `403 user_context_required`.

---

## 57. `modelUsage.query — query recorded model usage`

```
GET /model-usage?project=&groupBy=&from=&to=&route=&model=&limit=&cursor=
```

`status: required` · served today

Returns `{ totals, totalsTruncated, groups?, items, nextCursor }` as-is. `totals` = `{ requests, inputTokens, outputTokens, cachedInputTokens, cacheWriteTokens, totalTokens, cost: [{ currency, amountMinor }], unpriced }`. `groupBy` is `route | model | day` and adds `groups`. `totalsTruncated` is `true` when the server stopped folding the ledger at its aggregate row cap, so `totals` and `groups` cover only part of the window.

---

## 58. `assets.uploads.create` — reserve an upload

```
POST /asset-uploads
```

`status: required` · served today

Body
`{purpose, idempotencyKey, entries:[{path, sizeBytes, sha256, mediaType?}], name?, visibility?, assetId?, target?}`;
`purpose` is `asset | skill | context`. Declares the files and reserves quota;
no bytes move yet. Returns `{upload, entries}` as sent — `201` on create, `200`
when `idempotencyKey` replays the identical request. Entry `index` is its
position in `entries`. Errors: `400 invalid_body`, `413 too_many_files`,
`413 quota_exceeded`, `422 validation_failed`,
`503 managed_storage_unavailable`.

---

## 59. `assets.uploads.putEntry` — send one entry's bytes

```
PUT /asset-uploads/:id/entries/:index
```

`status: required` · served today

**Binary in** (`bodyEncoding: "octet-stream"`). The body is the entry's raw
bytes; the server checks its length and sha256 against the declaration. Returns
the `AssetUploadEntry` (unwrapped from `{entry}`). Re-sending a received entry
is allowed. Errors: `409 conflict` (upload not open), `413 payload_too_large`,
`422 validation_failed` (digest mismatch or unknown index).

---

## 60. `assets.uploads.finalize` — publish an upload

```
POST /asset-uploads/:id/finalize
```

`status: required` · served today

Idempotent. Returns
`{uploadId, assetId, versionId, version, readiness, derived, created}` as sent;
`readiness` is `ready | pending`, `created` is `false` on a repeat call. Errors:
`409 conflict`, `413 quota_exceeded`, `422 validation_failed`.

---

## 61. `assets.uploads.get` — read upload status

```
GET /asset-uploads/:id
```

`status: required` · served today

Returns `{upload, entries}`; each entry's `state` (`pending | received`) is the
resume point — a retrying client skips every `received` entry.

---

## 62. `assets.uploads.abort` — abort an upload

```
DELETE /asset-uploads/:id
```

`status: required` · served today

Answers `200 {upload, entries}` (the aborted view), not `{ok:true}`. A published
or already-aborted upload is `409 conflict`.

---

## 63. `assets.get` — fetch one asset

```
GET /assets/:id
```

`status: required` · served today

Unwrapped from `{asset}`. A missing, foreign or other-project id is the uniform
`404 not_found`.

---

## 64. `assets.versions` — list an asset's versions

```
GET /assets/:id/versions
```

`status: required` · served today

Unwrapped from `{versions}`; `failed` versions are not listed.

---

## 65. `assets.files` — list a version's files

```
GET /assets/:id/versions/:vid/files
```

`status: required` · served today

Returns `{version, files}` as sent. Files never carry an object key or storage
path.

---

## 66. `assets.content` — download one file's bytes

```
GET /assets/:id/versions/:vid/files/:fileId/content
```

`status: required` · served today

**Binary out** (`responseEncoding: "octet-stream"`). The file's exact bytes as
`Uint8Array` / `bytes`; the server's `content-disposition`/media-type headers
are ignored. A non-2xx still raises the typed error with the envelope `code`.

---

## 67. `assets.archiveDownload` — download a version as a ZIP

```
GET /assets/:id/versions/:vid/archive
```

`status: required` · not served yet

**Binary out.** A store-only ZIP of the version's files, unmodified. Pinned by
the design but **not served yet** (`serverImplemented: false`); against a host
without it the call raises the ordinary `404`.

---

## 68. `assets.archive` — archive an asset

```
POST /assets/:id/archive
```

`status: required` · served today

Unwrapped from `{asset}`. Retires the asset from listings; bytes are kept. A
caller who may not manage it gets the uniform `404`.

---

## 69. `assets.purge` — purge an asset

```
DELETE /assets/:id
```

`status: required` · served today

Irreversible. Returns `{assetId, versionsDeleted, objectsDeleted}`. Account
admins only — anyone else gets the uniform `404`. An asset still referenced by a
skill version or context entry is `409 purge_refused`.

---

## Skills, context collections and agent drafts (§70–§86)

Seventeen operations over `/skills`, `/context-collections` and `/agents`. All
are JSON (no binary transport) and all unwrap the server's single-key envelope
(`{skills}`, `{collection}`, `{entry}`, `{agent}`, …) to the bare value. They
share the principal-scoped caller of `assets.*`: the acting project is the
account's default, and every foreign or absent id is the one uniform `404`.

**Skills are uploaded, not created here.** A skill (and a context file) is
published with `assets.uploads.create` and `purpose: "skill"` / `"context"` (§58
onward; the CLI wrapper is `w6w assets upload --purpose skill`). This group
reads and archives what that produced.

**An Agent is a draft.** Every `agents.*` answer carries `runnable: false` — the
SDK types it as the literal `false`. No Agent runtime, RAG or chat history
exists; nothing in this group runs an Agent. An agent _pins_ immutable skill
versions and context asset versions, so uploading a new skill version never
changes an existing pin.

**Concurrency on the two edits.** `agents.update` and `context.entries.update`
carry BOTH a body `revision` (the last-seen revision, a positive integer, passed
through unchanged) and the `ifUnmodifiedSince` precondition, sent as the
`x-w6w-if-unmodified-since` header only when a value is given. The server
requires the header: omitted is `428 precondition_required`, a typed
precondition error (never a silent last-write-wins). A stale `revision` or
`updatedAt` is `409 conflict` — a typed conflict error; for `agents.update` the
envelope carries `currentRevision`. `context.update` (the collection patch) has
neither: it is last-write-wins.

## 70. `skills.list` — list skills

```
GET /skills
```

`status: required` · served today

Unwrapped from `{skills}`. `includeArchived` and `limit` are optional query
params. Principal-scoped: a missing, foreign, private-to-someone-else or
other-project id is the one uniform `404 not_found`.

---

## 71. `skills.get` — fetch one skill

```
GET /skills/:id
```

`status: required` · served today

Unwrapped from `{skill}`. `activeVersionId` is the version new pins should
target. Principal-scoped: a missing, foreign, private-to-someone-else or
other-project id is the one uniform `404 not_found`.

---

## 72. `skills.versions` — list a skill's versions

```
GET /skills/:id/versions
```

`status: required` · served today

Unwrapped from `{versions}`. A `SkillVersion.id` is what `agents.*` pins as
`skillVersionId`. Principal-scoped: a missing, foreign, private-to-someone-else
or other-project id is the one uniform `404 not_found`.

---

## 73. `skills.archive` — archive a skill

```
POST /skills/:id/archive
```

`status: required` · served today

Unwrapped from `{skill}`; `archivedAt` set. Bytes are kept. Principal-scoped: a
missing, foreign, private-to-someone-else or other-project id is the one uniform
`404 not_found`.

---

## 74. `context.list` — list context collections

```
GET /context-collections
```

`status: required` · served today

Unwrapped from `{collections}`. `includeArchived` and `limit` are optional query
params.

---

## 75. `context.create` — create a context collection

```
POST /context-collections
```

`status: required` · served today

`name` required; `description`, `tags`, `visibility` (`private|project|account`)
optional. Answers `201`, unwrapped from `{collection}`. A collection starts
empty.

---

## 76. `context.get` — fetch one context collection

```
GET /context-collections/:id
```

`status: required` · served today

Unwrapped from `{collection}`. Principal-scoped: a missing, foreign,
private-to-someone-else or other-project id is the one uniform `404 not_found`.

---

## 77. `context.update` — patch a context collection

```
PATCH /context-collections/:id
```

`status: required` · served today

`name`, `description`, `tags`, each optional; `visibility` is not patchable. No
precondition and no `revision` — last-write-wins. Principal-scoped: a missing,
foreign, private-to-someone-else or other-project id is the one uniform
`404 not_found`.

---

## 78. `context.archive` — archive a context collection

```
POST /context-collections/:id/archive
```

`status: required` · served today

Unwrapped from `{collection}`; `archivedAt` set. Principal-scoped: a missing,
foreign, private-to-someone-else or other-project id is the one uniform
`404 not_found`.

---

## 79. `context.entries.list` — list a collection's entries

```
GET /context-collections/:id/entries
```

`status: required` · served today

`id` is the collection id. Unwrapped from `{entries}`. A listed `ContextEntry`
has no `revision` and no `previewable`; those arrive on the `ContextEntryView`
answered by create and update. `assetVersionId` is what an agent's `context[]`
pin attaches.

---

## 80. `context.entries.create` — add a text entry

```
POST /context-collections/:id/entries
```

`status: required` · served today

`name` and `text`, both strings. Answers `201` with a `ContextEntryView`
(carrying `revision`), unwrapped from `{entry}`. Binary entries are uploads, not
this op.

---

## 81. `context.entries.update` — replace a text entry's content

```
PUT /context-collections/:id/entries/:entryId
```

`status: required` · served today

A full replacement of `text`. Body `revision` and the `ifUnmodifiedSince` header
are both required; `409 conflict` on a stale one, `428` without the header. An
entry outside the collection in the path is the uniform `404`. Answers the new
`ContextEntryView`.

---

## 82. `agents.list` — list agent drafts

```
GET /agents
```

`status: required` · served today

Unwrapped from `{agents}`. Every element has `runnable: false`.

---

## 83. `agents.create` — create an agent draft

```
POST /agents
```

`status: required` · served today

Every field optional (an incomplete draft saves; `validation` lists what is
missing): `name`, `instructions` (64 KiB cap), `modelRouteId`, `skills`
(`[{skillId, skillVersionId}]`), `context`
(`[{collectionId, entryId?, assetVersionId}]`), `visibility`, `project`, `tools`
(`[{kind: "action", uses: {app, action, connection?}} | {kind: "function",
function} | {kind: "workflow", workflow}]`, each with an optional `name` (1–64
chars, unique per agent) and `description` (at most 1024 chars); at most 50, no
duplicates). Answers
`201`; `422 validation_failed` carries `issues`. `runnable: false`.

---

## 84. `agents.get` — fetch one agent draft

```
GET /agents/:id
```

`status: required` · served today

Unwrapped from `{agent}`; carries the `revision` and `updatedAt` that
`agents.update` needs. Principal-scoped: a missing, foreign,
private-to-someone-else or other-project id is the one uniform `404 not_found`.

---

## 85. `agents.update` — patch an agent draft

```
PATCH /agents/:id
```

`status: required` · served today

Body `revision` plus the `ifUnmodifiedSince` header, both required.
`409 conflict` carries `currentRevision`; `428` without the header; a disallowed
pin is `422 validation_failed`. Omitted body fields are left alone. `runnable`
stays `false`.

---

## 86. `agents.archive` — archive an agent draft

```
POST /agents/:id/archive
```

`status: required` · served today

Unwrapped from `{agent}`; `archived: true`. There is no agent delete or purge.
Principal-scoped: a missing, foreign, private-to-someone-else or other-project
id is the one uniform `404 not_found`.

---

## 87. `contextEntries.list` — list entries across collections

```
GET /context-entries
```

`status: required` · served today

Top-level and collection-independent: an entry need not belong to any collection. Query `collectionId` (filter to one collection's members), `includeArchived`, `project`. Unwrapped from `{entries}`. A listed entry carries `collectionIds` (sorted ascending) and never `collectionId`.

---

## 88. `contextEntries.create` — create a text entry

```
POST /context-entries
```

`status: required` · served today

Body `name` and `text` (strings, required), `visibility` (defaults to the creator's default) and `collectionIds` (the entry becomes a member of each). Answers `201` with a `ContextEntryView`, unwrapped from `{entry}`.

---

## 89. `contextEntries.get` — fetch one entry

```
GET /context-entries/:id
```

`status: required` · served today

A missing, foreign, invisible or other-project entry (or collection) is the one uniform `404 not_found`. Answers a `ContextEntryView`, unwrapped from `{entry}`.

---

## 90. `contextEntries.update` — replace an entry's content

```
PUT /context-entries/:id
```

`status: required` · served today

A full replacement of `text`. Body `revision` and the `ifUnmodifiedSince` header are both required; `428 precondition_required` without the header, `409 conflict` on a stale one. A missing, foreign, invisible or other-project entry (or collection) is the one uniform `404 not_found`.

---

## 91. `contextEntries.archive` — archive an entry

```
POST /context-entries/:id/archive
```

`status: required` · served today

A missing, foreign, invisible or other-project entry (or collection) is the one uniform `404 not_found`. Answers the archived `ContextEntryView` (`archivedAt` set), unwrapped from `{entry}`.

---

## 92. `contextEntries.addToCollection` — add an entry to a collection

```
PUT /context-entries/:id/collections/:collectionId
```

`status: required` · served today

A missing, foreign, invisible or other-project entry (or collection) is the one uniform `404 not_found`. Idempotent. Answers the entry with its updated `collectionIds`, unwrapped from `{entry}`.

---

## 93. `contextEntries.removeFromCollection` — remove an entry from a collection

```
DELETE /context-entries/:id/collections/:collectionId
```

`status: required` · served today

A missing, foreign, invisible or other-project entry (or collection) is the one uniform `404 not_found`. Idempotent. Answers the entry with its updated `collectionIds`, unwrapped from `{entry}`.

---

## 94. `appManagement.list` — the apps the caller manages

```
GET /app-management/apps
```

`status: required` · served today

Query: `scope` (`all` default, `account`, `tenant`, `personal`), `q`, `sort` (`name` default, `-name`, `recent`, `-recent`), `compact`, `snapshot`, `cursor` (the previous `nextCursor`), `offset`, `limit`. Each is sent under its own name only when given, so `offset: 0` and `compact: false` are sent. `snapshot` and `cursor` are mutually exclusive.

Nothing is unwrapped: the body is returned as sent, `{apps, scope, snapshot, total, offset, limit, expiresAt, nextCursor?, targets, sourceOptions}`. `targets` is always three `TargetOption`s in the order account, tenant, personal (each `permitted`, with a `reason` when not); `sourceOptions` is what the caller may name as a source (`publicRepos`, `privateRepos`, `folders`, `localPaths`). Each row is the catalog `AppSummary` plus `management` (class, owner, capabilities, reasons), `source` and `lastSync`, all computed live. `ManagementClass`, `UnavailableReason` and `TargetOption.reason` are **open** unions; `SyncOutcome` is **closed**.

Errors: `400 invalid_scope`, `400 invalid_query`, `400 invalid_cursor`, `400 invalid_limit`, `400 invalid_offset`, `403 forbidden` (`scope=tenant` from a non-admin), `404 unknown_snapshot`, `410 snapshot_expired`, `400 snapshot_query_mismatch`.

---

## 95. `appManagement.get` — one managed app

```
GET /app-management/apps/:id
```

`status: required` · served today

The catalog detail (`app`, `actions`, `health`, `sourceRef`, `version`, `digest`, `versionCount`, `overlay`, `effective`, `owner`) plus `auths`, `management`, `source` and `lastSync`, returned as sent. A malformed id is `400 invalid_path`; an app the caller cannot see, or can see but does not manage, is `404 unknown_app`.

---

## 96. `appManagement.preview` — preview a source for a target

```
POST /app-management/preview
```

`status: required` · served today

Body `{source, target}` (nothing else is sent). `source` is a canonical remote ref or `{folder:{grant,path}}`; `target` is `account`, `tenant` or `personal`. Answers `{kind:"app", sourceRef, app}` or `{kind:"pack", sourceRef, pack, entries}`; `entries[].alreadyRegistered` covers only apps the caller manages.

Errors: `400 invalid_body`, `400 invalid_target`, `400 invalid_source`, `403 forbidden`, `403 local_import_forbidden`, `424 fetch_failed`, `424 source_requires_grant`, `429 source_rate_limited`, `424 source_timeout`, `424 source_too_large`.

---

## 97. `appManagement.register` — register into a target

```
POST /app-management/apps
```

`status: required` · served today

Body `{target, source, paths?}`; `paths` (pack sources only) is sent only when given. Answers the legacy import shapes (app 201/200, pack 201/207/200) plus `target`.

Errors: `400 invalid_body`, `400 invalid_target`, `400 invalid_source`, `403 forbidden`, `403 user_import_disabled`, `403 local_import_forbidden`, `409 id_taken`, and the source fetch codes of §96.

---

## 98. `appManagement.updateSource` — edit the active source

```
PUT /app-management/apps/:id/source
```

`status: required` · served today

Body `{source, expectedRevision}`, both required (`0` is sent). Answers a `SyncResult` `{appId, outcome, completedAt, previousVersion, version, bumped, fetchedRevision?, source, error?}`. `outcome` is the closed union `registry_updated | definition_unchanged | failed`; `error` is present only for `failed`, which is still a `200`. The active source changes only on the first two.

Errors: the `:id` errors of §95 plus `403 forbidden`, `409 artifact_backed`, `409 stale_source`, `403 local_import_forbidden`, `400 invalid_source`, `400 invalid_body`.

---

## 99. `appManagement.sync` — sync from the active source

```
POST /app-management/apps/:id/sync
```

`status: required` · served today

Body `{}`, or `{expectedRevision}` when given (`0` is sent). Answers a `SyncResult` (§98).

Errors: the `:id` errors of §98 plus `409 no_source`, `409 sync_conflict` (lost the locked-write race), and `409 stale_source` only when `expectedRevision` was sent.

---

## 100. `appManagement.remove` — remove an app

```
DELETE /app-management/apps/:id
```

`status: required` · served today

No body. Answers `{removed}`, a count of removed versions. Errors: the `:id` errors of §95, `403 forbidden`, `409 app_in_use`.

---

## 101. `dataStores.list` — list the project's data stores

```
GET /data-stores
```

`status: required` · served today

Params: `kind` (query, string), `cursor` (query, string), `limit` (query, integer), `project` (query, string). Returns `DataStorePage`.

Returns `{items, nextCursor?}`; `nextCursor` is absent (never null) on the last page. A malformed cursor is `400 invalid_cursor`; a bad `limit` `400 invalid_limit`.

Project rule: optional `?project=`, per call then client default, otherwise omitted (the server uses the account's default project); an unknown project is `400 unknown_project`.

Errors (informational; status + code pass through as the ordinary `ApiError`): `400 invalid_cursor`, `400 invalid_limit`, `400 unknown_project`.

---

## 102. `dataStores.get` — fetch one data store by id

```
GET /data-stores/:id
```

`status: required` · served today

Params: `id` (path, string, required), `project` (query, string). Returns `DataStore`.

The store is returned BARE (not wrapped).

Project rule: optional `?project=`, per call then client default, otherwise omitted (the server uses the account's default project); an unknown project is `400 unknown_project`.

Errors (informational; status + code pass through as the ordinary `ApiError`): `404 data_store_not_found`, `400 unknown_project`.

---

## 103. `dataStores.create` — create a data store

```
POST /data-stores
```

`status: required` · served today

Params: `kind` (body, string, required), `name` (body, string, required), `description` (body, string), `schema` (body, object), `project` (query, string). Returns `DataStore` (success status 201).

`kind` is `kv`, `doc` or `table`; `schema` (table only) is `{columns:[{name,type,required,default?}], key?}`. The server answers `201` with the bare store. Validation refusals are `400` with codes such as `invalid_value`, `invalid_body`; a duplicate name is `409 store_exists`.

Project rule: optional `?project=`, per call then client default, otherwise omitted (the server uses the account's default project); an unknown project is `400 unknown_project`.

Errors (informational; status + code pass through as the ordinary `ApiError`): `400 invalid_value` / `invalid_body`, `409 store_exists`, `400 unknown_project`.

---

## 104. `dataStores.update` — patch a data store's name, description or schema

```
PATCH /data-stores/:id
```

`status: required` · served today

Params: `id` (path, string, required), `name` (body, string), `description` (body, string), `schema` (body, object), `project` (query, string). Returns `DataStore`.

Every body field is optional; an omitted field is left alone. `kind` is immutable. A schema the stored rows do not satisfy is `schema_incompatible`.

Project rule: optional `?project=`, per call then client default, otherwise omitted (the server uses the account's default project); an unknown project is `400 unknown_project`.

Errors (informational; status + code pass through as the ordinary `ApiError`): `404 data_store_not_found`, `400 invalid_body`, `400 schema_incompatible` when stored rows violate the new schema, `400 unknown_project`.

---

## 105. `dataStores.archive` — archive a data store

```
DELETE /data-stores/:id
```

`status: required` · served today

Params: `id` (path, string, required), `project` (query, string). Returns `void` (success status 204).

The server answers `204`; the wrapper returns nothing. Archiving is a soft delete: the store then answers `404 data_store_not_found`.

Project rule: optional `?project=`, per call then client default, otherwise omitted (the server uses the account's default project); an unknown project is `400 unknown_project`.

Errors (informational; status + code pass through as the ordinary `ApiError`): `404 data_store_not_found`, `400 unknown_project`.

---

## 106. `dataStores.importCsv` — import CSV text into a table store

```
POST /data-stores/:id/import
```

`status: required` · served today

Params: `id` (path, string, required), `body` (body, string, required), `project` (query, string). Returns `{ imported: number }`.

TEXT IN (`bodyEncoding: "csv"`, docs/endpoints.md Conventions): the request body is the CSV text verbatim with `content-type: text/csv` — never JSON-encoded or quoted. The header row names the columns. The server refuses any other media type with `400 invalid_csv`; a bad cell is `400 invalid_value` carrying `field`, `row` and `column` in the envelope (`ApiError.raw.error`). Answers `{ imported }`.

Project rule: optional `?project=`, per call then client default, otherwise omitted (the server uses the account's default project); an unknown project is `400 unknown_project`.

Errors (informational; status + code pass through as the ordinary `ApiError`): `404 data_store_not_found`, `400 invalid_csv`, `400 invalid_value` (with `field`, `row`, `column`), `413 payload_too_large`, `400 unknown_project`.

---

## 107. `dataStores.exportCsv` — export a table store as CSV text

```
GET /data-stores/:id/export
```

`status: required` · served today

Params: `id` (path, string, required), `project` (query, string). Returns `string` (success status 200).

TEXT OUT (`responseEncoding: "text"`, docs/endpoints.md Conventions): returns the CSV body verbatim as a string, never JSON-parsed — a body that happens to parse as JSON stays a string. A non-2xx still carries the JSON error envelope and raises the typed error with its `code`.

Project rule: optional `?project=`, per call then client default, otherwise omitted (the server uses the account's default project); an unknown project is `400 unknown_project`.

Errors (informational; status + code pass through as the ordinary `ApiError`): `404 data_store_not_found`, `400 unknown_project`.

---

## 108. `dataStores.entries.list` — list a store's entries, paged by key

```
GET /data-stores/:id/entries
```

`status: required` · served today

Params: `id` (path, string, required), `prefix` (query, string), `cursor` (query, string), `limit` (query, integer), `project` (query, string). Returns `DataStoreEntryPage`.

Returns `{items, nextCursor?}` ordered by key; `nextCursor` is absent (never null) on the last page. A malformed cursor is `400 invalid_cursor`. Filtering and ordering is `dataStores.entries.query`.

Project rule: optional `?project=`, per call then client default, otherwise omitted (the server uses the account's default project); an unknown project is `400 unknown_project`.

Errors (informational; status + code pass through as the ordinary `ApiError`): `404 data_store_not_found`, `400 invalid_cursor`, `400 invalid_limit`, `400 unknown_project`.

---

## 109. `dataStores.entries.get` — fetch one entry by key

```
GET /data-stores/:id/entries/:key
```

`status: required` · served today

Params: `id` (path, string, required), `key` (path, string, required), `project` (query, string). Returns `DataStoreEntry`.

The entry is returned BARE. A missing key is `404 entry_not_found`.

Project rule: optional `?project=`, per call then client default, otherwise omitted (the server uses the account's default project); an unknown project is `400 unknown_project`.

Errors (informational; status + code pass through as the ordinary `ApiError`): `404 data_store_not_found`, `404 entry_not_found`, `400 invalid_key`, `400 unknown_project`.

---

## 110. `dataStores.entries.set` — create or replace one entry by key

```
PUT /data-stores/:id/entries/:key
```

`status: required` · served today

Params: `id` (path, string, required), `key` (path, string, required), `value` (body, any, required), `ifVersion` (body, integer), `ttlSeconds` (body, integer), `project` (query, string). Returns `DataStoreEntry`.

Body `{value, ifVersion?, ttlSeconds?}`. `ifVersion` makes the write conditional (`409 version_conflict`). A value the store's kind or schema refuses is `400 invalid_value` with `field`/`row`/`column`; a bad key is `400 invalid_key`.

Project rule: optional `?project=`, per call then client default, otherwise omitted (the server uses the account's default project); an unknown project is `400 unknown_project`.

Errors (informational; status + code pass through as the ordinary `ApiError`): `404 data_store_not_found`, `400 invalid_key`, `400 invalid_value` (with `field`, `row`, `column`), `409 version_conflict`, `413 payload_too_large`, `400 unknown_project`.

---

## 111. `dataStores.entries.insert` — insert one row into a table store

```
POST /data-stores/:id/entries
```

`status: required` · served today

Params: `id` (path, string, required), `value` (body, object, required), `ttlSeconds` (body, integer), `project` (query, string). Returns `DataStoreEntry` (success status 201).

Table stores only; the server generates the key. Body `{value: row, ttlSeconds?}`; the server answers `201`. A bad row is `400 invalid_value`.

Project rule: optional `?project=`, per call then client default, otherwise omitted (the server uses the account's default project); an unknown project is `400 unknown_project`.

Errors (informational; status + code pass through as the ordinary `ApiError`): `404 data_store_not_found`, `400 invalid_value`, `413 payload_too_large`, `400 unknown_project`.

---

## 112. `dataStores.entries.increment` — atomically add to a numeric entry

```
POST /data-stores/:id/entries/:key/increment
```

`status: required` · served today

Params: `id` (path, string, required), `key` (path, string, required), `by` (body, number), `project` (query, string). Returns `DataStoreEntry`.

Omitted `by` sends no body, which the server reads as increment by 1. A missing key starts from 0; a non-numeric entry is `400 invalid_value`.

Project rule: optional `?project=`, per call then client default, otherwise omitted (the server uses the account's default project); an unknown project is `400 unknown_project`.

Errors (informational; status + code pass through as the ordinary `ApiError`): `404 data_store_not_found`, `400 invalid_body`, `400 invalid_value`, `400 unknown_project`.

---

## 113. `dataStores.entries.delete` — delete one entry by key

```
DELETE /data-stores/:id/entries/:key
```

`status: required` · served today

Params: `id` (path, string, required), `key` (path, string, required), `project` (query, string). Returns `void` (success status 204).

The server answers `204`; the wrapper returns nothing. A missing key is `404 entry_not_found`.

Project rule: optional `?project=`, per call then client default, otherwise omitted (the server uses the account's default project); an unknown project is `400 unknown_project`.

Errors (informational; status + code pass through as the ordinary `ApiError`): `404 data_store_not_found`, `404 entry_not_found`, `400 unknown_project`.

---

## 114. `dataStores.entries.query` — filter and order a table store's rows

```
GET /data-stores/:id/entries
```

`status: required` · served today

Params: `id` (path, string, required), `where` (query, object), `order` (query, string), `limit` (query, integer), `project` (query, string). Returns `DataStoreRowSet`.

Same route as `entries.list`, in QUERY MODE: the server switches to it when `order` or any `where[col]` key is present, and then answers `{items}` only (no `nextCursor`, no `cursor`/`prefix`). `where` is an object sent as one `where[<col>]=<value>` query key per column (a column once only; a malformed filter is `400 invalid_query`).

Project rule: optional `?project=`, per call then client default, otherwise omitted (the server uses the account's default project); an unknown project is `400 unknown_project`.

Errors (informational; status + code pass through as the ordinary `ApiError`): `404 data_store_not_found`, `400 invalid_query`, `400 invalid_cursor`, `400 unknown_project`.

## 115. `endpoints.list` — list Endpoints

```
GET /endpoints[?tag=<tag>]
```

`status: required` · served today

Params: `tag` (query, string, optional). Returns `EndpointSummary[]`.

The discovery operation for the Endpoint domain, mirroring §25: it is how a caller
finds the `key` to pass to §18, and how tag mode reaches Endpoints. **No `project`
parameter.**

The optional `tag` query narrows the list: a row is kept when one of its tags equals
the value or starts with the value plus `.` (segment-bounded: `action.order` matches
`action.order` and `action.order.confirm`, not `action.orders`). Wrappers send
`?tag=` only when a non-blank tag was given; a single value, no multi-tag OR.

**Response `200`** — envelope key `endpoints`; the wrapper unwraps.

```json
{
  "endpoints": [
    {
      "id": "ep_01H…",
      "key": "send-email",
      "displayName": "Send email",
      "description": "",
      "updatedAt": "2026-07-22T18:03:00.000Z",
      "invokeUrl": "https://api.w6w.io/endpoints/send-email/invoke",
      "status": "ready",
      "incomplete": false,
      "archivedAt": null,
      "tags": ["action.order"]
    }
  ]
}
```

Names: TS `client.endpoints.list(opts?)` · Python `client.endpoints.list(tag=None)` ·
CLI `w6w endpoints list [--tag <tag>]`. `w6w ls endpoints` keeps listing through the
unstable `console.endpoints` namespace.

> **At contract `0.17.0` `endpoints.list` was added** (§115) and `tag` joined
> `workflows.list` and `functions.list`; `FunctionSummary` / `EndpointSummary` carry
> `tags`. The operation count goes from 121 to 122.

> **At contract `0.18.0` ownership fields were added, no operation.** `me` gains
> `capabilities.userScopedCredentials`; `connections.list` / `connections.get` rows gain
> `accessScope`; `modelRoutes.list` / `get` gain `credentialMode`, `credentialSelection` and
> a nullable `connectionId`; `modelRoutes.complete` gains the error codes
> `personal_key_required`, `personal_key_unavailable`, `ai_credential_policy_denied` and
> `user_context_required`. The operation count stays 122. Credential management itself stays
> console-only; the personal-defaults, tenant-policy and route-readiness clients are node
> `console` additions, not in this contract.

> **At contract `0.19.0` connection keep-alive fields were added, no operation.**
> `connections.list` / `connections.get` rows gain `autoRefresh`, `lastRefreshedAt` and
> `refreshFailingSince` (§2), all optional; `lastRefreshedAt` is no longer described as
> redacted. `state: "broken"` is also set at once when a refresh needs a new sign-in. The
> operation count stays 122. The write side — `autoRefresh` on connection create / update and
> on the OAuth start, `refreshable` on an app's auth methods, and the `422 credential_invalid`
> sign-in refusal with `error.hookCode` — is node `console` only, since connection create /
> update / OAuth stay out of this contract.

---

## Explicitly out of scope for this version

Named so nobody adds them ad hoc in one language — this list is the `outOfScope`
array in `endpoints.json`, all twelve entries:

the app catalog's browse, search and paging (`apps.byIds`, §47, is the one
in-scope read; app-definition management is in scope as `appManagement.*`,
§§94-100), endpoints' management routes, project writes (`projects.list`,
§49, is the one in-scope read), vault, tokens, schedules, triggers,
subscriptions, tenants, `runs.get`, `workflows.listRuns`, and **connection
create / update / test / OAuth** (`connections.list`, `get` and `delete` — §§2,
45, 46 — are in scope).

They all exist on the API. They are not in the wrappers until they are in
`endpoints.json`.

> `vars` was on this list in the 07-24 contract and is **no longer** — the full
> `vars.*` CRUD is in scope at v0.1.0 (§§11–16).
>
> **`functions` and every workflow write left this list at contract `0.5.0`**
> (§§20–29). The entry that covered them read "all write operations on
> connections and workflows", and the two halves turned out not to belong
> together: a connection write is an interactive studio flow (an OAuth round
> trip, a live credential test), and half of one in an SDK is worse than none,
> while a workflow or Function write is a plain stateless POST/DELETE over an
> already-resolved body. Connections stay. `workflows.listRuns` is new to the
> list rather than newly excluded — the run-history surface is deliberately
> still console-only, and naming it here is what keeps it from arriving by
> association with the definition operations that did land.
>
> **At contract `0.7.0` the bare `apps` and `projects` entries narrowed, and the
> connections entry shrank from "all write operations" to create / update / test /
> OAuth.** `connections.delete` is a stateless authorized DELETE, not an
> interactive flow, so it joined `get`; the connect flows still do not belong in
> a wrapper. `apps` and `projects` keep everything but the one bounded read each
> (§§47, 49).
>
> **At contract `0.8.0` three Function operations changed shape.** `functions.update`
> takes an optional `ifUnmodifiedSince` header (the save token; a stale one answers
> `409 function_stale`), and `functions.create`, `functions.update` and `functions.get`
> now return `updatedAt`, the value to send back as that token. The operation count
> stays 58.

> **At contract `0.9.0` `connections.delete` gained an optional `force` query
> parameter** and the `409 connection_in_use` refusal is documented (§46). The
> operation count stays 58; the dependents read (`GET /connections/:id/dependents`)
> is console-only and not in this contract.

> **At contract `0.10.0` six model operations were added** (§§52-57), first as
> `planned` and flipped to `required` once the server routes landed on the same branch:
> `models.list`, `models.get`, `modelRoutes.list`, `modelRoutes.get`,
> `modelRoutes.complete` and `modelUsage.query`, and the `connections.delete`
> notes gained the `routes` dependents and the `brokenRoutes` forced field (§46).
> The operation count goes from 58 to 64. Catalog edits, rates, discovery, budgets
> and route create/update/delete are node `console` group only, not in this contract.

> **At contract `0.11.0` the binary-body notion and twelve asset operations were
> added** (§§58-69): `bodyEncoding` / `responseEncoding` (Conventions, "Binary
> bodies"), and `assets.uploads.{create,putEntry,finalize,get,abort}` plus
> `assets.{get,versions,files,content,archiveDownload,archive,purge}`.
> `assets.archiveDownload` is `serverImplemented: false`. The operation count goes
> from 64 to 76. The storage-binding and agent-settings admin routes are node
> `console` group only, not in this contract.

> **At contract `0.14.0` seven app-management operations were added** (§§94-100):
> `appManagement.{list,get,preview,register,updateSource,sync,remove}`. The operation
> count goes from 100 to 107. The operator source-grant API is not in this contract, and
> `@w6w/sdk/console` `apps.*` is unchanged.

> **At contract `0.15.0` fourteen data-store operations were added** (§§101-114):
> `dataStores.{list,get,create,update,archive,importCsv,exportCsv}` and
> `dataStores.entries.{list,get,set,insert,increment,delete,query}`, plus the text
> encodings `bodyEncoding: "csv"` / `responseEncoding: "text"` (Conventions, "Text
> bodies"). The operation count goes from 107 to 121.
