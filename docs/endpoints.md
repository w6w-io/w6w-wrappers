# Endpoint catalog

The operations every wrapper must support, at the current `VERSION`. The
machine-readable form is [`../endpoints.json`](../endpoints.json); this document
is the human one. They must agree — CI checks that.

The cross-language *implementation* rules that sit behind this catalog — types,
error model, env handling, toolchains, conformance runner — are pinned in
[implementation.md](./implementation.md). This file says *what the API is*; that
file says *how three languages must render it identically*.

## Conventions

**Base URL.** All routes live under `/api` (`main.ts` mounts the API there;
`/health` is the one exception and sits at the root). A wrapper takes an
**origin** like `https://api-s2.w6w.dev` and appends `basePath` (`/api`) itself
— users should never have to type the prefix. The exact join rule (strip
trailing slashes, never double an already-present `/api`) is pinned in
[implementation.md §2](./implementation.md#2-configuration-and-environment).

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

**Internal citations.** Lines below marked cite paths inside the
**private** the server / the studio repos. They are here because
this directory is root-tracked and private. **Every citation must be
stripped before any of this text ships in a public wrapper repo's README or docs
site** — STRATEGY §5.1 keeps the host closed, and a public file that names its
route handlers by path leaks the host's shape for no user benefit.

**Naming.** Operation names in `endpoints.json` are the contract. Each language
renders them in its own idiom but the mapping is mechanical and must not drift.
This table is generated from each operation's `naming` entry and must match it
character-for-character:

| Operation | Node / CLI (TS) | Python | CLI command |
|-----------|-----------------|--------|-------------|
| `me` | `client.me()` | `client.me()` | `w6w me` |
| `connections.list` | `client.connections.list()` | `client.connections.list()` | `w6w connections list` |
| `workflows.list` | `client.workflows.list(opts?)` | `client.workflows.list(project=None)` | `w6w workflows list [--project <id>]` |
| `workflows.run` | `client.workflows.run(id, opts?)` | `client.workflows.run(id, **opts)` | `w6w workflows run <id> [--wait]` |
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
| `run` | `client.run(input)` | `client.run(urn, action=None, payload=None)` | `w6w run <urn> [--action <a>] [--payload <json>]` |

`me` additionally registers **`w6w info`** as a CLI alias (`cliAlias` in
`endpoints.json`, D8) — same operation, second spelling, so the word used in the
intake keeps working at the command line.

Every CLI command must also answer `--help` at group and command level, generated
from `endpoints.json` — see [cli.md](./cli.md).

**Status field.** Four of the seventeen operations carry `"status": "planned"`
(`me`, `documents.getByKey`, `vars.getByName`, `run`): the server does not serve
them yet. `status` records **server** readiness, not wrapper obligation — all
seventeen are implemented and tested against a mocked transport in every wrapper
(see [implementation.md §10](./implementation.md#10-conformance-runner)).

---

## 1. `me` — caller identity and versions

```
GET /api/me
```

`status: planned` · `serverImplemented: partial`

**What already exists.** `GET /api/auth/me` serves the entire identity half
today, returning `{tenant, subject, account, role}` for any authenticated
principal. Its live
consumer is the studio's Session modal.

**What is missing** is exactly two things: the `/api/me` **path**, and the
`versions` block. `/api/me` is mounted as an **alias of that same handler** — one
body, two paths — so the two can never diverge (D15).

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
- **`versions` never reports a literal `0.0.0`** (D5). Hand-maintained component
  version numbers are unreliable (`0.0.0`/`0.0.1` placeholders nobody bumps), and
  an endpoint that looks authoritative while reporting `0.0.0` forever is worse
  than one that honestly says `"dev"`.

### Server work required

Two things, both small: alias `/api/me` onto the existing `/auth/me` handler, and
add the `versions` block sourced from the build-time composition string. Keep it
cheap — this is called on every CLI invocation for the version banner, so it must
not touch the catalog or do per-request version discovery.

---

## 2. `connections.list` — list connections

```
GET /api/connections
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
GET /api/workflows[?project=<id>]
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
POST /api/workflows/:id/run[?wait=true]
```

`status: required` · served today

Enqueues a run. This is asynchronous by default: the server returns immediately
and the run queue executes it.

**Request body** (all fields optional)

```json
{
  "variables": { "email": "a@b.com" },
  "trigger": { "type": "manual" }
}
```

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
`variables` and `trigger` have no slot in the three-field `{urn, action, payload}`
shape.

### Companion: fetching a run

`GET /api/runs/:id` exists and returns run state. It is **not** part of this
version's contract (`runs.get` is in `outOfScope`). Prefer the server's
`?wait=true` and add `runs.get` as a first-class operation in a later version —
added to `endpoints.json` and shipped in all three at once, like everything else.

---

## 5. `documents.list` — list documents

```
GET /api/documents[?project=<id>]
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
GET /api/documents/:id[?project=<id>]
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
GET /api/documents/by-key/:key[?project=<id>]
```

`status: planned` · `serverImplemented: false` — needs a small server route,
fenced by BLK-1.

The repository method already exists and is already called by `POST /documents`
for its duplicate check — only the HTTP route is
missing.

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
POST /api/documents[?project=<id>]
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
PATCH /api/documents/:id[?project=<id>]
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
DELETE /api/documents/:id[?project=<id>]
```

`status: required` · served today

Addressed by the `doc_…` id (D6).

**Response `200`** — `{ "ok": true }`. The wrapper unwraps this to *nothing* — it
returns no value; there is no payload to hand back.

**Response `404`** — `unknown_document`. Deleting an unknown id is an error, not a
silent success — the delete is **not idempotent** and wrappers must not pretend
otherwise.

---

## 11. `vars.list` — list variables

```
GET /api/vars
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
GET /api/vars/:id
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
GET /api/vars/by-name/:name
```

`status: planned` · `serverImplemented: false` — needs a small server route,
fenced by BLK-1.

The repository method already exists and is already called by `POST /vars` for its
duplicate check — only the HTTP route is missing.

D12: key-addressed reads become server routes rather than client-side
composition. No list-then-filter workaround. If the fence never clears, wrappers
ship id-addressed only and the limitation is documented.

Same envelope (`{ "var": … }`) and same `404 unknown_var` as
[`vars.get`](#12-varsget--fetch-a-variable-by-id).

---

## 14. `vars.create` — create a variable

```
POST /api/vars
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
PATCH /api/vars/:id
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
DELETE /api/vars/:id
```

`status: required` · served today

Addressed by the `var_…` id (D6).

**Response `200`** — `{ "ok": true }`; the wrapper returns no value.
**Response `404`** — `unknown_var`. Not a silent success. No `project` param.

---

## 17. `run` — run anything addressable by URN

```
POST /api/run
```

`status: planned` · `serverImplemented: false` — needs the URN resolver **and**
the route, both fenced by BLK-1.

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
same shape the endpoint-invoke route already returns:

```json
{ "kind": "action", "value": { } }
```
```json
{ "kind": "function", "output": { } }
```
```json
{ "kind": "workflow", "runId": "run_01H…", "status": "queued" }
```

The `action` and `function` arms return **`200`**; the `workflow` arm returns
**`202`**, and **`202` is a normal outcome, not an error** — the run is queued,
and `runId` is how the caller follows it.

Wrappers must **switch on `kind`** and must **tolerate an unknown future `kind`**
rather than crashing.

Unlike `workflows.run`, this operation has no `?wait=`, no `variables` and no
`trigger` — they have no slot in the three-field `{urn, action, payload}` shape
(D4). Use `workflows.run` when you need them.

**Errors** — the usual envelope. Note `424` in particular: an execute-phase
failure is the target's own hook throwing, almost always the upstream app
returning an error, and the server reports it as `424 Failed Dependency` rather
than a 5xx. The
reason is in [implementation.md §3](./implementation.md#3-error-model).

---

## Explicitly out of scope for this version

Named so nobody adds them ad hoc in one language — this list is the `outOfScope`
array in `endpoints.json`, all twelve entries:

apps, functions, endpoints, projects, vault, tokens, schedules, triggers,
subscriptions, tenants, `runs.get`, and
**all write operations on connections and workflows**.

They all exist on the API. They are not in the wrappers until they are in
`endpoints.json`.

> `vars` was on this list in the 07-24 contract and is **no longer** — the full
> `vars.*` CRUD is in scope at v0.1.0 (§§11–16).
