# Endpoint catalog

The operations every wrapper must support, at the current `VERSION`. The
machine-readable form is [`../endpoints.json`](../endpoints.json); this document
is the human one. They must agree — CI checks that.

The cross-language *implementation* rules that sit behind this catalog — types,
error model, env handling, toolchains, conformance runner — are pinned in
[implementation.md](./implementation.md). This file says *what the API is*; that
file says *how three languages must render it identically*.

## Conventions

**Base URL.** All routes live at the **root** of the API's host — `main.ts`
mounts the router at `/`, because the host already says "api" and
`api.w6w.io/api/vars` reads as a mistake. A wrapper takes an **origin** like
`https://api-s2.w6w.dev` and appends **nothing**: `basePath` is `""` as of
contract 0.2.0. The exact join rule (strip trailing slashes, preserve any
configured path) is pinned in
[implementation.md §2](./implementation.md#2-configuration-and-environment).

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
success, and a run that comes back `200` with `status: "failed"` is **data**, not
an exception. See [implementation.md §4](./implementation.md#4-outcomes-that-are-not-errors).

**Addressing.** Assets are created by their human-chosen `key`/`name` and updated
or deleted by their server-issued `doc_…`/`var_…` id — the wrapper mirrors the
server exactly (D6). Read-by-key exists only where the server offers a
`by-key`/`by-name` route; there is **no client-side list-then-filter** in any
wrapper (D12, and `README.md` "What a wrapper is").

**What this file does not cite.** Route behaviour below is described and dated,
never traced to a file and line inside the server. The host is closed (STRATEGY
§5.1) and naming its handlers by path would tell a reader of this package
nothing it can act on — see the note at the top of
[implementation.md](./implementation.md), which applies here identically. Verify
a claim against the API, not against a path you cannot open.

**Naming.** Operation names in `endpoints.json` are the contract. Each language
renders them in its own idiom but the mapping is mechanical and must not drift.
This table is generated from each operation's `naming` entry and must match it
character-for-character:

| Operation | Node / CLI (TS) | Python | CLI command |
|-----------|-----------------|--------|-------------|
| `me` | `client.me()` | `client.me()` | `w6w me` |
| `connections.list` | `client.connections.list()` | `client.connections.list()` | `w6w connections list` |
| `workflows.list` | `client.workflows.list(opts?)` | `client.workflows.list(project=None)` | `w6w workflows list [--project <id>]` |
| `workflows.run` | `client.workflows.run(id, opts?)` | `client.workflows.run(id, wait=False, variables=None, trigger=None, input=None)` | `w6w workflows run <id> [--wait] [--input <json>]` |
| `documents.list` | `client.documents.list(opts?)` | `client.documents.list(project=None)` | `w6w documents list [--project <id>]` |
| `documents.get` | `client.documents.get(id, opts?)` | `client.documents.get(id, project=None)` | `w6w documents get <id> [--project <id>]` |
| `documents.getByKey` | `client.documents.getByKey(key, opts?)` | `client.documents.get_by_key(key, project=None)` | `w6w documents get-by-key <key> [--project <id>]` |
| `documents.create` | `client.documents.create(input, opts?)` | `client.documents.create(key, content, format=None, description=None, project=None)` | `w6w documents create <key> --content <text> [--format <f>] [--description <d>] [--project <id>]` |
| `documents.update` | `client.documents.update(id, patch, opts?)` | `client.documents.update(id, content=None, format=None, description=None, project=None)` | `w6w documents update <id> [--content <text>] [--format <f>] [--description <d>] [--project <id>]` |
| `documents.delete` | `client.documents.delete(id, opts?)` | `client.documents.delete(id, project=None)` | `w6w documents delete <id> [--project <id>]` |
| `vars.list` | `client.vars.list()` | `client.vars.list()` | `w6w vars list` |
| `vars.get` | `client.vars.get(id)` | `client.vars.get(id)` | `w6w vars get <id>` |
| `vars.getByName` | `client.vars.getByName(name)` | `client.vars.get_by_name(name)` | `w6w vars get-by-name <name>` |
| `vars.create` | `client.vars.create(input)` | `client.vars.create(name, type, value, description=None)` | `w6w vars create <name> --type <t> --value <v> [--description <d>]` |
| `vars.update` | `client.vars.update(id, patch)` | `client.vars.update(id, type=None, value=None, description=None)` | `w6w vars update <id> [--type <t>] [--value <v>] [--description <d>]` |
| `vars.delete` | `client.vars.delete(id)` | `client.vars.delete(id)` | `w6w vars delete <id>` |
| `functions.run` | `client.functions.run(name, opts?)` | `client.functions.run(name, payload=None)` | `w6w functions run <name> [--payload <json>]` |
| `endpoints.run` | `client.endpoints.run(name, opts?)` | `client.endpoints.run(name, payload=None)` | `w6w endpoints run <name> [--payload <json>]` |
| `run` | `client.run(input)` | `client.run(urn, action=None, payload=None)` | `w6w run <urn> [--action <a>] [--payload <json>]` |

`me` additionally registers **`w6w info`** as a CLI alias (`cliAlias` in
`endpoints.json`, D8) — same operation, second spelling, so the word used in the
intake keeps working at the command line.

Every CLI command must also answer `--help` at group and command level, generated
from `endpoints.json` — see [cli.md](./cli.md).

**Status field.** All twenty-nine operations now carry `"status": "required"`.
`documents.getByKey`, `vars.getByName` and `run` were implemented server-side
2026-07-28; `me` was fixed the same day to call the server's real `/auth/me`
route directly rather than wait on a never-built `/me` alias.
`me`'s `serverImplemented` stays `"partial"` — identity is fully live, but the
optional `versions` block does not exist server-side yet, and every wrapper
tolerates its absence. `status` records **server** readiness, not wrapper
obligation — all twenty-nine are implemented and tested
against a mocked transport in every wrapper
(see [implementation.md §10](./implementation.md#10-conformance-runner)).

---

## 1. `me` — caller identity and versions

```
GET /auth/me
```

`status: required` · `serverImplemented: partial`

**Fixed 2026-07-28.** Every wrapper calls `/auth/me` directly — the server's
real, already-live identity route (verified live: `200`,
`{tenant, subject, account, role}`) — rather than waiting on the never-built
`/me` alias D15 originally specced. Its live consumer is the studio's
Session modal.

**Still missing:** the `versions` block. The server does not send one today;
every wrapper tolerates its absence and fills in `versions.wrapper` itself
(below).

Returns who the caller is, plus the versions of the w6w components involved in
answering the call. The version block is the reason this operation earns its
place in a minimal surface: it is what makes a bug report actionable.

**Response `200`** — the body is **flat**. There is no wrapping object around the
identity fields; a nested envelope would need a second identity handler or would
break the studio (D15).

```json
{
  "tenant": "default",
  "subject": "user_01H…",
  "account": "default",
  "role": "admin",
  "versions": {
    "composition": "server@1a2b3c4 core@a11a7ca studio@6e1c5eb",
    "wrapper": "0.1.0"
  }
}
```

The four identity fields mirror the server's `Principal`.

`versions` is **optional and additive**:

- A wrapper must tolerate it being **absent entirely** (an older server), and must
  tolerate **unknown keys inside it** — the set will grow, and adding one must
  never break an older client. Model it as a string→string map, not as a closed
  struct.
- `versions.composition` is a **build string** derived at build time from the
  composition the deploy workflow already computes, and is the literal string
  `"dev"` when that build arg is absent (D5).
- `versions.wrapper` is filled in **client-side** by the wrapper from its own
  package version — the server cannot know it.
- **Precedence on collision is server-wins.** The wrapper's own version is a
  **default** that any key the server supplied **overrides**. Concretely
  `{ wrapper: VERSION, ...body.versions }` in TypeScript,
  `{"wrapper": VERSION, **(body.get("versions") or {})}` in Python. Do **not**
  write the other order (`{**server, "wrapper": VERSION}`), which would make the
  wrapper's own value win: both readings satisfied the older wording, they differ
  observably, and this is the one field a bug report is read off — so it is
  pinned here rather than decided three times.
- **`versions` never *displays* a literal `0.0.0`** (D5). Hand-maintained
  component version numbers are unreliable (`0.0.0`/`0.0.1` placeholders nobody
  bumps), and a banner that looks authoritative while reporting `0.0.0` forever
  is worse than one that honestly says `"dev"`. If a resolved value is `0.0.0`
  or the empty string, the wrapper presents `"dev"` instead.
- **The two rules above are independent and do not conflict**, because they act
  at different layers. *Server-wins* governs the **value carried** in the
  returned object, which stays a faithful transcription of the wire.
  *Never-display-`0.0.0`* governs what a banner such as `w6w info` **prints**. So
  a server that sends `versions.wrapper: "0.0.0"` is carried through unaltered in
  the data and rendered to the user as `dev` — one precedence rule, one display
  rule, and no lane inventing a third.

### Server work still required

One thing, and it is optional by construction: add the `versions` block, sourced
from the build-time composition string. Keep it cheap — this route is called on
every CLI invocation for the version banner, so it must not touch the catalog or
do per-request version discovery. Until it lands, every wrapper returns a
`versions` map carrying only its own `wrapper` entry, which is the contracted
behaviour and not a degraded one.

The `/me` alias this section used to ask for is **not** being built: the wrappers
call `/auth/me` directly instead (see above), which is one fewer route to keep in
step for no loss of anything.

---

## 2. `connections.list` — list connections

```
GET /connections
```

`status: required` · served today

Lists the calling principal's connections, scoped by tenant/account. Credentials
are never included — the server returns a redacted projection.

**Response `200`** — envelope key `connections`; the wrapper unwraps and returns
the array.

```json
{
  "connections": [
    {
      "id": "conn_01H…",
      "appId": "sendgrid",
      "authKey": "api_key",
      "owner": "user_01H…",
      "displayName": "Marketing SendGrid",
      "state": "connected",
      "profile": {},
      "lastTestOk": true,
      "lastTestedAt": "2026-07-20T09:14:00.000Z",
      "createdAt": "2026-07-01T12:00:00.000Z",
      "updatedAt": "2026-07-20T09:14:00.000Z"
    }
  ]
}
```

Shape is `ConnectionSummary` (fields pinned in
[implementation.md §5](./implementation.md#5-wire-types)) — the stored connection
minus `credential` and `lastRefreshedAt`, both redacted server-side. Wrappers must
not define a type that includes `credential` on a list result — do not invite
callers to look for a field that will never arrive.

Kept in v0.1.0 (D4) because without it a user has no way to discover a `conn_…`
URN to pass to [`run`](#17-run--run-anything-addressable-by-urn).

---

## 3. `workflows.list` — list workflows

```
GET /workflows[?project=<id>]
```

`status: required` · served today

Lists the caller's workflow definitions. The optional `project` query filters to
one project; wrappers expose it as an optional argument.

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
every language — see [implementation.md §5](./implementation.md#5-wire-types) for
the timestamp rule.

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

| Field | Required | Notes |
|---|---|---|
| `variables` | no | Object merged into the run's **variable scope**, read by downstream expressions as `vars.*`. |
| `trigger` | no | A **string**, not an object. Defaults to `manual` server-side when omitted. |
| `input` | no | Object delivered to the **entry trigger node's own recorded output**, read by downstream steps as `steps.<triggerId>.output.<key>` — this is the field that reaches a trigger's declared fields. |

**`variables` and `input` are not interchangeable, and reach the workflow differently.** `variables`
seeds the run's variable scope; a step reads it as `vars.email`. `input` is injected into the entry
trigger node's own output; a step reads it as `steps.<triggerId>.output.email`. A trigger's declared
fields are only ever reachable through `input` — passing them as `variables` puts them in the wrong
scope and they never arrive where the workflow expects them.

**`trigger` is a plain string.** The server reads it as `RunTrigger`, whose known values today are
`manual`, `schedule`, `webhook`, `event` and `replay`. Those five are recorded in
`endpoints.json` under `knownValues` (with `closedEnum: false`) as
**documentation only**: every wrapper types the parameter as an open string
(`trigger?: string`, `trigger: str | None`) and passes it through **unvalidated**.
A wrapper that hard-codes the five would reject a request the server accepts the
day a sixth value lands, and would need a release to catch up.

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
  "steps": {}
}
```

**Response `202`** — with `?wait=true`, if it timed out still running

```json
{ "runId": "run_01H…", "status": "running" }
```

**Response `404`** — `{ "error": { "code": "unknown_workflow", … } }`
· **Response `400`** — `invalid_body` (unparseable JSON body).

Success statuses: **`200` and `202`**. Unlike every other operation here, the
response is **not** wrapped in an envelope key — the run fields are the body.

### The wait semantics matter

`?wait=true` polls **server-side** up to `RUN_WAIT_TIMEOUT_SEC` and then gives
up, returning `202` with whatever status it has. **A `202` from a waited call is
not a failure and not a timeout error** — the run is still going. Wrappers must
not raise on it. The distinction callers need is `status`, not the HTTP code, so
the wrapper's return type must expose `status` prominently and treat 200 and 202
identically.

A run that *failed* also comes back `200` with `status: "failed"` and an `error`
in the envelope — a run-level failure is data, not an HTTP error. Do not map it
to a raised exception.

Wrappers expose wait as an option: `run(id, { wait: true })`, `run(id, wait=True)`,
`w6w workflows run <id> --wait`.

**No wrapper implements client-side run polling.** The server's `?wait=true` is
the mechanism; re-implementing a poll loop in three languages is exactly the
duplication this contract exists to prevent
([implementation.md §8](./implementation.md#8-do-not-carry-over)).

Kept alongside the unified `run` (D4), which is deliberately narrower: `?wait=`,
`variables`, `trigger` and `input` have no slot in the three-field `{urn, action, payload}`
shape.

### Companion: fetching a run

`GET /runs/:id` exists and returns run state. It is **not** part of this
version's contract (`runs.get` is in `outOfScope`). Prefer the server's
`?wait=true` and add `runs.get` as a first-class operation in a later version —
added to `endpoints.json` and shipped in all three at once, like everything else.

---

## 5. `documents.list` — list documents

```
GET /documents[?project=<id>]
```

`status: required` · served today

Documents **are** project-scoped: every `documents.*` route accepts an optional
`?project=` and otherwise resolves the account's default project. An unknown project id is
`400 unknown_project`.

**Response `200`** — envelope key `documents`; the wrapper unwraps and returns the
array.

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

Addressed by the server-issued `doc_…` id, **not** by `key` (D6 — wrappers mirror
the server's addressing exactly).

**Response `200`** — envelope key `document`; the wrapper unwraps and returns the
object.

```json
{ "document": { "id": "doc_01H…", "key": "welcome-email-copy", "content": "…", "format": "markdown", "description": "…", "createdAt": "…", "updatedAt": "…" } }
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
client-side list-then-filter** — `README.md` "What a wrapper is" forbids composing
two calls to make an operation useful. If the fence never clears, wrappers ship
id-addressed only and the limitation is documented.

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

| Field | Required | Notes |
|---|---|---|
| `key` | yes | Non-empty string, **≤ 128 characters**, unique per scope + project. Create is addressed by `key` (D6). |
| `content` | yes | Raw text. Stored verbatim and **never parsed**. |
| `format` | no | One of `text` \| `markdown` \| `yaml` \| `html` \| `json`. Defaults to `text`. A **hint only** — it does not gate the content. |
| `description` | no | Free text. |

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

Addressed by the `doc_…` id, **not** by `key` (D6). `key` itself is **immutable**
— it is not in the patch body.

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

**Response `200`** — `{ "ok": true }`. The wrapper unwraps this to *nothing* — it
returns no value; there is no payload to hand back. The declared return in
`endpoints.json` is therefore **`void`**, not an `Ok` object: `Promise<void>` in
TypeScript, `None` in Python, no stdout payload in the CLI beyond its exit code.
`Ok` is not a public wrapper type — see
[implementation.md §5](./implementation.md#5-wire-types).

**Response `404`** — `unknown_document`. Deleting an unknown id is an error, not a
silent success — the delete is **not idempotent** and wrappers must not pretend
otherwise.

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
contracted — see
[implementation.md §7](./implementation.md#7-asset-addressing).

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

**Response `200`** — envelope key **`var`** (singular); the wrapper unwraps. Note
`var` is a reserved word in TypeScript: read it as a property
(`body["var"]` / `body.var`), never destructure it into a binding of that name.

```json
{ "var": { "id": "var_01H…", "name": "sender_email", "type": "string", "value": "hello@example.com", "description": "…", "createdAt": "…", "updatedAt": "…" } }
```

**Response `404`** — `{ "error": { "code": "unknown_var", … } }`

---

## 13. `vars.getByName` — fetch a variable by name

```
GET /vars/by-name/:name
```

`status: required` · `serverImplemented: true` — implemented 2026-07-28.

Names are already regex-validated (`[a-z_][a-z0-9_]*`) at create time, which is
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

| Field | Required | Notes |
|---|---|---|
| `name` | yes | Must match `^[a-z_][a-z0-9_]*$`. Create is addressed by `name` (D6). |
| `type` | yes | One of `string` \| `number` \| `boolean` \| `json`. |
| `value` | yes | Validated **server-side** against `type`. |
| `description` | no | Free text. |

**Response `201`** — envelope key `var`; the wrapper unwraps.

**Errors** — `400 invalid_name` (name rule violated), `400 invalid_type`,
`400 invalid_value` (value does not match the declared type),
`409 var_exists` (duplicate name — surface the code, do not swallow it).

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

**Response `200`** — envelope key `var`. **Response `404`** — `unknown_var`.
No `project` param.

---

## 16. `vars.delete` — delete a variable

```
DELETE /vars/:id
```

`status: required` · served today

Addressed by the `var_…` id (D6).

**Response `200`** — `{ "ok": true }`; the wrapper returns no value. The declared
return in `endpoints.json` is **`void`**, not an `Ok` object: `Promise<void>` in
TypeScript, `None` in Python, no stdout payload in the CLI beyond its exit code
(`Ok` is not a public wrapper type — see
[implementation.md §5](./implementation.md#5-wire-types)).
**Response `404`** — `unknown_var`. Not a silent success. No `project` param.

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

**Returns the OUTPUT, not an envelope.** The unified `run` is
kind-discriminated because the caller does not know what a URN will resolve to;
here the kind is settled by the operation name, so a discriminant would be a
field the caller unwraps to learn nothing.

The wire body carries the **invocation frame** (`invocationId`, `status`,
`startedAt`, `finishedAt`, `durationMs`) alongside `output`, exactly as the
unified `run` does — see §19. Since this operation's contract is "hand back the
Function's output", a wrapper keeps unwrapping `output` and needs no change;
the frame is there for a caller who reads the raw response, and the
`invocationId` in it resolves through `GET /invocations/{id}`.

**A `null` output is a successful run**, not a malformed body: a Function's
output is an opaque pass-through, and an action that returns nothing yields
`{"output": null}`. Wrappers must guard on **presence** of the `output` key
rather than on its truthiness — the shared "unwrap this envelope key" helper
each lane carries rejects null and is the wrong tool here.

| Failure | Status | Code |
|---|---|---|
| No Function of that name for the caller | `404` | `unknown_function` |
| The Function has no runnable `impl` | `422` | `function_incomplete` |

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
wrapper though the wire spells it `input` (singular here, plural for a Function).

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

`status: required` · `serverImplemented: true` — implemented 2026-07-28. Dispatch
lives in a third sibling BLL service, `bll/resolve-run.ts`, mirroring
`InvokeEndpointService`'s shape: every arm calls the same
runner an existing dedicated route already uses (`invokeAction` for `conn_`,
the Function choke point for `fn_`, `enqueueRun` for `wf_`, and
`InvokeEndpointService` itself for `ep_`, delegated verbatim). No new execution
path, and core's `Callable` is not widened — the connection/action arm is a
server-only addition to this HTTP surface.

Every arm resolves the URN with the caller's scope passed **explicitly**: two
of the underlying repos (`FunctionsRepo.load`, `EndpointsRepo.load`) accept an
optional scope and silently drop the tenant/subject predicate when it is
omitted (an ergonomic that exists for the trusted scheduler path) — the
resolver never omits it, and a URN belonging to another tenant resolves to
"not found," never to the resource.

Runs anything addressable by URN: a connection action, a workflow, a function, or
an endpoint.

**Request body**

```json
{
  "urn": "conn_01H…",
  "action": "send_email",
  "payload": { "to": "a@b.com", "subject": "Hi" }
}
```

| Field | Required | Notes |
|---|---|---|
| `urn` | yes | Resolves over **four runnable arms only** — `conn_`, `wf_`, `fn_`, `ep_` (D16). `doc_` and `var_` are **not** URN arms in v0.1.0; assets are addressed by the `documents.*` / `vars.*` operations above. |
| `action` | no | Optional because a workflow, function or endpoint URN has no action. Required in practice for a `conn_…` URN. |
| `payload` | no | Input object for the target. |

**Response** — a `kind`-discriminated envelope with exactly three arms (D3), the
same shape the endpoint-invoke route already returns, wrapped in the
**invocation frame** the server added on 2026-08-20:

```json
{
  "kind": "action",
  "value": { },
  "output": { },
  "invocationId": "inv_9f1c…",
  "status": "succeeded",
  "startedAt": "2026-08-20T09:14:02.401Z",
  "finishedAt": "2026-08-20T09:14:02.826Z",
  "durationMs": 425
}
```
```json
{ "kind": "function", "output": { }, "invocationId": "inv_…", "status": "succeeded" }
```
```json
{ "kind": "workflow", "runId": "run_01H…", "status": "queued", "startedAt": "…" }
```

The `action` and `function` arms return **`200`**; the `workflow` arm returns
**`202`**, and **`202` is a normal outcome, not an error** — the run is queued,
and `runId` is how the caller follows it.

Wrappers must **switch on `kind`** and must **tolerate an unknown future `kind`**
rather than crashing.

**The frame is additive.** Nothing was renamed, removed or re-typed, so a
wrapper written against the three-arm shape keeps working unchanged. What it
adds:

| Field | Notes |
|---|---|
| `invocationId` | This attempt's id, `inv_…`. Resolves through `GET /invocations/{id}` to the stored inputs, output, error and timing. **Not** the same as `runId` — see below. |
| `status` | The **platform's** verdict on the attempt: `succeeded`, `failed`, or `queued` on the workflow arm. |
| `startedAt` / `finishedAt` / `durationMs` | When the attempt ran, and for how long. |
| `output` (action arm) | The action's return value under the name every arm shares. `value` carries the identical payload and is kept, now **deprecated** — new callers read `output`. |

**`invocationId` is not `runId`.** `invocationId` names the CALL; `runId` names
the queued workflow RUN a call may have started. On the workflow arm both are
present and they mean different things, which is exactly why the existing name
was not generalised.

**`status` is not the target's status.** A SendGrid send whose `output` reads
`{"statusCode": 202}` is SendGrid describing its own request. Whether *this*
platform considers the call a success is `status`, and only `status`.

**A failed call carries the frame too.** The `4xx` body puts `invocationId`,
`status: "failed"` and the timing beside its `error`, so the attempt you most
need to explain is exactly as lookup-able as one that worked.

Unlike `workflows.run`, this operation has no `?wait=`, no `variables`, no
`trigger` and no `input` — they have no slot in the three-field `{urn, action, payload}` shape
(D4). Use `workflows.run` when you need them.

**Errors** — the usual envelope. Note `424` in particular: an execute-phase
failure is the target's own hook throwing, almost always the upstream app
returning an error, and the server reports it as `424 Failed Dependency` rather
than a 5xx. The
reason is in [implementation.md §3](./implementation.md#3-error-model).

---

## 20. `workflows.get` — fetch a workflow definition

```
GET /workflows/:id
```

`status: required` · served today

**No envelope.** The response body *is* the payload, all three fields of it —
there is no key to unwrap, and a wrapper's `unwrap` helper does not apply here.

**Response `200`**

```json
{
  "workflow": { "manifestVersion": "2", "id": "wf_01H…", "name": "welcome-email", "steps": [] },
  "sourceRef": null,
  "updatedAt": "2026-07-22T18:03:00.000Z"
}
```

`workflow` is the stored definition overlaid with the authoritative `status` and
`tags` columns, so a freshly created workflow that carries neither inline still
reports its real lifecycle state. It stays **opaque** in every lane
(`Record<string, unknown>` in TS, `dict` in Python): `steps[]` carry node types
the engine owns and extends, and a wrapper that modelled them would reject a
workflow a newer server accepts.

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

**The server does not mint ids.** `validateDefinition` rejects a body with no
`id` as `400 invalid_workflow`, so every wrapper mints one client-side
(`wf_<uuid>`) when the definition carries none, and forwards an `id` the caller
supplied untouched. That is not a convenience: without it the most natural call
there is — "create this workflow" — fails.

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
*this* call"; a workflow that already had a schedule is not re-scheduled.

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

Two 409s, and the difference matters: `409 workflow_stale` means the precondition
did not match and **is** recoverable by reloading and re-saving;
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
`409 workflow_not_archived`, and a wrapper must **not** catch that and archive on
the caller's behalf: a two-step destructive path completed silently is how a
caller deletes something they only meant to look at.

Deleting an unknown id is `404 unknown_workflow`, not a silent success.

---

## 25. `functions.list` — list Functions

```
GET /functions
```

`status: required` · served today

The discovery operation for this domain, in for the same reason §2 and §3 are
(D4): it is how a caller finds the `key` to pass to §17.

**No `project` parameter.** Unlike workflows and documents this route reads no
`?project=` at all, and sending one would be inventing a parameter.

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
      "valid": true
    }
  ]
}
```

Shape is `FunctionSummary`. `valid` is server-computed by the same predicate the
invoke path guards with, so runnability needs no second call. `displayName` falls
back to `key` server-side and is never a substitute for it — `key` is what §17
takes. Unpaginated today, same as §3.

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
  "function": { "manifestVersion": "1", "id": "fn_01H…", "key": "send-email", "inputs": [] },
  "valid": true
}
```

Wrappers **must keep `valid` a top-level sibling** rather than splicing it into
the definition: it is computed per request, it is not part of the stored document
(`rfcs/function.md`), and folding it in would put it inside the object a caller
sends straight back to §28. (The console surface's own `console.functions.get`
does splice it, for the studio's sake. That is not this surface.)

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

The create half of the server's single upsert route. **The server does not mint
ids** — wrappers mint `fn_<uuid>` when the definition carries none, exactly as
§21 does.

**`key` is not minted.** It is the name the Function is *called* by, so it is the
caller's to choose. The server validates it on **first save only** (3–39
characters, starts lowercase, lowercase letters/digits/single hyphens, no `_`),
deliberately leaving legacy keys alone on update; that grammar is what keeps
`/functions/:idOrKey/invoke` unambiguous.

**`impl` is optional.** A Function with none is a valid draft that stores fine
and answers `valid: false`. Wrappers must not require it.

**Response `201`** — envelope key `function`; the wrapper unwraps to
`{ id, key }`.

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

There is **no concurrency precondition on this route** — workflows have one,
Functions do not — so the write is last-write-wins, and no wrapper should invent
a header the server does not read.

Do not send `valid` back: it is not part of the stored document, which is exactly
why §26 leaves it outside the definition.

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

There is **no archive step** on this domain — unlike a workflow, a Function
deletes in one call.

**Nothing checks for callers first.** A Function may be referenced by an
Endpoint, by a Workflow step, or by another Function's `impl` (D-8), and the
server does not walk those references — they break at call time.

---

## Explicitly out of scope for this version

Named so nobody adds them ad hoc in one language — this list is the `outOfScope`
array in `endpoints.json`, all twelve entries:

apps, endpoints, projects, vault, tokens, schedules, triggers, subscriptions,
tenants, `runs.get`, `workflows.listRuns`, and
**all write operations on connections**.

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
> list rather than newly excluded — the run-history surface is deliberately still
> console-only, and naming it here is what keeps it from arriving by association
> with the definition operations that did land.
