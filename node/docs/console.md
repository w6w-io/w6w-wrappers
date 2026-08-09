# `@w6w/sdk/console` — the console-only surface

The other documents in this directory describe the **published partner contract**: `sdk-surface.md`
catalogs every symbol on `@w6w/sdk`'s root export (`import { W6wClient } from "@w6w/sdk"`), and
`endpoints.json` / `docs/parity.md`'s "Adding an operation" process govern how that surface grows in
lockstep across all three wrappers.

This file covers a **different, second entry point**: `@w6w/sdk/console`. It is studio-internal and
unstable, not part of the published partner contract —

- it is **not** modeled in `packages/wrappers/endpoints.json`'s `operations[]`, so it is invisible
  to the conformance runner and to `docs/parity.md`'s process;
- it is **not** re-exported from the package's root barrel (`mod.ts`) — a partner importing
  `@w6w/sdk` never sees it, and `tests/surface_test.ts`'s exact-set-equality assertion is what pins
  that;
- it can change shape or disappear between any two versions without a deprecation cycle, because it
  was never a promise to a partner in the first place.

It exists as a **separate subpath export** (`deno.json`'s `"./console"`, `package.json`'s
`"./console"`) rather than a namespace hidden on `W6wClient` directly, so a host that only wants the
partner surface never pulls this code in, and a host that wants both — the operator console itself —
imports one client and gets `client.console.*` alongside everything else. It is built on the same
transport as every other namespace (`src/http.ts`, `src/errors.ts`, `src/config.ts`) and obeys the
same instance-state mechanism pin (`docs/implementation.md` §MECHANISM PIN): `client.console` holds
no state of its own beyond the host it was constructed with, so two clients in one process never
share a credential.

This is the shape the rest of the console surface (~15 more domains, in a later, unplanned phase)
will mirror: one file per domain under `src/console/`, re-exported from `src/console/mod.ts`,
appended to `ConsoleApi`'s constructor as one `this.<domain> = new <Domain>Api(host)` line.

## `console.reliability.list(days?, limit?)`

```ts
import { W6wClient } from "@w6w/sdk";
import "@w6w/sdk/console"; // pulls in client.console

const client = new W6wClient();
const board = await client.console.reliability.list(30, 5);
```

`GET /reliability/services`, with `days` and `limit` forwarded as query parameters when given (an
omitted value is dropped from the query string entirely — no `?limit=`). Relocated verbatim from the
studio's own API client (`packages/studio/src/api/client.ts:212-295`), which the field-for-field
`ReliabilityServices` shape is still PINNED by (`contracts/T4.1.1.contract.md`) — this module does
not redesign it, only gives it a second home.

**No envelope key**, unlike `client.documents.*` and `client.vars.*`: the server's
`GET /reliability/services` answers `c.json(board)`
(`packages/server/packages/api/admin/reliability.ts:407-432`), so the `ReliabilityServices`-shaped
object IS the top-level response body. `list` returns `res.body` directly and never calls this
package's `unwrap()` helper — calling `unwrap(res, "reliability")` against a real response would
throw `bad_response`, because no such key is ever sent.

Return shape — `ReliabilityServices`:

| Field         | Type                                              | Notes                                                                        |
| ------------- | ------------------------------------------------- | ---------------------------------------------------------------------------- |
| `account`     | `string`                                          |                                                                              |
| `window`      | `{ from: string; to: string; days: number }`      |                                                                              |
| `uptimeMeans` | `string`                                          | The server's own wording for what "uptime" measures here — display verbatim. |
| `definition`  | `{ id: string; version: string; source: string }` | Names the rule set that decided every `state` below.                         |
| `services`    | `ReliabilityService[]`                            | One row per external service the account calls.                              |

Each `ReliabilityService` carries `appId`, `displayName`, `state`
(`"ok" \| "degraded" \| "down" \| "unknown"`), `hasDeclaredHealth`, `calls`, `errors`
(`{ e4xx, e429, eAuth, e5xx }`), `p95Ms` (`number | null`), `openAdvisories`, `ongoingOutageId`
(`string | null`), `lastCallAt` (`string | null`), a gap-free `uptime: ReliabilityUptimeDay[]` (one
entry per calendar day, oldest first, `window.days` entries exactly — never re-synthesised or
re-sorted client-side), and `vendorStatus` (`ReliabilityVendorStatus | null`, a second and
independent signal from the vendor's own declared status page, never a restatement of `state`).

Access control is unaffected by this file: every domain reachable through `console.*` (including
`reliability`) requires only an authenticated principal server-side — the console/partner split here
is a naming and export-surface fence, not an authorization boundary. `requireOperator` gates a
different, narrower set of routes and is untouched by this change.

## `RequestOptions.headers`

`request()` (and therefore every namespace method built on it, in both the root export and
`@w6w/sdk/console`) now accepts an optional `headers?: Record<string, string>` on `RequestOptions`:

```ts
await client.request({
  method: "GET",
  path: "/reliability/services",
  headers: { "x-w6w-if-unmodified-since": someEtag },
});
```

It is applied as the **base** `Headers` the transport builds on, never the other way around:
`authorization` (the bearer) and, when a body is present, `content-type` are set **after** that
base, so a caller-supplied `headers` entry can never override either one, no matter what name it
uses. Every other header name passes through untouched.

This field is **node-only** for now; the equivalent gap in `cli`/`python` is filed separately in
this project's `FOLLOWUPS.md` and is not part of this change.

## `console.auth.*`

```ts
import { W6wClient } from "@w6w/sdk";
import "@w6w/sdk/console"; // pulls in client.console

const client = new W6wClient({ baseUrl: "https://api.example.com" }); // no token — see below
const { token, user } = await client.console.auth.login("alice", "hunter2");
```

Four methods, relocated verbatim from the studio's own API client
(`packages/studio/src/api/client.ts:249-291`), with the same field-for-field shapes it used
(`packages/studio/src/api/types.ts:10-82`) — this module does not redesign them, only gives them a
second home.

| Method                      | Route                                   | Public/authenticated                                                                          |
| --------------------------- | --------------------------------------- | --------------------------------------------------------------------------------------------- |
| `login(username, password)` | `POST /auth/login`                      | **PUBLIC** — sends no bearer (`requireAuth: false`), even on a client already holding a token |
| `signup(input)`             | `POST /auth/signup`                     | **PUBLIC** — sends no bearer (`requireAuth: false`)                                           |
| `checkAccountSlug(name)`    | `GET /auth/signup/slug-available?name=` | **PUBLIC** — sends no bearer (`requireAuth: false`)                                           |
| `createAccount(name, slug)` | `POST /accounts`                        | **AUTHENTICATED** — default `requireAuth`, re-issues the session with the new account's claim |

The three public routes are registered server-side ABOVE `app.use("*", authGuard)`
(`packages/server/packages/api/data/signup.ts:23-41`, `id/auth.ts:22-55`) and must never read a
principal — `requireAuth: false` is the ONLY way `login` can work at all, since a client with no
token configured (the normal case pre-login) would otherwise hit `requireToken`'s `ConfigError` on
every request, and `login` is how a caller gets a token in the first place. `createAccount`'s
returned token is minted `role: "user"` unconditionally, so adopting it downgrades an operator —
this namespace never writes the session itself, the caller decides.

**`getMe` is not part of this namespace.** `client.me()` already exists (`src/me.ts`, base surface)
and covers `GET /auth/me` exactly — do not look for it under `console.auth`.

None of these four call `unwrap()` — every response body is flat, no envelope key, exactly like
`console.reliability.list`.

## `console.dashboard.stats(params?)`

```ts
import { W6wClient } from "@w6w/sdk";
import "@w6w/sdk/console";

const client = new W6wClient();
const rollup = await client.console.dashboard.stats({ bucket: "week" });
```

`GET /dashboard/stats`, AUTHENTICATED (default `requireAuth` — the account is derived server-side
from the principal, `packages/server/packages/api/admin/dashboard.ts:44-96`, and the client never
sends one). `from`, `to` and `bucket` are forwarded as query parameters when given, and dropped from
the query string entirely when omitted (the server applies its own window and bucket defaults).
Relocated verbatim from `packages/studio/src/api/client.ts:189-197`, which the field-for-field
`DashboardStats` shape is still pinned by.

**No envelope key**, like `console.reliability.list`: the server's `GET /dashboard/stats` answers
`c.json({range, headline, series, recent})` (`admin/dashboard.ts:90-95`), so the `DashboardStats`-
shaped object IS the top-level response body. `stats` returns `res.body` directly and never calls
`unwrap()`.

Return shape — `DashboardStats`:

| Field      | Type                                                                                                        | Notes                                                                 |
| ---------- | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `range`    | `{ from: string; to: string; bucket: "day" \| "week" }`                                                     | The resolved window actually applied.                                 |
| `headline` | `{ workflowRuns: number; succeeded: number; failed: number }`                                               | Workflow runs only.                                                   |
| `series`   | `Array<{ bucket: string; kind: string; ok: boolean \| null; count: number }>`                               | The charts-later seam — a flat payload the caller slices client-side. |
| `recent`   | `Array<{ id, kind, ok: boolean \| null, summary: string \| null, occurredAt, workflowId: string \| null }>` | Most recent activity, `id`/`kind`/`occurredAt` always `string`.       |

## `RequestOptions.requireAuth`

`request()` (and therefore every namespace method built on it, in both the root export and
`@w6w/sdk/console`) now accepts an optional `requireAuth?: boolean` on `RequestOptions`, defaulting
to `true`:

```ts
await client.request({
  method: "POST",
  path: "/auth/login",
  body: { username, password },
  requireAuth: false,
});
```

Set `false` for the handful of routes that are public server-side and must never carry a bearer.
When `false`, `requireToken()` is never called and no `authorization` header is set — not even when
the client happens to hold a token; the effect is not "an empty header" but "the header is absent
entirely". Omitting the field behaves exactly as it always has. This is the mechanism
`console.auth.login`/`signup`/`checkAccountSlug` are built on (see above) — without it, a tokenless
client could never call `login`, since `requireToken` would raise before the request ever reached
`fetch`.

This field is **node-only** for now, for the same reason `RequestOptions.headers` is; the equivalent
gap in `cli`/`python` is filed separately in this project's `FOLLOWUPS.md` and is not part of this
change.

## `console.projects.*`

```ts
import { W6wClient } from "@w6w/sdk";
import "@w6w/sdk/console"; // pulls in client.console

const client = new W6wClient();
const projects = await client.console.projects.list();
const created = await client.console.projects.create("Acme");
await client.console.projects.delete(created.id);
```

| Method         | Route                  | Notes                                                                                                             |
| -------------- | ---------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `list()`       | `GET /projects`        | No query parameter — excludes archived. `unwrap<Project[]>(res, "projects")`.                                     |
| `create(name)` | `POST /projects`       | Body `{ name }`. `unwrap<Project>(res, "project")` (server answers `201`).                                        |
| `delete(id)`   | `DELETE /projects/:id` | Returns nothing; `404 unknown_project` covers both "no such id" and "is the default project" — not discriminated. |

Relocated verbatim from `packages/studio/src/api/client.ts:447-454`, which the field-for-field
`Project` shape (`id`, `account`, `name`, `isDefault: boolean`, `status: "active" | "archived"`,
`createdAt`, `updatedAt`) is still pinned by (`packages/studio/src/api/types.ts:308-317`).

**`PATCH /projects/:id` (rename), `POST /projects/:id/archive`, `POST /projects/:id/unarchive` and
`GET /schedules` (list-schedules) are deliberately NOT covered here** — studio's own `api/client.ts`
never wrapped any of the four (zero client-side coverage, not just zero callers), confirmed by
`GeneralPage.tsx`'s own header comment ("no rename/archive/unarchive/view-archived here"). See this
project's `plan.md` FINDINGS DISPOSITION for the full reasoning behind the scope line.

## `console.schedules.*`

```ts
import { W6wClient } from "@w6w/sdk";
import "@w6w/sdk/console"; // pulls in client.console

const client = new W6wClient();
const schedule = await client.console.schedules.get("wf_1");
if (schedule === null) {
  await client.console.schedules.upsert("wf_1", { cron: "0 * * * *" });
}
await client.console.schedules.delete("wf_1");
```

| Method                     | Route                            | Notes                                                                                                          |
| -------------------------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `get(workflowId)`          | `GET /workflows/:id/schedule`    | `unwrap<Schedule>(res, "schedule")` on success. See the 404 note below.                                        |
| `upsert(workflowId, body)` | `POST /workflows/:id/schedule`   | Create-or-update, `200` either way (no distinct `201`). Body `{ cron, enabled?, variables? }` forwarded as-is. |
| `delete(workflowId)`       | `DELETE /workflows/:id/schedule` | Returns nothing; `404 unknown_workflow` when there is no such workflow — NOT caught, unlike `get`.             |

Relocated verbatim from `packages/studio/src/api/client.ts:535-554`, which the field-for-field
`Schedule` shape (`workflowId`, `cron`, `enabled: boolean`, `variables: Record<string, unknown>`,
`nextRunAt`, `lastRunAt: string | null`) is still pinned by
(`packages/studio/src/api/types.ts:368-375`).

**`get`'s 404→`null` asymmetry is intentional, not a bug to reconcile.** It is the one "get" method
in this entire package that does not throw on a 404: it catches `ApiError` with `status === 404`
(any error `code` — the server sends two different ones for "no schedule to show",
`unknown_workflow` and `no_schedule`, and this method does not discriminate between them) and
resolves `null` instead. Every other status (400, 500, …) still throws unchanged, and every other
"get" in this package (`documents.get`, `vars.get`, …) throws on every non-2xx including 404. This
is relocated verbatim from `client.ts:535-542`'s own behavior, not a new design decision made here.

**`GET /schedules` (list-schedules across a workflow's or account's schedules) is deliberately NOT
covered here** — the same "studio never wrapped it" reasoning as `console.projects.*` above; see
`plan.md`'s FINDINGS DISPOSITION.
