# SDK surface — every published symbol, and what it does

The other three documents in this directory answer different questions, and none
of them answers this one:

- [`endpoints.md`](./endpoints.md) — _what the API returns._ Wire shapes, status
  codes, error codes, per-operation semantics.
- [`implementation.md`](./implementation.md) — _how three languages render that
  identically._ Types, error model, env handling, toolchains, tests,
  conformance.
- [`cli.md`](./cli.md) — _what `w6w --help` prints,_ and what each exit code
  means.

This file is the **client-side catalog**: every symbol a wrapper publishes, what
it is for, and how it behaves. It covers the contract's operations _and_ the
things around them that are equally part of the published surface — `request`,
`path`, `joinBaseUrl`, the error classes, the run predicates, `UNSET` — none of
which appear in `endpoints.json`, because `endpoints.json` catalogs API
operations rather than client API.

Verified against the source of all three wrappers on 2026-07-29. Where this file
and the code disagree, **the code wins and this file is a bug**.

---

## 1. Construction and configuration

|                       | TypeScript (`@w6w/sdk`)                                                       | Python (`w6w`)                                                                                                                       |
| --------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Class                 | `new W6WClient(options?)`                                                     | `Client(base_url=None, token=None, project=None, transport=None, refresh_on_unauthorized=False, on_unauthorized=None, headers=None)` |
| Base URL              | `options.baseUrl` → `W6W_BASE_URL` → `https://api.w6w.io`                     | `base_url` → `W6W_BASE_URL` → `https://api.w6w.io`                                                                                                        |
| Credential            | `options.token: string \| TokenProvider` → `W6W_TOKEN` (string fallback only) | `token: Union[str, Callable[..., Optional[str]], None]` → `W6W_TOKEN` (string fallback only)                                         |
| 401 recovery (opt in) | `options.refreshOnUnauthorized?: boolean` (default `false`)                   | `refresh_on_unauthorized: bool` (default `False`)                                                                                    |
| Terminal-401 callback | `options.onUnauthorized?: (err: ApiError) => void`                            | `on_unauthorized: Optional[Callable[[ApiError], None]]`                                                                              |
| Default headers       | `options.headers?: Record<string, string>`                                    | `headers: Optional[Mapping[str, str]]`                                                                                               |
| Default project       | `options.project` (no env var)                                                | `project` (no env var)                                                                                                               |
| Transport seam        | `options.fetch` (`FetchLike`)                                                 | `transport` (`Transport`, a `urllib` opener)                                                                                         |
| Resolved config       | `client.config: ResolvedConfig`                                               | `client.config: ResolvedConfig` (frozen)                                                                                             |

**The class name differs on purpose, and it is the only name that does.** A
TypeScript caller imports the symbol flat —
`import { W6WClient } from
"@w6w/sdk"` — into a namespace shared with everything
else they import, so the prefix is what disambiguates it. A Python caller
reaches it through the package (`from w6w import Client`, or `w6w.Client`),
which already carries the brand; `w6w.W6WClient` stutters. Every _other_
published name is the same word in both, transliterated only for case convention
(`getByKey` / `get_by_key`).

Behaviour that is the same in both, and pinned:

- **The base URL and the environment are resolved once, at construction.**
  Nothing downstream re-reads the environment. Exactly one module per wrapper
  touches it (`src/env.ts`, `w6w/_env.py`). **The token is the one exception**:
  it is resolved **per request** — a plain string is the degenerate case of that
  same resolution and behaves exactly as it always has, but a `token` supplier
  is called fresh on every call, never cached from construction onward
  (`docs/implementation.md` §2).
- **Explicit argument beats environment, always.** An explicitly passed empty
  string is an _explicit value_ and does not fall through — it raises the same
  configuration error. An environment variable that is **set but empty or
  whitespace-only is ABSENT** and does fall through. That asymmetry is the
  difference between a value a caller chose and a value a shell produced.
- **There is always a base URL: explicit, then `W6W_BASE_URL`, then the default
  `https://api.w6w.io`** (`defaultBaseUrl` in `endpoints.json`, mirrored by one
  constant per lane). A malformed or explicitly empty one raises at
  construction; a missing token raises on the first request. A tokenless client is constructible on purpose, so a CLI's
  `--help` and `--version` work offline.
- **Credentials are instance state, never module globals.** Two clients in one
  process hold two credentials and point at two servers with no interference.
- **Nothing is appended to the base URL** (`BASE_PATH` is `""` since contract
  0.2.0). Trailing slashes are stripped; any configured path is preserved
  verbatim, because it cannot be told apart from a real gateway prefix.

Python additionally validates the token **as a header value** at
`require_token`: a CR, LF, NUL or other control character raises `ConfigError`
naming `W6W_TOKEN` and reporting the offending codepoint and position, never the
token itself. `$(cat token.txt)` with a trailing newline is the case this exists
for. The node lane leaves that to `Headers`, which rejects it at send time.

## 2. The transport seam and its helpers

| Symbol (TS)                                                   | Symbol (Python)                                                        | What it is                                                                                                                                                    |
| ------------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `client.request<T>(options)` → `HttpResponse<T>`              | `client.request(method, path, query=None, body=None)` → `HttpResponse` | One authenticated request. Public so a host can reach a route this version does not model. Returns **status and body**, because `202` is success on this API. |
| `` path`/documents/${key}` ``                                 | `path("/documents/{key}", key=key)`                                    | Percent-encodes every interpolated value **at the point of interpolation**.                                                                                   |
| `joinBaseUrl(origin)`                                         | `join_base_url(origin)`                                                | The one and only base-URL code path — the same function `resolveConfig` uses, so the helper and the client can never answer differently.                      |
| `BASE_PATH`                                                   | `BASE_PATH`                                                            | `""`. Mirrors the contract's `basePath`; the answer to "what does this client prepend?" is _nothing_.                                                         |
| `VERSION`                                                     | `__version__`                                                          | This package's published version, equal to the shared `VERSION` file.                                                                                         |
| `HttpMethod`, `QueryParams`, `RequestOptions`, `HttpResponse` | `HttpResponse` (a `NamedTuple`), `Transport`                           | The request/response types of the seam.                                                                                                                       |

`path` is a **tagged template** in TypeScript and a **format function** in
Python for the same reason: encoding must be impossible to forget one call site
at a time. Use it for every path containing a caller-supplied value. It is
_encoding, never validation_ — a key the server accepts is sent as-is (encoded)
and never rejected, trimmed or canonicalised locally.

The one input it cannot fix is a dot-only path segment (`.`, `..`): `.` is
unreserved in RFC 3986, so no encoder touches it. **The two lanes genuinely
differ here and it is documented rather than papered over** — `fetch` (WHATWG
URL) removes dot segments before sending, `urllib` sends them literally. The
server closed the hole at the other end instead: `POST /documents` rejects a key
of exactly `.` or `..`, so no such key exists to address.

## 3. Errors

Two classes, in both languages, and the split is diagnostic:

| Class         | Raised when                                                                                                                   | Fields                             |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| `ConfigError` | The client was never in a position to make a request — a malformed base URL, no token, an unsendable token. No HTTP exchange happened. | message (naming the env var)       |
| `ApiError`    | The server answered, or could not be reached at all.                                                                          | `status`, `code`, `message`, `raw` |

`ApiError` has exactly **three** shapes and no others:

1. **Transport failure** — `status: 0`, `code: "network_error"`; the message
   names the method and the full URL plus the underlying error.
2. **Non-JSON body on a non-OK status** — `code: "bad_response"`, with a ≤200
   character snippet (a proxy's HTML error page). A non-JSON body on an **OK**
   status is not an error. A non-OK status with **no** body is case 3, not this
   one.
3. **Envelope error** — `code` and `message` from `body.error`, `raw` = the
   parsed body, kept because an invoke failure rides alongside `logs` and
   `apiCalls`.

Wrappers add one code of their own: **`bad_response` for a `2xx` that did not
carry what it promised** — a missing envelope key, a `me` body that is not an
object, a run body with no string `runId`/`status`, a `run` body with no string
`kind`. It stays distinct from `"error"`: `"error"` means _your request was
rejected_, `bad_response` means _this server is broken_.

Classify by `status` plus a **prefix** of `code` (`unknown_*` 404, `invalid_*`
400, `*_exists` 409), never by an exhaustive list — the server mints codes
freely. **`424` is an app/upstream execute-phase failure** and is a 4xx on
purpose (Cloudflare replaces an origin 5xx with a CORS-less HTML page); it is
never normalised into a transport error or a 5xx. A `401` has **no side
effect**: no retry, no refresh, no callback.

## 4. The operations

Seventeen, identical in both SDKs. The wire detail lives in
[`endpoints.md`](./endpoints.md); what follows is the _client_ behaviour.

**TS-only, every read below:** `opts?` on the eleven read methods a `@w6w/react`
read hook calls (`client.me`, `documents.list`/`get`/`getByKey`,
`vars.list`/`get`, `connections.list`, `workflows.list`/`get`,
`functions.list`/`get`) also accepts an optional `signal?: AbortSignal`
(`CallOptions`, R-7) — forwarded to the injected `fetch` unchanged and never
serialized into the URL or body. See [parity.md](./parity.md)'s "Per-call
cancellation (node only)" section for why Python and the CLI have no analog.

### Identity

| TS                 | Python        | Returns |
| ------------------ | ------------- | ------- |
| `client.me(opts?)` | `client.me()` | `Me`    |

`GET /auth/me` — the server's real identity route, called directly. The body is
**flat**; nothing is unwrapped. The one thing the client adds is
`versions.wrapper`, its own version, as a **default the server overrides**
(`{wrapper: VERSION, ...server}`, never the other order). The map is otherwise
carried through unaltered — rendering a placeholder as `dev` is the CLI's
display rule, not a data rule. The server sends `versions.server` and
`versions.composition` (= `GET /version`'s `version` / `composition`); unknown
keys are still tolerated. A `2xx` body that is not an object (a list
included) raises `bad_response`.

### Discovery

| TS                               | Python                                | Returns                                           |
| -------------------------------- | ------------------------------------- | ------------------------------------------------- |
| `client.connections.list(opts?)` | `client.connections.list()`           | `ConnectionSummary[]` / `List[ConnectionSummary]` |
| `client.workflows.list(opts?)`   | `client.workflows.list(project=None, tag=None)` | `WorkflowSummary[]` / `List[WorkflowSummary]`     |

Both exist so a caller can _discover_ a `conn_…` / `wf_…` id to hand to `run`
(D4). Both unwrap their envelope key and return the payload array. Connections
can be listed, fetched and deleted in this version; creating, updating, testing
and OAuth-connecting one are interactive, secret-handling studio flows and are out
of scope. `connections.list` sends **no** `?project=`
even when the client has a default; `workflows.list` does. `workflows.list`,
`functions.list` and `endpoints.list` take an optional `tag` (TS `{ tag }`, Python `tag=None`,
CLI `--tag`), sent as `?tag=` only when set; a row matches when a tag equals it or starts with
it plus `.`. `FunctionSummary` and `EndpointSummary` carry `tags`.

Neither is paginated today and neither pretends otherwise — no cursor argument,
no client-side paging loop.

`connections.get(id)` and `connections.delete(id)` address one such id: `get`
returns one `ConnectionSummary`, `delete` returns nothing, and both answer a
uniform `404` for another account's id or a built-in `zerocred:` row. `delete(id, { force })` / `delete(id, force=False)` takes an optional `force`, sent as `?force=true` only when true: without it, a connection still used by live callables is refused with `409 connection_in_use` (the error carries `dependents`); with it, the dependents are disabled and the delete proceeds. The list can
include that built-in row, flagged `builtIn: true` (optional — an older server
omits it); it is never fetchable or deletable. Since contract `0.19.0` a row may
carry its keep-alive state — `autoRefresh`, `lastRefreshedAt` and
`refreshFailingSince` — optional in TS and `None` in Python against an older
server.

### Integration reads

| TS                                                       | Notes                                                                                      |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `client.apps.byIds(ids, opts?)`                          | Chunks to the server's 100-id cap; `[]` makes no request; duplicates collapsed            |
| `client.dashboard.stats(opts?)`                          | Account-scoped (no project); `from` / `to` / `bucket`                                      |
| `client.projects.list(opts?)`                            | Read-only; first call may create the default project                                       |
| `client.reliability.list(project, appIds, opts?)`        | At most 10 app ids (server `400` otherwise, surfaced unchanged); no batching helper        |
| `client.reliability.members(project, opts?)`             | Which apps the project's calls touch; feed up to ten at a time to `list`                   |

For a connection's own icon and label use the inline `app` on `ConnectionSummary`
— it is the primary source and costs no extra request.

### Execution

| TS                                | Python                                                                           | Returns             |
| --------------------------------- | -------------------------------------------------------------------------------- | ------------------- |
| `client.run(input)`               | `client.run(urn, action=None, payload=None)`                                     | `RunEnvelope`       |
| `client.workflows.run(id, opts?)` | `client.workflows.run(id, wait=False, variables=None, trigger=None, input=None, allow_unpublished=False, entry=None)` | `WorkflowRunResult` |

`run` dispatches on a URN over four runnable arms (`conn_`, `wf_`, `fn_`, `ep_`)
and returns the `kind`-tagged envelope **exactly as it arrived**. `action` is
omitted from the body when absent; `payload` defaults to `{}` rather than being
omitted. A body with no string `kind` is `bad_response`.

`workflows.run` is the typed path and the only one that can wait. `wait` is sent
as `?wait=true` **only when true** — never `?wait=false`, which the server reads
as no-wait anyway. `variables`, `trigger` and `input` are body fields; `trigger`
is an **open string**, passed through unvalidated, so a sixth server-side value
needs no wrapper release. `variables` and `input` are not the same slot:
`variables` seeds the run's variable scope (`vars.*`); `input` is delivered to
the entry trigger node's own recorded output (`nodes.<triggerId>.output.<key>`,
the same value the older `steps.<triggerId>.output.<key>` alias reads) — the
shape a trigger's declared fields actually arrive in. It returns the wire body
plus two derived signals: `terminal` (from the run's own status) and
`httpStatus` (`200` finished, `202` still going) — the body alone cannot tell a
`?wait=` timeout from a run that was never waited on.

The run body's per-node state is keyed by node id under `nodes`, and repeated
under `steps`, its alias, with identical records — read either. A failed node's
error record carries `nodeId`, with `stepId` beside it holding the same id. A
`202` carries neither map, so both packages normalise the pair to `{}` rather
than leaving it absent. `RunResult.nodes` is **optional** in the TypeScript type
(so a `RunResult` built without one still compiles) while `steps` is required;
at run time both are always populated.

Three rules both operations obey:

- **`202` is success.** Never raised, in either.
- **A failed run is data** — a `200` with `status: "failed"` and an `error`.
  Returned, never raised. Turning it into an exit code is the CLI's job.
- **No client-side polling, ever.** There is no timer, sleep or retry anywhere
  in either package. The server's `?wait=true` is the mechanism.

### Definitions — the workflow and Function lifecycle

| TS                                               | Python                                                                            | Returns                                       |
| ------------------------------------------------ | --------------------------------------------------------------------------------- | --------------------------------------------- |
| `client.workflows.get(id, opts?)`                | `client.workflows.get(id)`                                                        | `WorkflowDetail`                              |
| `client.workflows.create(definition, opts?)`     | `client.workflows.create(definition, project=None)`                               | `WorkflowSaveResult`                          |
| `client.workflows.update(id, definition, opts?)` | `client.workflows.update(id, definition, project=None, if_unmodified_since=None)` | `WorkflowSaveResult`                          |
| `client.workflows.archive(id)`                   | `client.workflows.archive(id)`                                                    | the definition                                |
| `client.workflows.delete(id)`                    | `client.workflows.delete(id)`                                                     | `void` / `None`                               |
| `client.workflows.listVersions(id)` | `client.workflows.list_versions(id)` | `VersionList` |
| `client.workflows.getVersion(id, n)` | `client.workflows.get_version(id, n)` | `VersionDetail` |
| `client.workflows.publish(id)` | `client.workflows.publish(id)` | `PublishResult` |
| `client.workflows.revert(id, n)` | `client.workflows.revert(id, n)` | `RevertResult` |
| `client.workflows.enable(id)` | `client.workflows.enable(id)` | `void` / `None` |
| `client.workflows.disable(id)` | `client.workflows.disable(id)` | `void` / `None` |
| `client.workflows.runVersion(id, n, opts?)` | `client.workflows.run_version(id, n, ...)` | `WorkflowRunResult` |
| `client.functions.list(opts?)`                   | `client.functions.list(tag=None)`                                                   | `FunctionSummary[]` / `List[FunctionSummary]` |
| `client.endpoints.list(opts?)`                 | `client.endpoints.list(tag=None)`                                                   | `EndpointSummary[]` / `List[EndpointSummary]` |
| `client.functions.get(id, opts?)`                | `client.functions.get(id)`                                                        | `FunctionDetail`                              |
| `client.functions.create(definition)`            | `client.functions.create(definition)`                                             | `{id, key, updatedAt}` / `SaveResult`         |
| `client.functions.update(id, definition, opts?)` | `client.functions.update(id, definition, if_unmodified_since=None)`                | `{id, key, updatedAt}` / `SaveResult`         |
| `client.functions.delete(id)`                    | `client.functions.delete(id)`                                                     | `void` / `None`                               |
| `client.functions.archive(id)` | `client.functions.archive(id)` | the definition |
| `client.functions.listVersions(id)` | `client.functions.list_versions(id)` | `VersionList` |
| `client.functions.getVersion(id, n)` | `client.functions.get_version(id, n)` | `VersionDetail` |
| `client.functions.publish(id)` | `client.functions.publish(id)` | `PublishResult` |
| `client.functions.revert(id, n)` | `client.functions.revert(id, n)` | `RevertResult` |
| `client.functions.enable(id)` | `client.functions.enable(id)` | `void` / `None` |
| `client.functions.disable(id)` | `client.functions.disable(id)` | `void` / `None` |
| `client.functions.runVersion(id, n, opts?)` | `client.functions.run_version(id, n, ...)` | the Function's output |

**The definition itself is opaque in both languages** —
`Record<string, unknown>` / `dict`. A workflow's `nodes[]` carry node types the
engine owns and extends, and a Function's `impl` is a union the server extends
(app Action, another Function, a Workflow); modelling either would make the
wrapper reject a document a newer server accepts. What the SDKs _do_ model is
the envelope around it: `WorkflowDetail`, `WorkflowSaveResult`,
`FunctionDetail`, `FunctionSummary`.

A workflow definition is stored and returned as `nodes[]`. A definition you
write may use the older `steps[]` name instead — the entries are the same — but
not both: a body carrying both arrays, or neither, is `400 invalid_workflow`.

Four rules all of them obey:

- **`create` and `update` are the same route.** The server has one upsert per
  domain and no PATCH. What separates the two methods is that `create` mints the
  `id` the server requires and never generates, and `update` pins the one you
  addressed — overriding any `id` in the body, so `update("wf_a", defOfB)`
  cannot silently write to B.
- **`update` is a full replacement.** A field left out is a field removed. Read,
  edit, send the whole thing back.
- **Reads keep their extra field outside the definition.** `workflows.get`'s
  `updatedAt` and `functions.get`'s `valid` and `updatedAt` are siblings of the document, never
  spliced into it — they are not part of the stored document, and the read is
  the input to the write.
- **Deleting a workflow takes two calls.** `archive` then `delete`; the SDK does
  not do the first for you when the server answers `409 workflow_not_archived`.
  A Function is the same: `functions.archive` then `functions.delete`
  (`409 function_not_archived`).

**Versions and the draft run.** Both domains also expose `listVersions`,
`getVersion`, `publish`, `revert`, `enable`, `disable` and `runVersion`, with the
same names and shapes (`runVersion` is `POST …/versions/{n}/run` for a workflow
and `…/invoke` for a Function). `getVersion` and `revert` unwrap their single-key
envelope, `enable` and `disable` return nothing, and `run` on either domain takes
`allowUnpublished: true` to execute the **stored** definition without a publish —
sent only when `true`, and never a submitted body, so save first. `publish`
snapshots the stored row, so flush any pending save before it.

**What a plain run executes.** Without `allowUnpublished`, `run` still executes the **stored** definition
as last saved — publishing is a precondition (the workflow or Function must have at least one published version), not a
selector. Edits saved after a publish are what the next plain `run` executes. To execute exactly what was
published, call `runVersion(id, n)`.

The asymmetries between the two domains are the server's, not the wrappers':
workflows take `?project=` and an `x-w6w-if-unmodified-since` precondition;
Functions take neither, and no request on that domain carries a project even
when the client has a default.

### Documents — project-scoped

| TS                                          | Python                                                                                      | Returns         |
| ------------------------------------------- | ------------------------------------------------------------------------------------------- | --------------- |
| `client.documents.list(opts?)`              | `client.documents.list(project=None)`                                                       | `Doc[]`         |
| `client.documents.get(id, opts?)`           | `client.documents.get(id, project=None)`                                                    | `Doc`           |
| `client.documents.getByKey(key, opts?)`     | `client.documents.get_by_key(key, project=None)`                                            | `Doc`           |
| `client.documents.create(input, opts?)`     | `client.documents.create(key, content, format=None, description=None, project=None)`        | `Doc`           |
| `client.documents.update(id, patch, opts?)` | `client.documents.update(id, content=UNSET, format=UNSET, description=UNSET, project=None)` | `Doc`           |
| `client.documents.delete(id, opts?)`        | `client.documents.delete(id, project=None)`                                                 | `void` / `None` |

### Vars — **not** project-scoped

| TS                              | Python                                                               | Returns         |
| ------------------------------- | -------------------------------------------------------------------- | --------------- |
| `client.vars.list(opts?)`       | `client.vars.list()`                                                 | `Var[]`         |
| `client.vars.get(id, opts?)`    | `client.vars.get(id)`                                                | `Var`           |
| `client.vars.getByName(name)`   | `client.vars.get_by_name(name)`                                      | `Var`           |
| `client.vars.create(input)`     | `client.vars.create(name, type, value, description=None)`            | `Var`           |
| `client.vars.update(id, patch)` | `client.vars.update(id, type=UNSET, value=UNSET, description=UNSET)` | `Var`           |
| `client.vars.delete(id)`        | `client.vars.delete(id)`                                             | `void` / `None` |

Shared rules for both asset namespaces:

- **Create by `key`/`name`; read by id _or_ by the dedicated `by-key`/`by-name`
  route; update and delete by id.** The wrapper mirrors the server's addressing
  exactly.
- **`key` and `name` are immutable** — neither appears in a patch type, so the
  type is what enforces it rather than a comment.
- **No client-side list-then-filter anywhere.** A key-addressed read is a server
  route or it does not exist.
- **`delete` returns nothing.** The server's `{ok: true}` carries nothing a
  caller can use, and unwrapping it to a value would invite
  `if (await delete(...))`. Deleting an unknown id is a `404`, **not** a silent
  success — the delete is not idempotent and neither wrapper pretends otherwise.
- **The project asymmetry is real.** Every `documents.*` operation takes an
  optional `project` (per-call → client default → nothing); **no `vars.*`
  operation takes one**, because the server reads none and the table has no
  column. Both wrappers enforce it structurally: the `vars` namespace is
  constructed without the client's configuration, so it holds no default to
  send, and the wire assertion in each suite is what actually holds the line.

### App management

| TS | Python | Returns |
| -- | ------ | ------- |
| `client.appManagement.list(opts?)` | `client.app_management.list(...)` | `ManagedAppsPage` (rows, `targets`, `sourceOptions`) |
| `client.appManagement.get(id, opts?)` | `client.app_management.get(id)` | `ManagedAppDetail` |
| `client.appManagement.preview(input, opts?)` | `client.app_management.preview(source, target)` | `AppManagementPreview` |
| `client.appManagement.register(input, opts?)` | `client.app_management.register(target, source, paths=None)` | `RegisterAppResult` |
| `client.appManagement.updateSource(id, input, opts?)` | `client.app_management.update_source(id, source, expected_revision)` | `SyncResult` |
| `client.appManagement.sync(id, opts?)` | `client.app_management.sync(id, expected_revision=None)` | `SyncResult` |
| `client.appManagement.remove(id, opts?)` | `client.app_management.remove(id)` | `{ removed: number }` |

Bodies come back exactly as sent (no envelope key to unwrap). `SyncOutcome` is closed;
`ManagementClass`, `UnavailableReason` and `TargetOption.reason` are open strings.

### Data stores — project-scoped

| TS | Python | Returns |
| -- | ------ | ------- |
| `client.dataStores.list(opts?)` | `client.data_stores.list(kind=None, cursor=None, limit=None, project=None)` | `DataStorePage` |
| `client.dataStores.get(id, opts?)` | `client.data_stores.get(id, project=None)` | `DataStore` |
| `client.dataStores.create(input, opts?)` | `client.data_stores.create(kind, name, description=None, schema=None, project=None)` | `DataStore` |
| `client.dataStores.update(id, patch, opts?)` | `client.data_stores.update(id, name=None, description=None, schema=None, project=None)` | `DataStore` |
| `client.dataStores.archive(id, opts?)` | `client.data_stores.archive(id, project=None)` | `void` |
| `client.dataStores.importCsv(id, csv, opts?)` | `client.data_stores.import_csv(id, csv, project=None)` | `{ imported: number }` |
| `client.dataStores.exportCsv(id, opts?)` | `client.data_stores.export_csv(id, project=None)` | `string` |
| `client.dataStores.entries.list(id, opts?)` | `client.data_stores.entries.list(id, prefix=None, cursor=None, limit=None, project=None)` | `DataStoreEntryPage` |
| `client.dataStores.entries.get(id, key, opts?)` | `client.data_stores.entries.get(id, key, project=None)` | `DataStoreEntry` |
| `client.dataStores.entries.set(id, key, input, opts?)` | `client.data_stores.entries.set(id, key, value, if_version=None, ttl_seconds=None, project=None)` | `DataStoreEntry` |
| `client.dataStores.entries.insert(id, row, opts?)` | `client.data_stores.entries.insert(id, value, ttl_seconds=None, project=None)` | `DataStoreEntry` |
| `client.dataStores.entries.increment(id, key, by?, opts?)` | `client.data_stores.entries.increment(id, key, by=None, project=None)` | `DataStoreEntry` |
| `client.dataStores.entries.delete(id, key, opts?)` | `client.data_stores.entries.delete(id, key, project=None)` | `void` |
| `client.dataStores.entries.query(id, query?, opts?)` | `client.data_stores.entries.query(id, where=None, order=None, limit=None, project=None)` | `DataStoreRowSet` |

Every operation takes an optional `project` (per-call → client default → nothing). Single
resources and pages come back exactly as the server sends them (no envelope key to unwrap);
`nextCursor` is absent, never `null`, on the last page. `importCsv` takes the CSV as a string
(text mode, `bodyEncoding: "csv"`) and `exportCsv` returns it verbatim as a string
(`responseEncoding: "text"`); see implementation.md §3. `DataStoreKind` is the closed union
`"kv" | "doc" | "table"`.

## 5. Wire types and the run types

Both packages export the transcribed wire shapes: `Doc`, `DocFormat`, `Var`,
`VarType`, `Me`, `ConnectionSummary`, `ConnectionAppMeta`, `ConnectionState`, `WorkflowSummary`,
`WorkflowStatus`, `RunStatus`, `StepError`, `RunResult`, `WorkflowRunResult`,
`RunEnvelope`. Field names are the **wire's, verbatim** — `createdAt`, not
`created_at`, in Python too. Timestamps stay ISO-8601 **strings** in both; date
parsing is a policy three languages would have to adopt together.

`RunEnvelope` is the one type that is deliberately **not** transcribed into a
struct:

| Arm             | `kind`       | Field                    | HTTP  |
| --------------- | ------------ | ------------------------ | ----- |
| action          | `"action"`   | `value`                  | `200` |
| function        | `"function"` | `output`                 | `200` |
| workflow        | `"workflow"` | `runId` + `status`       | `202` |
| _anything else_ | any string   | whatever the server sent | any   |

`value` and `output` are **different names on purpose** and are never normalised
into one field — the discrimination is the point. **An unknown `kind` is
returned verbatim, never raised**: the server may grow a fourth arm before the
wrappers do, on the one operation whose entire job is dispatch, and raising
would turn an additive server change into a hard breakage for every installed
client.

Discriminate it with the exported predicates:

| TS                            | Python                           |
| ----------------------------- | -------------------------------- |
| `isActionRun(env)`            | `is_action_run(env)`             |
| `isFunctionRun(env)`          | `is_function_run(env)`           |
| `isWorkflowRun(env)`          | `is_workflow_run(env)`           |
| `isTerminalRunStatus(status)` | `is_terminal_run_status(status)` |

In TypeScript they are **type guards**, and they are not optional ceremony: the
union is open, so a bare `env.kind === "workflow"` check does _not_ narrow, and
`env.status` would come out `unknown`. In Python they are plain predicates over
the returned dict.

## 6. Where the two SDKs deliberately differ

Same operations, same behaviour, different idiom. Each of these is a decision,
not drift:

|                         | TypeScript                                                                                  | Python                                                                                                                   | Why                                                                                                                                                                                                                                                       |
| ----------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Optional inputs         | An options object (`create(input, opts?)`)                                                  | Keyword arguments                                                                                                        | Each language's idiom; the bytes on the wire are identical.                                                                                                                                                                                               |
| Omit vs null in a patch | `undefined` members vanish at `JSON.stringify`                                              | `UNSET` sentinel (`Unset`, `PatchableStr`, `patch_body`)                                                                 | Python has one absent value and this API needs two: `{}` means _leave it alone_, `{"value": null}` means _set it to null_, and the server tests `!== undefined`. Defaulting to `None` would turn every "don't touch this" into "null this", silently.     |
| Unknown response fields | Structural interfaces — an unmodelled field is still present at runtime                     | Frozen dataclasses — known fields kept, the rest dropped                                                                 | Both _tolerate_ the field; only the TS lane can also _carry_ it. A Python caller who needs one reaches it through `client.request`, which hands back the parsed body untouched.                                                                           |
| List results            | `WorkflowSummary[]`, widenable to carry a cursor later                                      | A plain `list`                                                                                                           | A JS array is an object and can grow a property; a Python list cannot. So neither invents a container now — the day the server paginates, all three grow the same one together.                                                                           |
| Namespace host types    | `DocumentsHost` / `VarsHost` interfaces                                                     | `DocumentsHost` / `WorkflowsHost` protocols, `VarsRequest` / `ConnectionsRequest` / `MeRequest` / `RunRequest` callables | Same layering: a namespace sees the transport, and sees the configuration **only** if it is project-scoped.                                                                                                                                               |
| Transport               | `fetch` (injectable via `options.fetch`)                                                    | `urllib.request` (injectable via `transport`)                                                                            | Zero runtime dependencies in both. Note the `urllib` trap: `urlopen` **raises** `HTTPError` for any non-2xx, and an `HTTPError` _is_ a response — it is routed to the envelope mapper, never to `network_error`.                                          |
| Token supplier          | May be **sync or async** — `TokenProvider` may return a `Promise`, which `request()` awaits | **Sync only** (R-1) — `Callable[..., Optional[str]]`, called and used immediately, never awaited                         | There is no `asyncio` anywhere in this package, and no sync/async split in its transport (`urllib`, blocking) for a supplier to straddle. A python host that needs to await something resolves it _before_ handing the value to a sync provider function. |

## 7. The CLI (`@w6w/cli`)

The CLI is a presentation layer over `@w6w/sdk` and adds no operations: every
command is one SDK call. `w6w <group> <command>` mirrors
`client.<group>.<method>` (`naming.cli` in the contract), `w6w me` and `w6w run`
sit at the root, and `w6w info` is an accepted alias of `w6w me`.

What it adds beyond the SDK, and nothing else:

- **`--help` at three levels**, generated from `endpoints.json`, resolving with
  **no token and no network**, exiting `0`. Bare `w6w` prints root help and
  exits `0`; an unknown or incomplete command prints help to **stderr** and
  exits `1`.
- **Output modes** — a human table by default, `--json` for the raw payload,
  `--no-color` for a dumb terminal.
- **The exit-code contract**, which is the only part of an answer a CI job
  reads: `0` success (including a queued or running run), `1` usage, `2` API
  error, `3` a `--wait` run that came back `failed`. Code `3` exists precisely
  so a failed workflow and an unreachable API — which demand opposite responses
  — cannot be confused by a script.
- **Flag-level precedence:** `--base-url` / `--token` beat the environment.

See [`cli.md`](./cli.md) for the help text itself.

## 8. What is not here

In scope since the contract's `0.5.0`–`0.7.0` lines: the full definition lifecycle
of workflows and Functions (create / update / archive / delete, plus publish,
version and draft-run operations), and, for integrations, `connections.get` and
`connections.delete`, `apps.byIds`, `dashboard.stats`, `projects.list`, and
`reliability.list` / `reliability.members`; and, since `0.14.0`, app-definition
management (`appManagement.*`).

Out of scope for this version, in every wrapper, and named so nobody adds them in
one language: connection create / update / test / OAuth (interactive,
secret-handling flows), the app catalog's browse / search / paging (only the
bounded `apps.byIds` lookup is in; app-definition management is in as `appManagement.*`), project writes, endpoint management, vault,
tokens, schedules, triggers, subscriptions, tenants, `runs.get` and
`workflows.listRuns`. They exist on the API. They are not in the wrappers until
they are in `endpoints.json` — see
[`parity.md` §Adding an operation](./parity.md#adding-an-operation).

Also deliberately absent from every wrapper, because they are browser couplings
rather than library behaviour: ambient credential storage, a mutable
module-level token, an auth-error callback, a redirect on `401`, retries, token
refresh, and client-side run polling.

## Server-only subpath — `@w6w/sdk/server`

**Not part of the surface above.** `createEmbedSessionClient` /
`EmbedSessionClient` (the recommended path) and the lower-level
`exchangeToken` / `exchange_token` are standalone, outside `endpoints.json`'s
`operations[]`, reachable only through a separate entry point in each language:

|                      | TypeScript                                                                                                             | Python                                                                                              |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Import               | `import { exchangeToken } from "@w6w/sdk/server"`                                                                      | `from w6w.server import exchange_token`                                                             |
| On the root surface? | No — not exported from `@w6w/sdk`'s barrel (`mod.ts`), and not on `@w6w/sdk/console` either                            | No — not re-exported from `w6w/__init__.py`, and not listed in `w6w.__all__`                        |
| Signature            | `exchangeToken(options: { baseUrl?, clientId, clientSecret, subject, account?, fetch? }): Promise<ExchangeTokenResult>` | `exchange_token(base_url=None, client_id=None, client_secret=None, subject=None, account=None, transport=None) -> dict` |
| Session client import | `import { createEmbedSessionClient } from "@w6w/sdk/server"` | `from w6w.server import EmbedSessionClient` |
| Session client on the root surface? | No — same exclusions as above | No — same exclusions as above |
| Session client signature | `createEmbedSessionClient(options: { baseUrl?, clientId, clientSecret, fetch?, now? }): EmbedSessionClient`, then `.create({ subject, accountRef }): Promise<EmbedSession>` | `EmbedSessionClient(base_url=None, client_id=None, client_secret=None, *, transport=None, now=None)`, then `.create(subject, account_ref) -> dict` |

**What it does.** `exchangeToken` / `exchange_token` calls `POST /auth/exchange` with a tenant's client credentials
and names one of the tenant's end-users via `subject`, minting a short-lived,
`role: "user"` token scoped to that tenant + subject — the server-side half of
"Path A" token exchange. The user-facing walkthrough is
[docs.w6w.io/clients/node/embedding](https://docs.w6w.io/clients/node/embedding/);
see also the `node` lane's `README.md` "Embedding for enterprise tenants".

**Self-hosting.** Self-hosted deployments must pass their API origin explicitly; when omitted, the helper sends the tenant client credentials to `https://api.w6w.io`. These helpers never read `W6W_BASE_URL`.

**The session client — the recommended embed path.** `createEmbedSessionClient`
/ `EmbedSessionClient` holds one tenant's credentials per instance and mints one
account-scoped session per `create()`: exactly one `POST /auth/exchange`, made
through `exchangeToken` / `exchange_token` (still the only HTTP path). Unlike
`exchangeToken`, the account is **required**: `accountRef` / `account_ref` is the
host's own reference for the company the user is acting in (the account's
external ref), because the server selects the tenant's default account when
`account` is blank. Rules:

- `baseUrl` / `base_url` is optional: omitted, it defaults to
  `https://api.w6w.io`; it never falls back to `W6W_BASE_URL`. A blank value
  is a `ConfigError`, not the default. `clientId`/`clientSecret` follow the same rules as
  `exchangeToken`'s (below).
- `subject` is sent verbatim, never trimmed. `accountRef` is trimmed (Node: ECMAScript
  `trim`; Python: the same whitespace set) and sent as the wire `account`. Both must be
  non-blank strings; otherwise a local `ConfigError`, with no request made.
- Node construction throws `ConfigError` when both `window` and `document` exist
  (a browser-like global): a runtime check, which a bundler may or may not remove.
  Python has no equivalent check; the class is simply not on the root surface.
- `now` is a clock sampled before each request: epoch **milliseconds** in Node
  (default `Date.now`), epoch **seconds** in Python (default `time.time`).
- Python only: `base_url` must be the final `https` origin, with no redirect hop. The
  exchange and session helpers (`exchange_token`, `EmbedSessionClient`) use a no-redirect
  transport (`_http.no_redirect_transport`) by default: a 3xx raises `ApiError` and the
  `Authorization: Basic` client credential is never re-sent. `Client` is unchanged and still
  uses `urllib.request.urlopen`. An injected `transport` is used as given.

`create()` returns exactly seven keys, all browser-safe (no `role`, no `studioUrl`,
never the client secret):

```
{
  token: string,       // the minted bearer token
  expiresIn: number,   // lifetime, in seconds
  expiresAt: string,   // ISO-8601 UTC, host clock sampled before the request + expiresIn
  subject: string,     // the subject the server minted into the token
  tenant: string,      // the tenant the client credentials resolved to
  account: string,     // the server's resolved account id, acct_…
  accountRef: string,  // the trimmed ref that was sent as the wire `account`
}
```

(Python's dict uses the same camelCase keys.) A reply that is not the documented
shape raises `ApiError` with status `200` and code `bad_response`. Server and transport
errors are surfaced unwrapped, status and code intact. The step-by-step host route
is [Embed w6w in your product](/guides/embed/).

**Why there is no CLI command, and why React is unchanged.** The CLI gets no
`session` command: it would put the tenant client secret in an end-user tool, and
the helper is outside `endpoints.json`, which the CLI implements. `react/` is a derived
lane wrapping `@w6w/sdk`, so it is unchanged; it only ever receives the browser-safe
session object from the host's own route. See `parity.md` "Server-only helpers".

**Basic auth only — never a second credential channel.** The tenant's
`clientId`/`clientSecret` travel in exactly one place:
`Authorization: Basic base64(clientId:clientSecret)`, encoded as latin-1 (the
alphabet the server's `atob`-based decode reads). The request body is
`{"subject": subject}`, or `{"subject": subject, "account": account}` when
`account` is given — never a `clientId`/`clientSecret` key in the body, the URL
or a query string. Neither function requires (or sends) a bearer: both call the
shared transport with `requireAuth: false` / `require_auth=False`, the same
escape hatch each lane's own `console.auth.login` uses for a route that
authenticates itself.

**Validated locally, before any network call**, always as a `ConfigError` /
local exception whose message never echoes `clientSecret`: a blank
`clientId`/`clientSecret`/`subject`; a `clientId` containing `:` (the server
decodes a Basic credential by splitting on the FIRST colon, so a colon inside
`clientId` would be read as part of the secret); or a `clientId`/`clientSecret`
containing a character outside latin-1.

**The returned shape**, transcribed from the server's `exchangeHandler`
(`packages/server/packages/api/data/exchange.ts`):

```
{
  token: string,
  user: { subject: string, tenant: string, role: string, account: string },
  expiresIn: number,
}
```

`user.account` is always the server's **resolved** account id (`acct_…`), never the
raw claim you sent: a given `account` is an external reference that the server
finds or creates, and with no `account` it is the tenant's default account.

**Server errors**, surfaced as the lane's ordinary `ApiError` / `ApiError`
exception, with the server's own code: `invalid_client` (401 — unknown or
disabled client credentials), `invalid_body` (400 — malformed JSON),
`invalid_subject` (400), `invalid_account` (400), `tenant_disabled` (401 — the
tenant itself is disabled) and `rate_limited` (429). A `400` can arrive before the
credentials are verified, so a `400` does not prove the credentials are valid. None
of these are retried: a
`requireAuth: false` / `require_auth=False` request never gets the opt-in 401
recovery either lane's transport otherwise offers.

**Why this lives outside the published client-surface table above.** It is not
an operation a `W6WClient`/`Client` instance exposes — there is no credential on
the instance to call it with, since the whole point is minting one. It is a free
function taking its own `baseUrl`/`base_url`, meant to run once on a partner's
backend per end-user session, never inside a browser or a mobile client — the
client secret it takes must never reach end-user code.
