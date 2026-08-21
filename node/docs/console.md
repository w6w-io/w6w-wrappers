# `@w6w/sdk/console` — the console-only surface

The other documents in this directory describe the **published partner contract**: `sdk-surface.md`
catalogs every symbol on `@w6w/sdk`'s root export (`import { W6WClient } from "@w6w/sdk"`), and
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
`"./console"`) rather than a namespace hidden on `W6WClient` directly, so a host that only wants the
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
import { W6WClient } from "@w6w/sdk";
import "@w6w/sdk/console"; // pulls in client.console

const client = new W6WClient();
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
import { W6WClient } from "@w6w/sdk";
import "@w6w/sdk/console"; // pulls in client.console

const client = new W6WClient({ baseUrl: "https://api.example.com" }); // no token — see below
const { token, user } = await client.console.auth.login("alice@example.com", "hunter2");
```

Twelve methods. `login`, `signup`, `checkAccountSlug` and `createAccount` are relocated verbatim
from the studio's own API client (`packages/studio/src/api/client.ts:249-291`), with the same
field-for-field shapes it used (`packages/studio/src/api/types.ts:10-82`) — this module does not
redesign them, only gives them a second home. `getMe` was added first (see below); `getProfile`
through `setPassword` are T1.1.4's `/me/*` family, added by this task.

| Method                        | Route                                   | Public/authenticated                                                                               |
| ----------------------------- | --------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `login(identifier, password)` | `POST /auth/login`                      | **PUBLIC** — sends no bearer (`requireAuth: false`), even on a client already holding a token      |
| `signup(input)`               | `POST /auth/signup`                     | **PUBLIC** — sends no bearer (`requireAuth: false`)                                                |
| `checkAccountSlug(name)`      | `GET /auth/signup/slug-available?name=` | **PUBLIC** — sends no bearer (`requireAuth: false`)                                                |
| `createAccount(name, slug)`   | `POST /accounts`                        | **AUTHENTICATED** — default `requireAuth`, re-issues the session with the new account's claim      |
| `getMe()`                     | `GET /auth/me`                          | **AUTHENTICATED** — default `requireAuth`; returns `ConsoleMe`, not the published `Me` — see below |
| `getProfile()`                | `GET /me/profile`                       | **AUTHENTICATED** — the real `users` row, incl. `hasPassword` — see below                          |
| `updateProfile(input)`        | `PATCH /me/profile`                     | **AUTHENTICATED** — `{displayName}`                                                                |
| `requestContactChange(input)` | `POST /me/contacts/change`              | **AUTHENTICATED** — `{method, value}`; parks a pending change, returns `void` (`202 {ok:true}`)    |
| `confirmContactChange(input)` | `POST /me/contacts/confirm`             | **AUTHENTICATED** — `{method, code, promote?}`; returns the updated profile                        |
| `removeContact(id)`           | `DELETE /me/contacts/:id`               | **AUTHENTICATED** — added per HITL-7; returns `void`                                               |
| `promoteContact(id)`          | `POST /me/contacts/:id/primary`         | **AUTHENTICATED** — added per HITL-7; returns the updated profile                                  |
| `setPassword(input)`          | `POST /me/password`                     | **AUTHENTICATED** — `{newPassword, currentPassword?}` — one method for both "set" and "change"     |

The three public routes are registered server-side ABOVE `app.use("*", authGuard)`
(`packages/server/packages/api/data/signup.ts:23-41`, `id/auth.ts:22-55`) and must never read a
principal — `requireAuth: false` is the ONLY way `login` can work at all, since a client with no
token configured (the normal case pre-login) would otherwise hit `requireToken`'s `ConfigError` on
every request, and `login` is how a caller gets a token in the first place. `createAccount`'s
returned token is minted `role: "user"` unconditionally, so adopting it downgrades an operator —
this namespace never writes the session itself, the caller decides.

**`getMe` IS part of this namespace, and returns `ConsoleMe`, not the published `Me`.**
`GET /auth/me` answers additively with a studio-internal capability field, `tenantAdmin: boolean` —
**required**, not optional, on `ConsoleMe`: an older server that omits the key resolves `undefined`
at runtime, which is falsy, so every `if (me.tenantAdmin)` fails CLOSED rather than granting by
accident. `Me` (`src/types.ts`) is **published contract** — `endpoints.json` names it as the `me`
operation's `returns` — so adding `tenantAdmin` there would trigger the publish-in-lockstep release
across node, cli and python for what is a studio-only authorization hint; `ConsoleMe` is the
studio-internal superset instead. `client.me()` (`src/me.ts`, base surface) still exists and still
covers `GET /auth/me` exactly for the published shape — both read the same route and differ only in
what they promise about the body. Use `client.me()` for the published `Me`; use
`client.console.auth.getMe()` when the caller needs `tenantAdmin`.

**T1.1.4's `/me/*` family (`getProfile` through `setPassword`) is registered BELOW the auth guard**
(`packages/server/packages/api/data/me.ts`'s own doc comment) — every one of the seven is
AUTHENTICATED, the default `requireAuth`, unlike the three public methods above. `removeContact` and
`promoteContact` are not part of this task's originally-pinned five; both were added because HITL-7
rules them in and the corresponding routes exist on the merged branch (`data/me.ts:135-154`) — "if
T1.1.4 ships routes for adding / removing / promoting a secondary contact, they get methods here
too".

**`UserProfile.hasPassword` is a rename of the wire's `passwordSet`.** `GET /me/profile` (and every
other method here that returns a profile) answers `passwordSet` (`data/me.ts:9`,
`packages/bll/signup.ts:555`), derived server-side from `password_hash !== null` — the hash itself
never appears on the wire. `hasPassword` is what HITL-10's "Set a password" (`false`) vs "Change
password" (`true`) fork reads; the rename happens in `toUserProfile()` (`src/console/auth.ts`) from
the exact value the wire sent — never a default, never computed from anything else.

`requestContactChange` and `setPassword` both resolve `void`, discarding the server's uninformative
`{ok: true}`/`202 {ok: true}`, mirroring `console.projects.delete`/`console.schedules.delete`'s own
convention elsewhere in this package. `removeContact` does the same with its `{ok: true}`.

None of these twelve call `unwrap()` — every response body is flat, no envelope key, exactly like
`console.reliability.list`.

## `console.dashboard.stats(params?)`

```ts
import { W6WClient } from "@w6w/sdk";
import "@w6w/sdk/console";

const client = new W6WClient();
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
  body: { email, password },
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
import { W6WClient } from "@w6w/sdk";
import "@w6w/sdk/console"; // pulls in client.console

const client = new W6WClient();
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
import { W6WClient } from "@w6w/sdk";
import "@w6w/sdk/console"; // pulls in client.console

const client = new W6WClient();
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

## `console.apps.*`

```ts
import { W6WClient } from "@w6w/sdk";
import "@w6w/sdk/console"; // pulls in client.console

const client = new W6WClient();
const apps = await client.console.apps.list();
const detail = await client.console.apps.get(apps[0].id);
const result = await client.console.apps.invoke(detail.app.id as string, "send", { to: "a@b.com" });
```

The largest console domain — 16 methods, relocated from `packages/studio/src/api/client.ts:235-393`.
Method names are SHORTENED versus `client.ts`'s flat names (`listApps` → `list`, `getAppAuth` →
`getAuth`, …), matching `console.projects`'s/`console.schedules`'s own short-verb convention; every
wire call (method/path/body/query) is unchanged from `client.ts`.

| Method                                    | Route                                                | Notes                                                                                                                                                                                                                                         |
| ----------------------------------------- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list()`                                  | `GET /apps` (paginated)                              | Custom loop, no `unwrap()` — accumulates `apps` across pages, forwarding `nextCursor` as the next page's `cursor`; capped at 20 pages.                                                                                                        |
| `get(id)`                                 | `GET /apps/:id`                                      | Whole body IS `AppDetail` — no envelope.                                                                                                                                                                                                      |
| `getAuth(id)`                             | `GET /apps/:id/auths`                                | `unwrap<AuthDef[]>(res, "auths")`.                                                                                                                                                                                                            |
| `getActions(id)`                          | `GET /apps/:id` (own call)                           | Reads `(body as AppDetail).actions ?? []` — a separate call from `get`, not a refactor onto it.                                                                                                                                               |
| `getTriggers(id)`                         | `GET /apps/:id/triggers`                             | `unwrap<TriggerDef[]>(res, "triggers")`.                                                                                                                                                                                                      |
| `getHealth(id)`                           | `GET /apps/:id` (own call)                           | Reads `(body as AppDetail).health ?? []`. **Dead code (HITL-4).**                                                                                                                                                                             |
| `getHealthStatus(id)`                     | `GET /apps/:id/health`                               | Whole body IS `AppHealthStatus` — no envelope.                                                                                                                                                                                                |
| `listOAuthConfig(appId)`                  | `GET /apps/:id/oauth-config`                         | `unwrap<OAuthConfigSummary[]>(res, "configs")`. **Dead code (HITL-4).**                                                                                                                                                                       |
| `upsertOAuthConfig(appId, authKey, body)` | `PUT /apps/:id/oauth-config/:authKey`                | `unwrap<OAuthConfigSummary>(res, "config")` (server answers `201`). Body forwarded verbatim. **Dead code (HITL-4).**                                                                                                                          |
| `deleteOAuthConfig(appId, authKey)`       | `DELETE /apps/:id/oauth-config/:authKey`             | Returns nothing; discards `{ok:true}`. **Dead code (HITL-4).**                                                                                                                                                                                |
| `startOAuthFlow(appId, authKey, body?)`   | `POST /apps/:id/oauth-config/:authKey/authorize-url` | Whole body IS `{authorizationUrl, state, expiresIn}` — no envelope. No studio-page caller, but called via `@w6w/ui`'s `W6WApi.startAppOAuthFlow` facade.                                                                                      |
| `preview(source, opts?)`                  | `POST /apps/preview`                                 | Whole body IS the `kind`-discriminated union — no envelope.                                                                                                                                                                                   |
| `import(source, opts?)`                   | `POST /apps/import`                                  | Whole body IS the `kind`-discriminated union — no envelope.                                                                                                                                                                                   |
| `refresh(id, opts?)`                      | `POST /apps/:id/refresh`                             | Whole body IS `RefreshAppResponse` — no envelope.                                                                                                                                                                                             |
| `invoke(appId, actionKey, params, opts?)` | `POST /apps/:id/actions/:key/invoke`                 | Whole body IS `{value, logs?, apiCalls?}` — no envelope. No studio-page caller, but called heavily via `@w6w/ui`'s `W6WApi.invokeAction` facade (that facade's `opts` also carries `project`/`state`, a superset this method does not model). |
| `delete(appId)`                           | `DELETE /apps/:id`                                   | Whole body IS `{removed: number}` — **returned, not discarded to `void`**, the one deliberate asymmetry vs. `console.projects.delete`/`console.schedules.delete`.                                                                             |

Relocated verbatim from `packages/studio/src/api/client.ts:235-393`, which the field-for-field
`AppSummary`, `ActionDef`, `AuthDef`, `TriggerDef`, `HealthCheckMeta`, `AppHealthStatus`,
`AppDetail`, `PreviewSourceResponse`, `ImportResponse`, `RefreshAppResponse` and
`OAuthConfigSummary` shapes are still pinned by `packages/studio/src/api/types.ts`.

**`AppSummary` carries two additive fields beyond that pin**, both optional:
`supportsOAuth?: boolean` (true when the app declares an `oauth2` auth method, server-computed from
`app.latest.auth` by `summarize`, `packages/server/packages/api/wire-summary.ts:81` — no client ever
re-derives it) and `owner?: { tenant: string; subject: string }` (ownership sentinels: neither set
means global, `tenant` set with an empty `subject` means tenant-owned, both set means user-owned;
projected server-side by `wireOwner`, `wire-summary.ts:70-72`). `owner` is optional on this type
even though the server always sends it, so the type is also satisfied by a caller-written literal
and by an older host.

**`listApiCalls` is deliberately NOT covered here** — it lives under the same `client.ts` comment
block but has no named apps-domain consumer (its only caller is reliability's drill-down page); it
groups with a future `reliability`+`api-calls` sub-project instead.
**`DELETE
/apps/:id/versions/:version` (delete a version) and `PATCH /apps/:id/lifecycle` are also
deliberately NOT covered** — both are live, `requireOperator`-gated routes with zero client-side
coverage ever (not just zero callers). See `plan.md`'s FINDINGS DISPOSITION for the full reasoning
behind all three exclusions.

## `console.connections.*`

```ts
import { W6WClient } from "@w6w/sdk";
import "@w6w/sdk/console"; // pulls in client.console

const client = new W6WClient();
const conns = await client.console.connections.listForApp("sendgrid");
const created = await client.console.connections.create("sendgrid", {
  authKey: "apiKey",
  credential: { key: "sk_live_…" },
});
const result = await client.console.connections.test(created.id);
if (!result.ok) console.log(result.error?.message);
await client.console.connections.delete(created.id);
```

Six methods, relocated from `packages/studio/src/api/client.ts:252-298`'s single `// Connections`
comment block — field-for-field, not redesigned. `listConnections` (the seventh call site there) is
deliberately NOT relocated here: it already has a home on the pre-existing BASE namespace,
`client.connections.list()` (`src/connections.ts:47-64`), and this domain does not duplicate it.

| Method                | Route                        | Notes                                                                                                                                 |
| --------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `listForApp(appId)`   | `GET /apps/:id/connections`  | `unwrap<ConnectionSummary[]>(res, "connections")`.                                                                                    |
| `get(id)`             | `GET /connections/:id`       | `unwrap<ConnectionSummary>(res, "connection")`. No 404 special-casing — propagates as `ApiError`, unlike `console.schedules.get`.     |
| `create(appId, body)` | `POST /apps/:id/connections` | Body `{authKey, credential, displayName?, profile?}` forwarded verbatim. `unwrap<ConnectionSummary>(res, "connection")` (`201`).      |
| `update(id, body)`    | `PATCH /connections/:id`     | Body `{displayName?, credential?}` forwarded verbatim, not pre-validated client-side. `unwrap<ConnectionSummary>(res, "connection")`. |
| `test(id)`            | `POST /connections/:id/test` | **No envelope key — see below.**                                                                                                      |
| `delete(id)`          | `DELETE /connections/:id`    | Returns nothing; discards `{ok: true}`, same convention as `console.projects.delete`/`console.schedules.delete`.                      |

**`test`'s response has no envelope key — the whole body IS the `ConnectionTestResult`**, mirroring
`console.reliability.list`'s pattern (`packages/server/packages/api/admin/connections.ts:151-190`
answers the body directly). Three possible `200`-status shapes:

- `{ok: true, untested: true, message}` — no safe probe action exists for this connection's app.
- `{ok: true, actionKey}` — the probe action ran and passed.
- `{ok: false, actionKey, error: {message}}` — the probe action ran and **failed**. This is still a
  `200` and `test` resolves normally — **a failed test is data, never a raised error**, the exact
  same rule `client.run()`/`workflows.run()` already document for a failed run. Only a genuine
  non-2xx (`404 unknown_connection`) raises `ApiError`.

`create`'s and `update`'s `credential` field is opaque (`Record<string, unknown>`) and forwarded
verbatim — never inspected, logged, or transformed by this method. That is a security-adjacent
discipline, not a style note: the whole point of the field is a caller-opaque secret payload.

None of these methods take a `project` scoping parameter — connections carry no `?project=`, the
server scopes by tenant/account from the credential alone — so `ConnectionsHost` needs only the
transport, mirroring `console.projects`'s/`console.schedules`'s own host shape.

**Console placement here is a resolved decision, not a default applied without thought — see
`HITL-10` in `HITL.md` and `plan.md`'s SP2.3 section for the full investigation.**
`endpoints.json`'s `outOfScope` entry for connections writes frames the eventual intent as a real
partner operation, unlike `projects`/`schedules`/`apps` — but the server routes this domain wraps
are plain, stateless handlers over an already-resolved payload for both real studio call sites,
which makes console placement technically safe for studio's own use without by itself justifying
promotion to the partner surface (cli/python lockstep; no partner-facing OAuth-flow counterpart
exists yet either). Console placement is the pinned default for this round; partner-surface
promotion is deferred to a dedicated future project. A future reader evaluating that promotion
should start from `HITL-10`/SP2.3 rather than re-deriving the reasoning from scratch.

## `console.workflows.*`

```ts
import { W6WClient } from "@w6w/sdk";
import "@w6w/sdk/console"; // pulls in client.console

const client = new W6WClient();
const { workflow, updatedAt } = await client.console.workflows.get("wf_1");
const saved = await client.console.workflows.upsert(workflow, { ifUnmodifiedSince: updatedAt });
const runs = await client.console.workflows.listRuns("wf_1");
const run = await client.console.workflows.getRun(runs[0].runId);
await client.console.workflows.archive("wf_1");
await client.console.workflows.delete("wf_1");
```

Six methods, relocated from `packages/studio/src/api/client.ts:254-331`'s `// Workflows` comment
block — field-for-field, not redesigned, except `getRun`, which is genuinely new here (see below).

| Method                      | Route                         | Notes                                                                                                                                                        |
| --------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `get(id)`                   | `GET /workflows/:id`          | Whole body IS `{workflow, sourceRef, updatedAt}` — no envelope. No 404 special-casing — propagates as `ApiError`, unlike `console.schedules.get`.            |
| `upsert(definition, opts?)` | `POST /workflows`             | Body is the definition **verbatim** (not wrapped). Optional `?project=`. Optional `ifUnmodifiedSince` → `x-w6w-if-unmodified-since` header. See below.       |
| `archive(id)`               | `POST /workflows/:id/archive` | Whole body IS `{workflow}` — no envelope. `200`, idempotent (already-archived re-returns unchanged). One-way — no unarchive route exists.                    |
| `delete(id)`                | `DELETE /workflows/:id`       | Returns nothing; discards `{ok:true}`. Does **not** catch `409 workflow_not_archived` — see below. Cascade-deletes runs/schedules/subscriptions server-side. |
| `listRuns(id)`              | `GET /workflows/:id/runs`     | `unwrap<RunSummary[]>(res, "runs")`. `404 unknown_workflow` is an ownership gate.                                                                            |
| `getRun(runId)`             | `GET /runs/:id`               | `unwrap<RunState>(res, "run")`. `404 unknown_run` covers both "no such run" and "not your workflow" — not discriminated.                                     |

**`list` and `run` are deliberately NOT covered here** — both already exist on the BASE namespace
(`client.workflows.list()`/`client.workflows.run()`, `src/workflows.ts`), and studio reuses them
verbatim. Adding a duplicate `list`/`run` under `console.workflows` would give a caller two ways to
reach the same route — the exact anti-duplication defect this project's own rules flag. **No poll
loop lives here either**, for the same reason `src/workflows.ts`'s own module doc gives for the base
surface: "no client-side polling… three wrappers each re-implementing a poll would be three timeout
policies and three retry-storm bugs to keep in sync." `getRun` is one request, one answer — the
caller (studio's `lib/workflow-poll.ts`) owns the loop.

**`upsert`'s precondition header is `RequestOptions.headers`'s first real consumer.** `upsert` takes
an explicit `ifUnmodifiedSince?: string | null` option and translates it into
`x-w6w-if-unmodified-since` itself — it does not expose a raw `headers` parameter to the caller. The
header is sent **only when supplied**, mirroring the server's own conditional exactly
(`admin/workflows.ts`): never as an empty or `"undefined"`/`"null"` string. Passing it and having
the stored `updatedAt` no longer match answers **`409 workflow_stale`** — recoverable by reloading
(via `get`) and re-saving. A **different** `409`, **`workflow_conflict`**, means another
`(tenant,subject)` owns this id — NOT recoverable by reloading. Both share the HTTP status; only the
`error.code` distinguishes them, and this method does not collapse them into one thing — the caller
must inspect `code`.

**`delete` does not enforce archive-then-delete — it surfaces the server's refusal.** The server
requires a workflow be `"archived"` before it can be deleted; deleting one that is not answers
`409
workflow_not_archived`, and this method does NOT catch it — it propagates as `ApiError`, a real
signal the caller must handle. Enforcing the archive-then-delete sequence is not this method's job.

Return shapes — `RunState` (from `getRun`) and `RunSummary` (from `listRuns`) are defined LOCALLY in
`src/console/workflows.ts`, not the shared `src/types.ts`, mirroring where `Schedule`/`Project`
live. Field-for-field, relocated from `packages/studio/src/api/types.ts:84-102`, with one deliberate
deviation: `RunState.error` and `RunState.steps` stay **opaque** (`unknown` /
`Record<string, unknown>`), matching this package's own documented philosophy for `RunResult`
(`src/types.ts` — "a client that modelled their internals would be wrong for someone"), rather than
studio's richer local typing (`{code,message,…}` / `Record<string, StepExecution>`).

None of these six methods take a client-side default-project fallback — they are addressed by
`wf_…`/`run_…` id (plus `upsert`'s optional explicit `?project=`) — so `WorkflowsHost` needs only
the transport, mirroring `console.projects`'s/`console.schedules`'s own host shape, not the BASE
`WorkflowsHost` (`src/workflows.ts`), which additionally reads `config.project` as `list()`'s
default.

**Console placement here is the same precedent as `console.connections`'s `HITL-10`, not a fresh
judgment call.** `endpoints.json`'s `outOfScope` array names "all write operations on connections
and workflows" together, with the identical "in this version" framing HITL-10 already investigated
for connections. The server routes here (`admin/workflows.ts`) are, like connections, plain
stateless handlers over an already-resolved request body/precondition header — no interactive flow
the SDK method itself would need to conduct. HITL-10's resolution transfers directly: console
placement is safe for studio's own use; it does not by itself justify promotion to the partner
surface (still needs cli/python parity + a documented partner story, neither of which exists today).

## `console.savedTests.*`

```ts
import { W6WClient } from "@w6w/sdk";
import "@w6w/sdk/console"; // pulls in client.console

const client = new W6WClient();
const tests = await client.console.savedTests.list("conn_1");
const created = await client.console.savedTests.create("conn_1", {
  actionKey: "send",
  name: "Happy path",
  values: { to: "a@b.com" },
});
const run = await client.console.savedTests.recordTestRun("conn_1", {
  savedTestId: created.id,
  actionKey: "send",
  ok: true,
});
console.log(run.id); // the real created SavedTestRun row
await client.console.savedTests.delete("conn_1", created.id);
```

Six methods, relocated from `packages/studio/src/api/client.ts:259-315`'s single `// Saved tests`
comment block — field-for-field, not redesigned.

| Method                              | Route                                     | Notes                                                                                                              |
| ----------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `list(connectionId)`                | `GET /connections/:id/saved-tests`        | `unwrap<SavedTest[]>(res, "savedTests")`.                                                                          |
| `create(connectionId, body)`        | `POST /connections/:id/saved-tests`       | Body `{actionKey, name, values}` forwarded verbatim. `unwrap<SavedTest>(res, "savedTest")` (`201`).                |
| `update(connectionId, id, patch)`   | `PATCH /connections/:id/saved-tests/:id`  | Body `{name?, values?}` forwarded verbatim. `unwrap<SavedTest>(res, "savedTest")`.                                 |
| `delete(connectionId, id)`          | `DELETE /connections/:id/saved-tests/:id` | Returns nothing; discards `{ok: true}`, same convention as `console.projects.delete`/`console.schedules.delete`.   |
| `recordTestRun(connectionId, body)` | `POST /connections/:id/test-runs`         | Body `{savedTestId?, actionKey, ok, summary?, result?}` forwarded verbatim. **Returns the REAL row — see below.**  |
| `listTestRuns(connectionId)`        | `GET /connections/:id/test-runs`          | `unwrap<TestRunSummary[]>(res, "runs")` — a thin, most-recent-first projection, NOT the full `SavedTestRun` shape. |

**`recordTestRun` returns the real created `SavedTestRun` row, unwrapped from `{run}` — it does NOT
discard to `void`.** Studio's own `client.ts` currently discards this call's result
(`.then(() => {})`) only so its `api` object stays assignable to `@w6w/ui`'s `W6WApi.recordTestRun`,
which that facade types `Promise<void>` — that is studio's constraint, not this package's. A caller
wanting the studio-facade `void` shape adapts it themselves (this is what studio's own
`src/repos/saved-tests.ts` does, at the repo layer, not here).

None of these six methods take a `project` scoping parameter — saved tests carry no `?project=`, the
server scopes by connection/tenant — so `SavedTestsHost` needs only the transport, mirroring
`console.connections`'s own host shape.

## `console.stepTests.*`

```ts
import { W6WClient } from "@w6w/sdk";
import "@w6w/sdk/console"; // pulls in client.console

const client = new W6WClient();
const fixture = await client.console.stepTests.save("wf_1", "nd_1", {
  input: { foo: "bar" },
  with: { to: "a@b.com" },
});
const fixtures = await client.console.stepTests.list("wf_1", "nd_1");
const run = await client.console.stepTests.recordRun("wf_1", "nd_1", {
  stepTestId: fixture.id,
  status: "succeeded",
  output: { ok: true },
});
console.log(run.id); // the real created StepTestRun row
```

Three methods, relocated from `packages/studio/src/api/client.ts:317-351`'s single
`// Saved per-step tests` comment block — field-for-field, not redesigned. Method names here are
SHORTENED versus `client.ts`'s flat names (`saveStepTest` → `save`, `listStepTests` → `list`,
`recordStepTestRun` → `recordRun`), mirroring `console.connections.listForApp`'s/
`console.workflows.get`'s own convention — the domain prefix already disambiguates.

| Method                                | Route                                         | Notes                                                                                                           |
| ------------------------------------- | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `save(workflowId, stepId, body)`      | `POST /workflows/:id/steps/:stepId/tests`     | Body `{name?, input, with}` forwarded verbatim. `unwrap<StepTest>(res, "stepTest")` (`201`).                    |
| `list(workflowId, stepId)`            | `GET /workflows/:id/steps/:stepId/tests`      | `unwrap<StepTest[]>(res, "stepTests")`.                                                                         |
| `recordRun(workflowId, stepId, body)` | `POST /workflows/:id/steps/:stepId/test-runs` | Body `{stepTestId?, status, input?, output?, error?}` forwarded verbatim. **Returns the REAL row — see below.** |

**`recordRun` returns the real created `StepTestRun` row, unwrapped from `{run}` — it does NOT
discard to `void`.** Same rule as `console.savedTests.recordTestRun` above: studio's own `client.ts`
discards this call's result only so its `api` object stays assignable to `@w6w/ui`'s
`W6WApi.recordStepTestRun` (`Promise<void>`) — studio's constraint, not this package's. A caller
wanting the studio-facade `void` shape adapts it themselves.

**`PATCH`/`DELETE /workflows/:workflowId/steps/:stepId/tests/:id` also exist server-side but are
deliberately NOT wrapped here** — zero client-side coverage anywhere (studio or `@w6w/ui`), the same
disposition prior console domains already established for their own orphan routes (HITL-4's
philosophy applied one step further).

None of these three methods take a `project` scoping parameter — step tests carry no `?project=`,
the server scopes by workflow/tenant — so `StepTestsHost` needs only the transport, mirroring
`console.connections`'s own host shape.

## `console.vault.*`

```ts
import { W6WClient } from "@w6w/sdk";
import "@w6w/sdk/console"; // pulls in client.console

const client = new W6WClient();
const secrets = await client.console.vault.list();
const created = await client.console.vault.create({ name: "openai_key", value: "sk-…" });
await client.console.vault.update(created.id, { description: "Prod key" });
const sealed = await client.console.vault.seal("sk-live-…");
await client.console.vault.delete(created.id);
```

Six methods, relocated from `packages/studio/src/api/client.ts`'s single `// Vault` comment block —
field-for-field, not redesigned.

| Method             | Route               | Notes                                                                                                                                                                                           |
| ------------------ | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list()`           | `GET /vault`        | `unwrap<VaultSecretSummary[]>(res, "secrets")`.                                                                                                                                                 |
| `get(id)`          | `GET /vault/:id`    | `unwrap<VaultSecretSummary>(res, "secret")`. **Zero studio callers today** — built for SDK completeness only. No 404 special-casing — propagates as `ApiError`, unlike `console.schedules.get`. |
| `create(body)`     | `POST /vault`       | Body `{name, value, description?}` forwarded verbatim. `unwrap<VaultSecretSummary>(res, "secret")` (`201`).                                                                                     |
| `update(id, body)` | `PATCH /vault/:id`  | Body `{value?, description?}` forwarded verbatim. `unwrap<VaultSecretSummary>(res, "secret")`.                                                                                                  |
| `delete(id)`       | `DELETE /vault/:id` | Returns nothing; discards `{ok: true}`, same convention as `console.projects.delete`/`console.schedules.delete`/`console.connections.delete`.                                                   |
| `seal(value)`      | `POST /vault/seal`  | Body `{value}`. `unwrap<SecretValue>(res, "sealed")`. **Encrypt-only oracle — see below.**                                                                                                      |

**Write-only, no-plaintext-in-GET-responses is the invariant this whole domain rests on.** The
server's own module header states it directly: "plaintext values NEVER appear in a response"
(`packages/server/packages/api/admin/vault.ts`). `VaultSecretSummary` — the return type of `list`,
`get`, `create` and `update` alike — has **no `value` field at all**, so a secret's plaintext is
structurally unreachable through any of those four methods, not merely omitted by convention.
`create`/`update` still forward `value` in the _request_ body (that is how a secret's plaintext is
written), it is simply never echoed back.

`seal` is the one deliberate exception, and even it never returns plaintext: it answers with a
ciphertext envelope (`SecretValue = {type: "secret", ciphertext, iv}`), encrypting an ad-hoc value
into an at-rest envelope **without persisting it**, so a caller (the workflow editor) can seal a
secret-typed field the moment it's typed and never hold clear text in a config JSON. It is an
**encrypt-only oracle — there is no matching decrypt route** — the server's own header comment says
so explicitly: "an authed caller learns nothing they didn't provide." `seal`'s response IS enveloped
under `sealed`, unlike `console.connections.test`'s/`console.reliability.list`'s whole-body
responses.

`value` (on `create`/`update`/`seal`) is opaque — forwarded verbatim, never inspected, logged, or
transformed by this method. That is a security-adjacent discipline, not a style note: the whole
point of this field is a caller-opaque secret payload.

`SecretValue` is defined **locally** in `src/console/vault.ts`, field-for-field identical to
`packages/ui/src/types.ts`'s `SecretValue` shape — not imported from `@w6w/ui`, which this SDK has
no dependency on and must not gain one. TypeScript's structural typing makes this value satisfy
`@w6w/ui`'s `ExpressionOptions.sealSecret` prop shape at a studio call site with no shared import
needed, the same pattern this package's `SavedTest`/`StepTest` types already established.

None of these six methods take a `project` scoping parameter — vault secrets are subject-scoped like
`vars`, not project-scoped — so `VaultHost` needs only the transport, mirroring
`console.connections`'s own host shape.

## `console.tokens.*`

```ts
import { W6WClient } from "@w6w/sdk";
import "@w6w/sdk/console"; // pulls in client.console

const client = new W6WClient();
const tokens = await client.console.tokens.list();
const { token, secret } = await client.console.tokens.create("ci-deploy");
console.log(secret); // shown exactly once — capture it now or it is gone
await client.console.tokens.disable(token.id);
await client.console.tokens.enable(token.id);
await client.console.tokens.revoke(token.id);
```

Five methods, relocated from `packages/studio/src/api/client.ts`'s single `// API tokens` comment
block — field-for-field, not redesigned. Studio never sends `account` or `includeRevoked` on
`list()` (the server's list default already excludes revoked) — per HITL-4's own philosophy ("SDK
completeness tracks studio's actual call surface, not the server's full route surface"), neither
parameter is added here.

| Method         | Route                      | Notes                                                                                                                 |
| -------------- | -------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `list()`       | `GET /tokens`              | `unwrap<ApiToken[]>(res, "tokens")`.                                                                                  |
| `create(name)` | `POST /tokens`             | Body `{name}`. **No envelope key — see below.**                                                                       |
| `disable(id)`  | `POST /tokens/:id/disable` | Body `{}` (sent verbatim, matching studio's own shape). `unwrap<ApiToken>(res, "token")`.                             |
| `enable(id)`   | `POST /tokens/:id/enable`  | Body `{}`. `unwrap<ApiToken>(res, "token")`. `409 invalid_transition` when the token is revoked (revoke is terminal). |
| `revoke(id)`   | `POST /tokens/:id/revoke`  | Body `{}`. `unwrap<ApiToken>(res, "token")`.                                                                          |

**`create`'s plaintext-once return is the invariant this whole domain rests on.** `POST /tokens` is
the ONLY response in this entire package that returns a token's plaintext — there is no reveal-later
route. Its result type, `CreateTokenResponse = {token: ApiToken, secret: string}`, is defined as a
**separate** type from `ApiToken`, never as an optional `secret?` field bolted onto it: `ApiToken` —
the return type of every other method here (`list`/`disable`/`enable`/`revoke`) — structurally
cannot carry a `secret`, which makes "nothing reachable through those four methods can ever carry a
secret" a compile-time fact, not a runtime convention. The server's own `toWire()` doc comment
states the identical invariant server-side: "never carries the secret, the hash, or internals."

`create` has **no envelope key to peel — the whole body IS `{token, secret}`**. It is typed directly
as `request<CreateTokenResponse>(...)`, returning `res.body`, mirroring
`console.connections.test`'s/ `console.reliability.list`'s established "no envelope key" pattern —
`unwrap()` is deliberately not called, since there is no single key to unwrap; the body has two
top-level keys.

None of these five methods take a `project` scoping parameter — tokens are account-scoped via the
credential alone — so `TokensHost` needs only the transport, mirroring `console.connections`'s own
host shape.

## `console.functions.*`

```ts
import { W6WClient } from "@w6w/sdk";
import "@w6w/sdk/console"; // pulls in client.console

const client = new W6WClient();
const fns = await client.console.functions.list();
const fn = await client.console.functions.get(fns[0].id);
await client.console.functions.upsert({ ...fn, description: "Send an email" });
```

Three methods, relocated from `packages/studio/src/api/client.ts:255-268`'s single `// Functions`
comment block — field-for-field, not redesigned: `listFunctions` → `list`, `getFunction` → `get`,
`saveFunction` → `upsert`.

| Method               | Route                | Notes                                                                                                                |
| -------------------- | -------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `list()`             | `GET /functions`     | `unwrap<FunctionSummary[]>(res, "functions")`. Each row already carries `valid` — server-computed, nothing to merge. |
| `get(id)`            | `GET /functions/:id` | **The pinned `valid`-splice merge — see below.**                                                                     |
| `upsert(definition)` | `POST /functions`    | Body is the whole `FunctionDef`, forwarded verbatim. `unwrap<{id,key}>(res, "function")` (`201`).                    |

**`get`'s `valid`-splice is a deliberate, behavior-preserving relocation, not a redesign.** On the
wire, `valid` is a TOP-LEVEL SIBLING of `function`, never part of the stored definition itself
(`admin/functions.ts:82-93` answers `{function, valid}`). This method DOES merge it into its return
value — `{...body.function, valid: body.valid}` — matching studio's own current `getFunction`
(`client.ts:259-262`) exactly, so `FunctionsPage.tsx:173`'s `setDraft(fn)` needs zero adaptation. A
raw `{function, valid}` return would be a regression, not a cleanup.

**`invoke` is deliberately NOT modeled here.** The base `client.run({urn, payload})`
(already-published surface, `endpoints.json`-named, exported from the root `mod.ts`) dispatches a
`fn_…` URN through the exact same `InvokeFunctionService` the dedicated `/functions/:id/invoke`
route uses, returning `{kind:"function", output}` — field-for-field identical to what the dedicated
route returns. Adding a duplicate `console.functions.invoke` would give a caller two ways to reach
the same route, mirroring `console.workflows`'s established precedent of NOT re-wrapping base
`list`/`run`. Studio composes `client.run()` + `isFunctionRun` itself; no invoke method lives here.

None of these three methods take a `project` scoping parameter — neither is reachable via either
HTTP route — so `FunctionsHost` needs only the transport, mirroring `console.workflows`'s/
`console.schedules`'s own host shape.

## `console.endpoints.*`

```ts
import { W6WClient } from "@w6w/sdk";
import "@w6w/sdk/console"; // pulls in client.console

const client = new W6WClient();
const endpoints = await client.console.endpoints.list();
const { endpoint, invokeUrl } = await client.console.endpoints.get(endpoints[0].id);
const result = await client.console.endpoints.invoke(endpoint.id, { to: "a@b.com" });
```

Four methods, relocated from `packages/studio/src/api/client.ts:281-314`'s single `// Endpoints`
comment block — field-for-field, not redesigned: `listEndpoints` → `list`, `getEndpoint` → `get`,
`saveEndpoint` → `upsert`, `invokeEndpoint` → `invoke`.

| Method               | Route                        | Notes                                                                                               |
| -------------------- | ---------------------------- | --------------------------------------------------------------------------------------------------- |
| `list()`             | `GET /endpoints`             | `unwrap<EndpointSummary[]>(res, "endpoints")`. Each row already carries its own `invokeUrl`.        |
| `get(id)`            | `GET /endpoints/:id`         | **Returns the raw three-key body VERBATIM — see below.**                                            |
| `upsert(definition)` | `POST /endpoints`            | Body is the whole `EndpointDef`, forwarded verbatim. **Returns the same three-key shape VERBATIM.** |
| `invoke(id, input)`  | `POST /endpoints/:id/invoke` | **The pinned invoke-path mechanism — see below.**                                                   |

**`get`/`upsert` return `{endpoint, invokeUrl, invokeUrlByKey?}` VERBATIM — never merged, never
`unwrap()`ed.** `invokeUrl`/`invokeUrlByKey` are never spliced into `endpoint`; this mirrors
`console.workflows.get`'s "no envelope key to peel, multiple top-level siblings" precedent,
deliberately NOT `console.functions.get`'s merge above — these are two different,
individually-verified, individually-pinned shapes; they are not made uniform. `invokeUrl` is ALWAYS
present; `invokeUrlByKey` is present only when the owning account has a slug — genuinely absent from
the body otherwise, never an `undefined`-valued key.

**`key` is immutable after first save — it is a public URL segment.** A save that changes `key` on
an already-stored Endpoint answers `409 key_immutable`; a first save with a malformed `key` answers
`400 invalid_endpoint`. None of `upsert`'s four possible error codes (`400 invalid_endpoint`,
`409 key_immutable`, `409 endpoint_conflict`, `409 endpoint_key_conflict`) need special client-side
handling — they propagate as an ordinary `ApiError` with the server's own `.message`, exactly like
every other write in this package; `upsert` does not branch on any of them.

**`invoke`'s wire path is a PINNED mechanism, not a choice.** `invoke` MUST call the DEDICATED
`POST /endpoints/:id/invoke` route directly — it must NEVER be implemented by delegating to
`client.run()`/`runUrn()`/`POST /run`, even though that dispatcher can also resolve an `ep_…` URN.
Verified directly against the server: `packages/server/packages/bll/resolve-run.ts`'s `ep_` arm
(`:198-207`) delegates to `InvokeEndpointService.invoke()` but then **remaps** the action-kind
result's field from `output` to `value` (`return { kind: "action", value: result.output };`) to
match `run()`'s own `ActionRunEnvelope` shape. The dedicated `/endpoints/:id/invoke` route
(`admin/endpoints.ts:319-360`) does NOT do this remap — it returns `InvokeEndpointResult` VERBATIM
(`{kind:"action", output}` for an action target). Studio's `EndpointsPage.tsx` renders the raw
envelope it gets back directly (`JSON.stringify(result, null, 2)`), so this field name is
user-visible. Routing `invoke` through `/run` instead of the dedicated route would silently rename
`output` to `value` and break that page. `invoke`'s response body is returned VERBATIM, field names
untouched: an `action`/`function` target answers `200` with `{kind, output}`; a `workflow` target
answers `202` with `{kind:"workflow", runId}` — both are success on this API, mirroring
`console.workflows`'s/base `run()`'s own "202 is success" convention.

None of these four methods take a `project` scoping parameter — neither is reachable via any HTTP
route on this domain — so `EndpointsHost` needs only the transport, mirroring
`console.workflows`'s/`console.schedules`'s own host shape.

## `console.aliases.*`

```ts
import { W6WClient } from "@w6w/sdk";
import "@w6w/sdk/console"; // pulls in client.console

const client = new W6WClient();
const aliases = await client.console.aliases.list();
const alias = await client.console.aliases.get(aliases[0].id);
await client.console.aliases.upsert({ ...alias, description: "Send email" });
await client.console.aliases.delete(alias.id);
```

**This surface is new.** Unlike Functions/Endpoints above, there is no pre-existing
`studio/src/api/client.ts` alias code being relocated here — Studio never had alias CRUD before this
project.

| Method               | Route                 | Notes                                                                                        |
| -------------------- | --------------------- | -------------------------------------------------------------------------------------------- |
| `list()`             | `GET /aliases`        | `unwrap<AliasSummary[]>(res, "aliases")`.                                                    |
| `get(id)`            | `GET /aliases/:id`    | `unwrap<AliasDef>(res, "alias")` — plain, no splice (no server-computed field to merge in).  |
| `upsert(definition)` | `POST /aliases`       | Body is the whole `AliasDef`, forwarded verbatim. `unwrap<{id,name}>(res, "alias")` (`201`). |
| `delete(id)`         | `DELETE /aliases/:id` | Resolves to `undefined` — the server's `{ok: true}` carries no information a caller can use. |

`name` is **immutable after first save** — a save that changes `name` on an already-stored alias
answers `409 alias_name_immutable`; a first save with a name already owned by another alias answers
`409 alias_name_conflict`.

**`invoke` is deliberately NOT modeled here.** The base `client.run({urn, payload})`
(already-published surface, `endpoints.json`-named, exported from the root `mod.ts`) already reaches
an alias's target: an alias name is one of `run`'s runnable `urn` arms, alongside
`conn_…`/`wf_…`/`fn_…`/`ep_…`. Adding a duplicate `console.aliases.invoke` would give a caller two
ways to reach the same route, mirroring `console.functions`'s/`console.endpoints`'s own precedent of
NOT re-wrapping base `run`.

None of these four methods take a `project` scoping parameter — neither is reachable via any HTTP
route on this domain — so `AliasesHost` needs only the transport, mirroring
`console.workflows`'s/`console.schedules`'s own host shape.

## `console.subscriptions.*`

```ts
import { W6WClient } from "@w6w/sdk";
import "@w6w/sdk/console"; // pulls in client.console

const client = new W6WClient();
const subs = await client.console.subscriptions.list();
const sub = await client.console.subscriptions.create("app_x", "new-message", {
  workflowId: "wf_1",
});
await client.console.subscriptions.delete(sub.id);
```

Seven methods, relocated from `packages/studio/src/api/client.ts:253-286`'s single
`// Subscriptions` comment block — field-for-field, not redesigned: `listSubscriptions` → `list`,
`listSubscriptionsForWorkflow` → `listForWorkflow`, `getSubscription` → `get`, `createSubscription`
→ `create`, `deleteSubscription` → `delete`, `listSubscriptionEvents` → `listEvents`,
`requeueTriggerEvent` → `requeueEvent`.

| Method                             | Route                                                  | Notes                                                                                                                                |
| ---------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| `list()`                           | `GET /subscriptions`                                   | `unwrap<Subscription[]>(res, "subscriptions")`.                                                                                      |
| `listForWorkflow(workflowId)`      | `GET /workflows/:id/subscriptions`                     | **Dead code (HITL-4).** `unwrap<Subscription[]>(res, "subscriptions")`.                                                              |
| `get(id)`                          | `GET /subscriptions/:id`                               | **Dead code (HITL-4).** Throws `ApiError` on 404 — no null-coalescing, unlike `schedules.get`.                                       |
| `create(appId, triggerKey, input)` | `POST /apps/:appId/triggers/:triggerKey/subscriptions` | Body is `input` verbatim. `unwrap<Subscription>(res, "subscription")` (`201`).                                                       |
| `delete(id)`                       | `DELETE /subscriptions/:id`                            | Discards `{ok: true}`, resolves `void`.                                                                                              |
| `listEvents(id)`                   | `GET /subscriptions/:id/events`                        | **Dead code (HITL-4).** `unwrap<TriggerEventSummary[]>(res, "events")`. No `limit` param — the server applies its own default of 50. |
| `requeueEvent(eventId)`            | `POST /trigger-events/:eventId/requeue`                | **Dead code (HITL-4).** Discards `{ok: true}`, resolves `void`. `404 requeue_failed` when the event doesn't exist or isn't `failed`. |

**Four of these seven methods are HITL-4 dead code** — `listForWorkflow`, `get`, `listEvents`, and
`requeueEvent` have zero call sites anywhere in studio or `@w6w/ui` (re-confirmed this pass, see
`plan.md`'s SP2.9 section). They are still built to full type fidelity for SDK/wrapper coverage;
only their test bar is deliberately lighter (structural presence + wire-shape only).

**`webhookUrl` is a real server-side field this namespace deliberately does NOT model.** For a
subscription whose `appId === "@w6w/webhook"`, the server enriches the response with a `webhookUrl`
field computed from a config value distinct from studio's own `apiBaseUrl()`. Studio's
`Subscription` type never modeled this and no in-boundary code reads it (`SubscriptionsPage.tsx`
computes its own webhook URL client-side independently) — this is a deliberate, verified omission,
not an oversight.

None of these seven methods take a `project` scoping parameter — subscriptions are account-level —
so `SubscriptionsHost` needs only the transport, mirroring `VarsHost`/`ProjectsHost`, not
`DocumentsHost`.

## `console.apiCalls.*`

```ts
import { W6WClient } from "@w6w/sdk";
import "@w6w/sdk/console"; // pulls in client.console

const client = new W6WClient();
const calls = await client.console.apiCalls.list({ appId: "app_x", limit: 50 });
```

One method, relocated from `client.ts:214-231`'s `listApiCalls` — which lived under the `client.ts`
`// Apps` comment block despite having no apps-domain consumer (its only caller is reliability's
drill-down page).

| Method          | Route            | Notes                                                                                                                                          |
| --------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `list(filter?)` | `GET /api-calls` | Only DEFINED `filter` fields are sent as query params; omitted entirely, no query params are sent. `unwrap<ApiCallRecord[]>(res, "apiCalls")`. |

**`ApiCallRecord` is REUSED from `console.apps`, never redefined.** `console/apps.ts` already
declares it (used internally by `AppsApi.invoke`'s result type) and `console/mod.ts` already
re-exports it — this module imports it as a type and uses it verbatim as `list`'s return element
type, rather than declaring a second, parallel interface.

`api-calls` is scoped to the caller by the server's own repo, not by a `project` query param — so
`ApiCallsHost` needs only the transport, mirroring `VarsHost`/`ProjectsHost`, not `DocumentsHost`.

## `console.tenantOAuthApps.*`

```ts
import { W6WClient } from "@w6w/sdk";
import "@w6w/sdk/console"; // pulls in client.console

const client = new W6WClient();
const { configs, callbackUrl } = await client.console.tenantOAuthApps.list();
// Register `callbackUrl` with the provider — never assemble it client-side.
await client.console.tenantOAuthApps.put("sendgrid", "oauth2", { clientId: "abc" });
await client.console.tenantOAuthApps.remove("sendgrid", "oauth2");
```

Three methods: a tenant administrator's own OAuth client overrides for the apps their tenant
connects to. The tenant is never a parameter — these routes are scoped by the caller's own bearer
(the tenant claim) plus a server-side tenant-admin check, unlike the operator family
(`GET`/`PUT`/`DELETE /tenants/:id/oauth-app…`), which takes the tenant in the path.

| Method                       | Route                                      | Notes                                                                                                                                                 |
| ---------------------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list()`                     | `GET /tenant/oauth-apps`                   | Returns the body VERBATIM — no `unwrap()`. `callbackUrl` rides beside `configs`; unwrapping just `configs` would silently drop it.                    |
| `put(appId, authKey, input)` | `PUT /tenant/oauth-app/:appId/:authKey`    | **Body built by omission — see below.** No query string is ever set. Reads `res.body.config` directly (server answers `201`); never calls `unwrap()`. |
| `remove(appId, authKey)`     | `DELETE /tenant/oauth-app/:appId/:authKey` | Resolves `void`, discarding `{ok: true}`, same convention as `console.projects.delete`/`console.schedules.delete`.                                    |

**`put` builds its request body by OMISSION, key by key — an omitted field never reaches the wire.**
`SetTenantOAuthAppInput` has four optional keys (`clientId`, `clientSecret`, `extra`, `disabled`);
the server merges whichever ones are present over the stored row and leaves everything else
untouched. This is a genuine RUNTIME allowlist, not merely a compile-time one: even a caller that
defeats the type (`as unknown as SetTenantOAuthAppInput`) and passes `redirectUri` or `force` cannot
get either one onto the wire — neither key is ever read by the body builder. Separately, `put` sets
**no query string at all** on the request, so `?force=true` is unreachable by construction — there
is no code path that could add it, not merely an unwritten one. Neither `redirectUri` (the callback
URL is derived server-side) nor `force` (the operator's affordance) is offered to a tenant admin.

**`clientSecret: ""` IS carried to the wire verbatim, and it is destructive server-side — an omitted
`clientSecret` is not.** Measured directly against the real request body (not inferred):
`put(..., { clientSecret: "" })` produces `{"clientSecret":""}` on the wire; `put(..., {})` and
`put(..., { clientSecret: undefined })` both produce `{}`, so an omitted `clientSecret` never
reaches the request at all. On the server, `hasClientSecret` is computed as `clientSecret !== null`,
so an empty string satisfies the enabled-override invariant and **silently overwrites the stored
secret with an empty one** — no error, unlike the neighbouring `clientId: ""` and `redirectUri`
cases, which fail loudly. This is a caller obligation, not something this method enforces: **a
caller must omit `clientSecret` rather than send `""`** when it does not intend to change the stored
secret — `toSetBody` (`src/console/tenant-oauth-apps.ts:150-157`) forwards whatever it is given
verbatim and refuses nothing.

None of `list`/`put`/`remove` calls this package's `unwrap()` helper: `list` returns the whole body
(`callbackUrl` rides beside `configs`, so unwrapping just `configs` would drop it), `put` reaches
one level in itself (`res.body.config`), and `remove` discards the body entirely.

## `console.passkeys.*`

```ts
import { W6WClient } from "@w6w/sdk";
import "@w6w/sdk/console"; // pulls in client.console

// Registration (authenticated).
const client = new W6WClient();
const { options, challengeToken } = await client.console.passkeys.registrationOptions();
const response = await startRegistration({ optionsJSON: options }); // e.g. @simplewebauthn/browser
const passkey = await client.console.passkeys.registrationVerify({ challengeToken, response });

// Login (public — works on a client that holds no token yet).
const anon = new W6WClient({ baseUrl: "https://api.example.com" });
const opts = await anon.console.passkeys.authenticationOptions();
const assertion = await startAuthentication({ optionsJSON: opts.options });
const { token } = await anon.console.passkeys.authenticationVerify({
  challengeToken: opts.challengeToken,
  response: assertion,
});
```

Six methods, self-serve WebAuthn passkey management and login (T1.1.5). Who may hold one is a server
decision (HITL-3: self-serve Studio users only — a partner-tenant user's IdP owns its identity) that
this namespace has no logic for; it is a plain transport shim over whatever `PasskeyService`
decides.

| Method                        | Route                        | Public/authenticated                                                 |
| ----------------------------- | ---------------------------- | -------------------------------------------------------------------- |
| `registrationOptions()`       | `POST /me/passkeys/options`  | **AUTHENTICATED** — default `requireAuth`                            |
| `registrationVerify(input)`   | `POST /me/passkeys`          | **AUTHENTICATED** — `unwrap<Passkey>(res, "passkey")`                |
| `authenticationOptions()`     | `POST /auth/passkey/options` | **PUBLIC** — sends no bearer (`requireAuth: false`)                  |
| `authenticationVerify(input)` | `POST /auth/passkey/verify`  | **PUBLIC** — sends no bearer (`requireAuth: false`); mints a session |
| `list()`                      | `GET /me/passkeys`           | **AUTHENTICATED** — `unwrap<Passkey[]>(res, "passkeys")`             |
| `revoke(id)`                  | `DELETE /me/passkeys/:id`    | **AUTHENTICATED** — `void`, server answers `204` with no body        |

**The management quartet is GUARDED, the login pair is PUBLIC — split by route, mirroring the server
file split.** `registrationOptions`/`registrationVerify`/`list`/`revoke` are registered below the
auth guard (`packages/server/packages/api/data/passkeys.ts`'s own doc comment: "Registered BELOW the
auth guard"); `authenticationOptions`/`authenticationVerify` are the two PUBLIC routes in
`packages/server/packages/api/id/passkey-login.ts`'s own doc comment ("BOTH routes are PUBLIC and
UNAUTHENTICATED by construction"). `requireAuth: false` on the login pair is the same mechanism
`console.auth.login`/`signup`/`checkAccountSlug` are built on — without it, the login screen (the
normal case: no session exists yet) could never call either method, since a tokenless client would
hit `requireToken`'s `ConfigError` before `fetch` is ever called.

**`authenticationVerify` mints a session, the same way `console.auth.login` does (HITL-5).** A
verified passkey assertion is a standalone alternative to a password, not a second factor, so its
response — `PasskeyAuthenticationVerifyResponse` — is token-bearing. It is a SEPARATE type from
`console.auth`'s `LoginResponse`, not a reuse: `id/passkey-login.ts`'s own doc comment states the
route is "BYTE-SHAPE IDENTICAL to `user-login.ts`'s" login body, which carries `role`, `tenant` and
`emailVerified` on `user` — fields `LoginResponse.user` does not declare.

**Discoverable credentials — no identifier anywhere on the login pair.** `authenticationOptions`
takes no argument and sends no identifying value; the server resolves the credential's owner from
the assertion itself (P1, `packages/bll/passkeys.ts`'s own header). A client-supplied identifier on
the path to a session would be an account-enumeration oracle, and neither this namespace nor the
server route it calls ever reads one.

**WebAuthn ceremony payloads (`options` on the response, `response` on the input) are opaque JSON,
typed `Record<string, unknown>`.** This package has no dependency on `@simplewebauthn` (browser or
server) — adding one to type two pass-through fields would be a new dependency for zero behavioural
gain. A caller feeds `options` into `navigator.credentials.create()`/`.get()` (or a helper such as
`@simplewebauthn/browser`'s `startRegistration`/`startAuthentication`) and forwards what comes back
as `response`; this module never inspects either shape, only relays it.

None of these six methods take a `project` scoping parameter — passkeys are scoped by the caller's
own identity (or, for the login pair, resolved from the assertion) — so `PasskeysHost` needs only
the transport, mirroring `TokensHost`'s own host shape.

## `console.commerce.*`

```ts
import { W6WClient } from "@w6w/sdk";
import "@w6w/sdk/console"; // pulls in client.console

const client = new W6WClient();
const plans = await client.console.commerce.plans();
const { plan, status, canUpgrade } = await client.console.commerce.subscription();
```

Two methods over the server's existing `commerce` edge — the checked-in plan catalog, and the
caller's own resolved subscription.

| Method            | Route                        | Public/authenticated                                        |
| ----------------- | ----------------------------- | ------------------------------------------------------------ |
| `plans()`         | `GET /commerce/plans`         | **PUBLIC** — sends no bearer (`requireAuth: false`)           |
| `subscription()`  | `GET /commerce/subscription`  | **AUTHENTICATED** — default `requireAuth`                    |

**The public/guarded split is per method, not per file, exactly like `console.auth`.** `plans()` is
registered above the auth guard (`packages/server/packages/api/commerce/plans-route.ts`'s own doc
comment: "PUBLIC: registered above the auth guard by `commerce/edge.ts`") and reads nothing from the
request — no query param, no header, no principal — so its output is byte-identical for every
caller. `subscription()` derives the account from the JWT with zero DB lookups
(`subscription-route.ts`'s own doc comment: "GUARDED") and uses the default, unconditional
`requireAuth`.

**Both responses carry an envelope key — unlike `console.dashboard`.** The server answers
`c.json({ plans: catalog.map(toWirePlan) })` (`plans-route.ts`) and
`c.json({ subscription: { plan, status, canUpgrade } })` (`subscription-route.ts`), so both methods
here call this package's `unwrap()` helper: `plans()` returns `unwrap<Plan[]>(res, "plans")`,
`subscription()` returns `unwrap<CommerceSubscription>(res, "subscription")`.

`Plan`'s wire shape is restated verbatim from the server's exported `WirePlan`/`PlanLimits` — the
SDK cannot import `@w6w/server-plans` across the repo boundary — and is exactly the eight fields
`toWirePlan` allowlists (never `productId`/`base`/`metered`, which are Stripe implementation
details). `CommerceSubscription.status` is the subscription's own status, never a vendor/HTTP
status, and `CommerceSubscription.plan` is a catalog key, not a display name. The type is named
`CommerceSubscription` rather than the bare `Subscription` because that name is already taken by
`console/subscriptions.ts` (webhook-trigger subscriptions — an unrelated domain despite the shared
word; do not confuse the two).
