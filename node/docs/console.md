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
