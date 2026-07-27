# Endpoint catalog

The operations every wrapper must support, at the current `VERSION`. The
machine-readable form is [`../endpoints.json`](../endpoints.json); this document
is the human one. They must agree — CI checks that.

## Conventions

**Base URL.** All routes live under `/api` (`main.ts` mounts the API there;
`/health` is the one exception and sits at the root). A wrapper takes a base URL
like `https://api-s2.w6w.dev` and appends `/api` itself — users should never
have to type the prefix.

**Auth.** `Authorization: Bearer <token>`. Every route below requires it; there
are no anonymous operations in this surface.

**Errors.** The API returns a consistent envelope:

```json
{ "error": { "code": "unknown_workflow", "message": "Not registered." } }
```

Wrappers map this to an idiomatic raised error carrying `code`, `message`, and
the HTTP status — a typed `W6WError` in Node/CLI, a `W6WError(Exception)` in
Python. Never surface a raw HTTP client error to the caller.

**Naming.** Operation names in `endpoints.json` are the contract. Each language
renders them in its own idiom but the mapping is mechanical and must not drift:

| Operation | Node / CLI (TS) | Python | CLI command |
|-----------|-----------------|--------|-------------|
| `me` | `client.me()` | `client.me()` | `w6w me` |
| `connections.list` | `client.connections.list()` | `client.connections.list()` | `w6w connections list` |
| `workflows.list` | `client.workflows.list()` | `client.workflows.list()` | `w6w workflows list` |
| `workflows.run` | `client.workflows.run(id, opts)` | `client.workflows.run(id, **opts)` | `w6w workflows run <id>` |

Every CLI command must also answer `--help` at group and command level, generated
from `endpoints.json` — see [cli.md](./cli.md).

---

## 1. `me` — user info and versions

```
GET /api/me
```

> **This endpoint does not exist yet.** The server has no user-info or version
> route today — `/health` returns only `{"ok": true}`, and there is no `/me`.
> It must be built in the server before any wrapper can claim conformance.
> The shape below is the spec to build against; see *Server work required*.

Returns who the caller is, plus the versions of every w6w component involved in
answering the call. The version block is the reason this endpoint earns its
place in a minimal surface: it is what makes a bug report actionable.

**Response `200`**

```json
{
  "user": {
    "subject": "user_01H…",
    "tenant": "default",
    "account": "default",
    "role": "admin"
  },
  "versions": {
    "server": "0.3.1",
    "core": "0.1.0",
    "runtime": "0.0.1",
    "types": "0.1.0",
    "wrapper": "0.1.0"
  }
}
```

`user` mirrors the server's `Principal` (`packages/api/principal.ts`):
`tenant`, `subject`, `account`, `role`.

`versions.wrapper` is filled in **client-side** by the wrapper from its own
package version — the server cannot know it. Every other key comes from the
server. Wrappers must tolerate unknown extra keys in `versions`; the set will
grow, and adding one must never break an older client.

### Server work required

`GET /api/me` needs to be added to the server. Two notes for whoever
builds it:

- The version numbers are currently unreliable as a source. `packages/core/packages/*/deno.json`
  carry `0.0.0`/`0.0.1` placeholders that nobody bumps, and the server
  has no version at all. Either start maintaining them or derive the values at
  build time (git describe / build arg) — but decide, because an endpoint that
  reports `0.0.0` forever is worse than no endpoint, since it looks trustworthy.
- Keep it cheap. This will be called on every CLI invocation for the version
  banner, so it must not touch the catalog or do per-request version discovery.

---

## 2. `connections.list` — list connections

```
GET /api/connections
```

Lists the calling principal's connections, scoped by tenant/account. Credentials
are never included — the server returns a redacted projection.

**Response `200`**

```json
{
  "connections": [
    {
      "id": "conn_01H…",
      "app": "sendgrid",
      "auth": "api_key",
      "owner": "user_01H…",
      "state": "connected",
      "label": "Marketing SendGrid",
      "createdAt": "2026-07-01T12:00:00.000Z",
      "lastTestedAt": "2026-07-20T09:14:00.000Z"
    }
  ]
}
```

Shape is `Connection` from `@w6w/types` (`packages/core/packages/types/src/connection.ts`)
minus `credential` and `lastRefreshedAt`, both redacted server-side. Wrappers
must not define a type that includes `credential` on a list result — do not
invite callers to look for a field that will never arrive.

---

## 3. `workflows.list` — list workflows

```
GET /api/workflows[?project=<id>]
```

Lists the caller's workflow definitions. The optional `project` query filters to
one project; wrappers expose it as an optional argument.

**Response `200`**

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

Shape is `WorkflowSummary` (the server).
Note `updatedAt` is serialized from a `Date` — it arrives as an ISO-8601 string
over the wire. Python wrappers should parse it to an aware `datetime`; TS
wrappers keep it a string unless the whole SDK adopts date parsing.

This endpoint is **not paginated today**. Wrappers must still return a list type
that can grow a cursor later without a breaking change — return a list, not a
bare array aliased into the public type, so pagination can be added behind it.

---

## 4. `workflows.run` — trigger a workflow

```
POST /api/workflows/:id/run[?wait=true]
```

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
  "output": { },
  "steps": [ ]
}
```

**Response `202`** — with `?wait=true`, if it timed out still running

```json
{ "runId": "run_01H…", "status": "running" }
```

**Response `404`** — `{ "error": { "code": "unknown_workflow", … } }`

### The wait semantics matter

`?wait=true` polls server-side up to `RUN_WAIT_TIMEOUT_SEC` and then gives up,
returning `202` with whatever status it has. **A `202` from a waited call is not
a failure and not a timeout error** — the run is still going. Wrappers must not
raise on it. The distinction callers need is `status`, not the HTTP code, so the
wrapper's return type must expose `status` prominently and treat 200 and 202
identically.

A run that *failed* also comes back `200` with `status: "failed"` and an `error`
in the envelope — a run-level failure is data, not an HTTP error. Do not map it
to a raised exception.

Wrappers expose wait as an option: `run(id, { wait: true })`, `run(id, wait=True)`,
`w6w workflows run <id> --wait`.

### Companion: fetching a run

`GET /api/runs/:id` exists and returns run state. It is **not** part of this
version's contract, but wrappers that implement `wait` by polling client-side
will need it. Prefer the server's `?wait=true` for now and add `runs.get` as a
first-class operation in a later version — added to `endpoints.json` and shipped
in all three at once, like everything else.

---

## Explicitly out of scope for this version

Named so nobody adds them ad hoc in one language: apps/catalog, functions,
endpoints, projects, vars, vault, tokens, schedules, triggers/subscriptions,
tenants, and every write operation on connections and workflows. They all exist
on the API. They are not in the wrappers until they are in `endpoints.json`.
