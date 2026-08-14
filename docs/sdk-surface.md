# SDK surface — every published symbol, and what it does

The other three documents in this directory answer different questions, and none
of them answers this one:

- [`endpoints.md`](./endpoints.md) — *what the API returns.* Wire shapes, status
  codes, error codes, per-operation semantics.
- [`implementation.md`](./implementation.md) — *how three languages render that
  identically.* Types, error model, env handling, toolchains, tests, conformance.
- [`cli.md`](./cli.md) — *what `w6w --help` prints,* and what each exit code means.

This file is the **client-side catalog**: every symbol a wrapper publishes, what
it is for, and how it behaves. It covers the seventeen operations *and* the
things around them that are equally part of the published surface — `request`,
`path`, `joinBaseUrl`, the error classes, the run predicates, `UNSET` — none of
which appear in `endpoints.json`, because `endpoints.json` catalogs API
operations rather than client API.

Verified against the source of all three wrappers on 2026-07-29. Where this file
and the code disagree, **the code wins and this file is a bug**.

---

## 1. Construction and configuration

| | TypeScript (`@w6w/sdk`) | Python (`w6w`) |
|---|---|---|
| Class | `new W6WClient(options?)` | `Client(base_url=None, token=None, project=None, transport=None)` |
| Base URL | `options.baseUrl` → `W6W_BASE_URL` | `base_url` → `W6W_BASE_URL` |
| Credential | `options.token` → `W6W_TOKEN` | `token` → `W6W_TOKEN` |
| Default project | `options.project` (no env var) | `project` (no env var) |
| Transport seam | `options.fetch` (`FetchLike`) | `transport` (`Transport`, a `urllib` opener) |
| Resolved config | `client.config: ResolvedConfig` | `client.config: ResolvedConfig` (frozen) |

**The class name differs on purpose, and it is the only name that does.** A
TypeScript caller imports the symbol flat — `import { W6WClient } from
"@w6w/sdk"` — into a namespace shared with everything else they import, so the
prefix is what disambiguates it. A Python caller reaches it through the package
(`from w6w import Client`, or `w6w.Client`), which already carries the brand;
`w6w.W6WClient` stutters. Every *other* published name is the same word in both,
transliterated only for case convention (`getByKey` / `get_by_key`).

Behaviour that is the same in both, and pinned:

- **Resolution happens once, at construction.** Nothing downstream re-reads the
  environment. Exactly one module per wrapper touches it (`src/env.ts`,
  `w6w/_env.py`).
- **Explicit argument beats environment, always.** An explicitly passed empty
  string is an *explicit value* and does not fall through — it raises the same
  configuration error. An environment variable that is **set but empty or
  whitespace-only is ABSENT** and does fall through. That asymmetry is the
  difference between a value a caller chose and a value a shell produced.
- **A missing base URL raises at construction; a missing token raises on the
  first request.** A tokenless client is constructible on purpose, so a CLI's
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

| Symbol (TS) | Symbol (Python) | What it is |
|---|---|---|
| `client.request<T>(options)` → `HttpResponse<T>` | `client.request(method, path, query=None, body=None)` → `HttpResponse` | One authenticated request. Public so a host can reach a route this version does not model. Returns **status and body**, because `202` is success on this API. |
| `` path`/documents/${key}` `` | `path("/documents/{key}", key=key)` | Percent-encodes every interpolated value **at the point of interpolation**. |
| `joinBaseUrl(origin)` | `join_base_url(origin)` | The one and only base-URL code path — the same function `resolveConfig` uses, so the helper and the client can never answer differently. |
| `BASE_PATH` | `BASE_PATH` | `""`. Mirrors the contract's `basePath`; the answer to "what does this client prepend?" is *nothing*. |
| `VERSION` | `__version__` | This package's published version, equal to the shared `VERSION` file. |
| `HttpMethod`, `QueryParams`, `RequestOptions`, `HttpResponse` | `HttpResponse` (a `NamedTuple`), `Transport` | The request/response types of the seam. |

`path` is a **tagged template** in TypeScript and a **format function** in
Python for the same reason: encoding must be impossible to forget one call site
at a time. Use it for every path containing a caller-supplied value. It is
*encoding, never validation* — a key the server accepts is sent as-is (encoded)
and never rejected, trimmed or canonicalised locally.

The one input it cannot fix is a dot-only path segment (`.`, `..`): `.` is
unreserved in RFC 3986, so no encoder touches it. **The two lanes genuinely
differ here and it is documented rather than papered over** — `fetch` (WHATWG
URL) removes dot segments before sending, `urllib` sends them literally. The
server closed the hole at the other end instead: `POST /documents` rejects a key
of exactly `.` or `..`, so no such key exists to address.

## 3. Errors

Two classes, in both languages, and the split is diagnostic:

| Class | Raised when | Fields |
|---|---|---|
| `ConfigError` | The client was never in a position to make a request — no base URL, no token, an unsendable token. No HTTP exchange happened. | message (naming the env var) |
| `ApiError` | The server answered, or could not be reached at all. | `status`, `code`, `message`, `raw` |

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
`kind`. It stays distinct from `"error"`: `"error"` means *your request was
rejected*, `bad_response` means *this server is broken*.

Classify by `status` plus a **prefix** of `code` (`unknown_*` 404, `invalid_*`
400, `*_exists` 409), never by an exhaustive list — the server mints codes
freely. **`424` is an app/upstream execute-phase failure** and is a 4xx on
purpose (Cloudflare replaces an origin 5xx with a CORS-less HTML page); it is
never normalised into a transport error or a 5xx. A `401` has **no side effect**:
no retry, no refresh, no callback.

## 4. The operations

Seventeen, identical in both SDKs. The wire detail lives in
[`endpoints.md`](./endpoints.md); what follows is the *client* behaviour.

### Identity

| TS | Python | Returns |
|---|---|---|
| `client.me()` | `client.me()` | `Me` |

`GET /auth/me` — the server's real identity route, called directly. The body is
**flat**; nothing is unwrapped. The one thing the client adds is
`versions.wrapper`, its own version, as a **default the server overrides**
(`{wrapper: VERSION, ...server}`, never the other order). The map is otherwise
carried through unaltered — rendering a placeholder as `dev` is the CLI's
display rule, not a data rule. A `2xx` body that is not an object (a list
included) raises `bad_response`.

### Discovery

| TS | Python | Returns |
|---|---|---|
| `client.connections.list()` | `client.connections.list()` | `ConnectionSummary[]` / `List[ConnectionSummary]` |
| `client.workflows.list(opts?)` | `client.workflows.list(project=None)` | `WorkflowSummary[]` / `List[WorkflowSummary]` |

Both exist so a caller can *discover* a `conn_…` / `wf_…` id to hand to `run`
(D4). Both unwrap their envelope key and return the payload array. Connections
are read-only in this version: every write is an interactive, secret-handling
studio flow and is out of scope. `connections.list` sends **no** `?project=`
even when the client has a default; `workflows.list` does.

Neither is paginated today and neither pretends otherwise — no cursor argument,
no client-side paging loop.

### Execution

| TS | Python | Returns |
|---|---|---|
| `client.run(input)` | `client.run(urn, action=None, payload=None)` | `RunEnvelope` |
| `client.workflows.run(id, opts?)` | `client.workflows.run(id, wait=False, variables=None, trigger=None, input=None)` | `WorkflowRunResult` |

`run` dispatches on a URN over four runnable arms (`conn_`, `wf_`, `fn_`, `ep_`)
and returns the `kind`-tagged envelope **exactly as it arrived**. `action` is
omitted from the body when absent; `payload` defaults to `{}` rather than being
omitted. A body with no string `kind` is `bad_response`.

`workflows.run` is the typed path and the only one that can wait. `wait` is sent
as `?wait=true` **only when true** — never `?wait=false`, which the server reads
as no-wait anyway. `variables`, `trigger` and `input` are body fields; `trigger` is an
**open string**, passed through unvalidated, so a sixth server-side value needs
no wrapper release. `variables` and `input` are not the same slot: `variables`
seeds the run's variable scope (`vars.*`); `input` is delivered to the entry
trigger node's own recorded output (`steps.<triggerId>.output.<key>`) — the
shape a trigger's declared fields actually arrive in. It returns the wire body
plus two derived signals:
`terminal` (from the run's own status) and `httpStatus` (`200` finished, `202`
still going) — the body alone cannot tell a `?wait=` timeout from a run that was
never waited on.

Three rules both operations obey:

- **`202` is success.** Never raised, in either.
- **A failed run is data** — a `200` with `status: "failed"` and an `error`.
  Returned, never raised. Turning it into an exit code is the CLI's job.
- **No client-side polling, ever.** There is no timer, sleep or retry anywhere
  in either package. The server's `?wait=true` is the mechanism.

### Documents — project-scoped

| TS | Python | Returns |
|---|---|---|
| `client.documents.list(opts?)` | `client.documents.list(project=None)` | `Doc[]` |
| `client.documents.get(id, opts?)` | `client.documents.get(id, project=None)` | `Doc` |
| `client.documents.getByKey(key, opts?)` | `client.documents.get_by_key(key, project=None)` | `Doc` |
| `client.documents.create(input, opts?)` | `client.documents.create(key, content, format=None, description=None, project=None)` | `Doc` |
| `client.documents.update(id, patch, opts?)` | `client.documents.update(id, content=UNSET, format=UNSET, description=UNSET, project=None)` | `Doc` |
| `client.documents.delete(id, opts?)` | `client.documents.delete(id, project=None)` | `void` / `None` |

### Vars — **not** project-scoped

| TS | Python | Returns |
|---|---|---|
| `client.vars.list()` | `client.vars.list()` | `Var[]` |
| `client.vars.get(id)` | `client.vars.get(id)` | `Var` |
| `client.vars.getByName(name)` | `client.vars.get_by_name(name)` | `Var` |
| `client.vars.create(input)` | `client.vars.create(name, type, value, description=None)` | `Var` |
| `client.vars.update(id, patch)` | `client.vars.update(id, type=UNSET, value=UNSET, description=UNSET)` | `Var` |
| `client.vars.delete(id)` | `client.vars.delete(id)` | `void` / `None` |

Shared rules for both asset namespaces:

- **Create by `key`/`name`; read by id *or* by the dedicated `by-key`/`by-name`
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

## 5. Wire types and the run types

Both packages export the transcribed wire shapes: `Doc`, `DocFormat`, `Var`,
`VarType`, `Me`, `ConnectionSummary`, `ConnectionState`, `WorkflowSummary`,
`WorkflowStatus`, `RunStatus`, `StepError`, `RunResult`, `WorkflowRunResult`,
`RunEnvelope`. Field names are the **wire's, verbatim** — `createdAt`, not
`created_at`, in Python too. Timestamps stay ISO-8601 **strings** in both; date
parsing is a policy three languages would have to adopt together.

`RunEnvelope` is the one type that is deliberately **not** transcribed into a
struct:

| Arm | `kind` | Field | HTTP |
|---|---|---|---|
| action | `"action"` | `value` | `200` |
| function | `"function"` | `output` | `200` |
| workflow | `"workflow"` | `runId` + `status` | `202` |
| *anything else* | any string | whatever the server sent | any |

`value` and `output` are **different names on purpose** and are never normalised
into one field — the discrimination is the point. **An unknown `kind` is
returned verbatim, never raised**: the server may grow a fourth arm before the
wrappers do, on the one operation whose entire job is dispatch, and raising would
turn an additive server change into a hard breakage for every installed client.

Discriminate it with the exported predicates:

| TS | Python |
|---|---|
| `isActionRun(env)` | `is_action_run(env)` |
| `isFunctionRun(env)` | `is_function_run(env)` |
| `isWorkflowRun(env)` | `is_workflow_run(env)` |
| `isTerminalRunStatus(status)` | `is_terminal_run_status(status)` |

In TypeScript they are **type guards**, and they are not optional ceremony: the
union is open, so a bare `env.kind === "workflow"` check does *not* narrow, and
`env.status` would come out `unknown`. In Python they are plain predicates over
the returned dict.

## 6. Where the two SDKs deliberately differ

Same operations, same behaviour, different idiom. Each of these is a decision,
not drift:

| | TypeScript | Python | Why |
|---|---|---|---|
| Optional inputs | An options object (`create(input, opts?)`) | Keyword arguments | Each language's idiom; the bytes on the wire are identical. |
| Omit vs null in a patch | `undefined` members vanish at `JSON.stringify` | `UNSET` sentinel (`Unset`, `PatchableStr`, `patch_body`) | Python has one absent value and this API needs two: `{}` means *leave it alone*, `{"value": null}` means *set it to null*, and the server tests `!== undefined`. Defaulting to `None` would turn every "don't touch this" into "null this", silently. |
| Unknown response fields | Structural interfaces — an unmodelled field is still present at runtime | Frozen dataclasses — known fields kept, the rest dropped | Both *tolerate* the field; only the TS lane can also *carry* it. A Python caller who needs one reaches it through `client.request`, which hands back the parsed body untouched. |
| List results | `WorkflowSummary[]`, widenable to carry a cursor later | A plain `list` | A JS array is an object and can grow a property; a Python list cannot. So neither invents a container now — the day the server paginates, all three grow the same one together. |
| Namespace host types | `DocumentsHost` / `VarsHost` interfaces | `DocumentsHost` / `WorkflowsHost` protocols, `VarsRequest` / `ConnectionsRequest` / `MeRequest` / `RunRequest` callables | Same layering: a namespace sees the transport, and sees the configuration **only** if it is project-scoped. |
| Transport | `fetch` (injectable via `options.fetch`) | `urllib.request` (injectable via `transport`) | Zero runtime dependencies in both. Note the `urllib` trap: `urlopen` **raises** `HTTPError` for any non-2xx, and an `HTTPError` *is* a response — it is routed to the envelope mapper, never to `network_error`. |

## 7. The CLI (`@w6w/cli`)

The CLI is a presentation layer over `@w6w/sdk` and adds no operations: every
command is one SDK call. `w6w <group> <command>` mirrors `client.<group>.<method>`
(`naming.cli` in the contract), `w6w me` and `w6w run` sit at the root, and
`w6w info` is an accepted alias of `w6w me`.

What it adds beyond the SDK, and nothing else:

- **`--help` at three levels**, generated from `endpoints.json`, resolving with
  **no token and no network**, exiting `0`. Bare `w6w` prints root help and exits
  `0`; an unknown or incomplete command prints help to **stderr** and exits `1`.
- **Output modes** — a human table by default, `--json` for the raw payload,
  `--no-color` for a dumb terminal.
- **The exit-code contract**, which is the only part of an answer a CI job
  reads: `0` success (including a queued or running run), `1` usage, `2` API
  error, `3` a `--wait` run that came back `failed`. Code `3` exists precisely so
  a failed workflow and an unreachable API — which demand opposite responses —
  cannot be confused by a script.
- **Flag-level precedence:** `--base-url` / `--token` beat the environment.

See [`cli.md`](./cli.md) for the help text itself.

## 8. What is not here

Out of scope for this version, in every wrapper, and named so nobody adds them
in one language: apps, functions, endpoints, projects, vault, tokens, schedules,
triggers, subscriptions, tenants, `runs.get`, and **all write operations on
connections and workflows**. They exist on the API. They are not in the wrappers
until they are in `endpoints.json` — see
[`parity.md` §Adding an operation](./parity.md#adding-an-operation).

Also deliberately absent from every wrapper, because they are browser couplings
rather than library behaviour: ambient credential storage, a mutable module-level
token, an auth-error callback, a redirect on `401`, retries, token refresh, and
client-side run polling.
