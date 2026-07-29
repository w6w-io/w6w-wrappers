# Wrapper implementation spec

One spec, three languages. [`endpoints.json`](../endpoints.json) says *which*
operations exist and [`docs/endpoints.md`](./endpoints.md) says *what the API
returns*. This file pins everything else: types, error model, environment
handling, toolchains, tests, and the conformance runner.

It exists because three developers implement from it independently, in three
languages, and anything left ambiguous here becomes three different truths that
only surface at the conformance gate. **Where this file says "pinned", it is not a
suggestion and not a starting point for discussion — implement it verbatim.**

Every claim below that rests on a server or studio behaviour cites its file and
enclosing route or symbol, so a reader can check it rather than trust it. Those
paths are inside **private** repos and are marked.

> **This is why `w6w-io/w6w-wrappers` is private.** There are 20 such citations
> in this file and 14 in [endpoints.md](./endpoints.md), and together they
> describe the closed host's layout, route handlers and symbol names — which
> STRATEGY §5.1 keeps closed. **Stripping every one of them is a precondition of
> making this repo public**, not a cleanup task to do afterwards, and the strip
> has to cover the git history as well as the working tree. Nothing about the
> layout depends on visibility: the contract sits beside the lanes either way,
> which is what removed the need for a public mirror
> ([parity.md](./parity.md#where-the-contract-comes-from-in-ci)). Visibility is
> now a strategy decision, decoupled from the mechanism.

---

## 1. Toolchains

Pinned by what this environment can actually run, measured on 2026-07-27 — not by
preference.

### `node` and `cli` (TypeScript)

- **Authored as runtime-neutral TypeScript** in `src/*.ts`, using **Web-standard
  globals only**: `fetch`, `Headers`, `Request`, `Response`, `URL`,
  `AbortController`, `TextEncoder`. No `node:` builtins in the client core, no
  `process`, no Deno-specific API outside the single env module (§2).
- **Developed and tested with Deno**, inside the compose `api` service. The gates
  are `deno check`, `deno test -A` and `deno coverage`:

  ```bash
  docker compose -f .devcontainer/docker-compose.yml exec -T api \
    sh -c 'cd /app/packages/wrappers/node && deno task check && deno task test'
  ```

  Verified working in that container: `deno` 2.8.2, `deno test`, `deno check
  <dir>`, `deno coverage`, and `jsr:@std/assert@^1.0.0`. Assertions come from
  `@std/assert` — the only test idiom in the house.
- **The npm `dist/` build is `tsc`, and runs in CI only.** `tsconfig.json` sets
  **`rewriteRelativeImportExtensions: true`** so the Deno-style `./x.ts` import
  specifiers in `src/` compile to `./x.js` in `dist/`. One source tree, two
  registries: JSR publishes the TypeScript source verbatim (so every public API
  needs an explicit return type to satisfy JSR's no-slow-types rule), npm
  publishes compiled ESM + `.d.ts` from `dist/` (D7).
- **Formatting/lint** follow the house Deno settings: `lineWidth: 100`,
  `semiColons: true`, `singleQuote: false`, `lint.rules.tags: ["recommended"]`.

**Why Deno-gated and not Node-gated:** this devcontainer host has **no `deno`
binary and no local Node test runner convention** — Deno lives only in the compose
`api` service with the repo root bind-mounted at `/app`, and there is no
vitest/jest config anywhere in the workspace. Authoring Deno-first makes the test
runner *and* the coverage tool (§9) free; authoring Node-first would make both new
choices in a repo with no precedent.

### `python`

- **Stdlib-only. Zero runtime dependencies.**
- Transport is **`urllib.request`** (`Request` + `urlopen`, with `HTTPError` and
  `URLError` handled explicitly — see §3). No `requests`, no `httpx`, no `aiohttp`.
- Tests run under **`python3 -m unittest`** (`python3 -m unittest discover -s
  tests`). No pytest.
- `requires-python = ">=3.9"` in `pyproject.toml`. Type hints use
  `typing.Optional` / `typing.Dict` / `typing.List` form so 3.9 accepts them
  without `from __future__ import annotations` surprises.
- Coverage is enforced in **CI** (§9), not locally.

**Why stdlib-only:** there is **no `pip`** on this host or in the `w6w`
devcontainer — `python3 -m pip` reports "No module named pip", and `-m ensurepip`
likewise — and there is **no `.py` file anywhere in the workspace** to inherit a
convention from. Host `python3` is 3.14.4. A `requests`/`httpx`/`pytest` choice
would make the Python package **untestable in the environment that has to develop
it**. Zero dependencies is also the right answer for a published client: it can
never conflict with a user's pins.

---

## 2. Configuration and environment

### `W6W_BASE_URL` — an origin, not a base path

`W6W_BASE_URL` holds an **origin**: `https://api.example.com`. As of contract
0.2.0 the wrapper appends **nothing** — `basePath` in `endpoints.json` is `""`,
because the server serves its routes at the root of its own host.

The join rule, pinned — it mirrors `apiBase(url)`:

1. Strip **all** trailing slashes: `url.replace(/\/+$/, "")`.
2. Reject anything that is not an absolute `http(s)` URL with a host.
3. Append nothing. Any **path** in the configured value is preserved verbatim.

```
https://api.example.com        → https://api.example.com
https://api.example.com/       → https://api.example.com
https://api.example.com///     → https://api.example.com
https://api.example.com/gw/v2  → https://api.example.com/gw/v2
https://api.example.com/api    → https://api.example.com/api   (preserved, not stripped)
```

Step 3 is deliberate in both directions. Nothing is appended, so nothing can be
doubled; and a configured path is **never** removed, because a stale `/api` left
over from 0.1.x is indistinguishable from a genuine gateway prefix. Silently
stripping it would break the deployments that mean it, so it is left to 404 —
the announced break.

Operation paths from `endpoints.json` (`/documents`, `/vars/{id}`, …) are appended
to that resolved base verbatim. Their **parameters are not** — every
caller-supplied value substituted into a path segment or a query string is
percent-encoded, by the mechanism pinned immediately below.

There is **no default base URL**. A client constructed with neither an explicit
base URL nor `W6W_BASE_URL` raises a configuration error at construction time,
naming the env var. (The studio's `?? "/api"` relative default is a browser same-origin assumption — it
covers the Vite dev proxy and `SERVE_STUDIO`, where the SPA owns `/` and the API
keeps a prefix — and has no meaning in a library.)

**A blank value is not a base URL.** An environment variable that is present but
**empty or whitespace-only is treated as absent** — `W6W_BASE_URL=`,
`W6W_BASE_URL="   "` and an unset `W6W_BASE_URL` are the same thing, and all
three end in that same configuration error. The rule is stated in full under
Precedence below and pinned mechanically in `readEnv`; it is repeated here
because *this* is the section it protects. Run the join rule above on `""` and
you get an **empty base** — every request then goes out against a relative URL,
which is exactly what the paragraph above forbids. It would not fail here, at
construction, with a message naming the variable; it would fail later, inside
some operation, with a message about a request.

### MECHANISM PIN — encoding caller-supplied values into the URL

This is not a style choice and it is not defensive ceremony. Skip it and the
wrapper sends a well-formed request **to a different route than the caller asked
for**, with no error anywhere to show for it.

**The rule.** Every value that originates with the caller and is interpolated into
a URL — path segment or query-string value — is percent-encoded **at the point of
interpolation**. A raw caller value is never string-concatenated into a URL.

| Language | Path segment | Query string |
|---|---|---|
| node / cli | `encodeURIComponent(value)` | `new URLSearchParams({…}).toString()`, or `encodeURIComponent` on each name and value |
| python | `urllib.parse.quote(value, safe="")` | `urllib.parse.urlencode({…})`, or `quote(value, safe="")` per value |

Two query parameters exist in this surface: `?project=` (every `documents.*`
operation and `workflows.list` — §7) and `?wait=` (`workflows.run` — §4). A
project id is server-minted and `wait` is a wrapper-generated boolean, so both are
safe by construction — and both are encoded anyway, for the reason given under
"every interpolation" below.

**`safe=""` is load-bearing.** `urllib.parse.quote` defaults to `safe="/"`: it
deliberately leaves `/` untouched, because its usual job is encoding a whole path
rather than one segment. Measured on this host's `python3`:

```
quote("a/b")            → 'a/b'     ← still two path segments: WRONG
quote("a/b", safe="")   → 'a%2Fb'   ← one segment: correct
```

A Python wrapper calling `quote(key)` without `safe=""` therefore *looks* encoded
and still has the `a/b` bug. That near-miss is precisely how three independent
implementations end up disagreeing, so the argument is pinned here rather than
left to each author's judgement.

#### The worked reproduction — `documents.getByKey`

`documents.getByKey` is `GET /documents/by-key/{key}`, and `key` is chosen by the
**user**. The server's `validateKey` trims, rejects empty, and caps
at 128 characters — **and restricts nothing else**. So `"."`, `".."`, `"../.."`,
`"a/b"`, `"a?x=1"`, `"a#f"` and `"a b"` are all keys a user can legitimately
create today.

Naive concatenation — `` `${base}/documents/by-key/${key}` `` — produces:

| key | naive URL | what it actually resolves to |
|---|---|---|
| `"."` | `…/documents/by-key/.` | `…/documents/by-key/` |
| `".."` | `…/documents/by-key/..` | `…/documents/` — **the LIST route** |
| `"../.."` | `…/documents/by-key/../..` | `…/` — the API root |
| `"a/b"` | `…/documents/by-key/a/b` | a two-segment path — a different route entirely |
| `"a?x=1"` | `…/documents/by-key/a?x=1` | path `…/by-key/a` **+ query `x=1`** — truncated, and a parameter smuggled in |
| `"a#f"` | `…/documents/by-key/a#f` | path `…/by-key/a` — truncated at the fragment |
| `"a b"` | `…/documents/by-key/a b` | a malformed URL |

The second row is the one to hold on to: a caller asking for the single document
whose key is `".."` receives **the entire collection** — a `200` with every
document in the project — instead of the `404 unknown_document` it asked for.
Nothing throws. The wrapper cannot tell, and neither can the caller.

#### What encoding fixes — and the one case it does not

Encoding closes every row above **except** the dot-only keys, and that exception
is better known than rediscovered:

```
encodeURIComponent("a/b")    → "a%2Fb"      ✓
encodeURIComponent("a?x=1")  → "a%3Fx%3D1"  ✓
encodeURIComponent("..")     → ".."         ✗ unchanged
quote("..", safe="")         → ".."         ✗ unchanged
```

`.` is an *unreserved* character in RFC 3986, so no percent-encoder touches it —
and hand-encoding it does not help either, because the URL Standard treats
`%2E%2E`, `%2e%2e` and `.%2e` as double-dot segments as well. A literal `..` path
segment is simply **not representable** in a WHATWG-parsed URL. Measured under
`deno 2.8.2`: `new URL("documents/by-key/%2E%2E", base)` collapses to
`…/documents/` exactly as the raw form does.

This is the one place the two toolchains genuinely behave differently, so it is
pinned rather than left to be found three times:

- **node / cli** — `fetch` parses the URL with the WHATWG parser, which removes
  dot segments. The keys `"."` and `".."` cannot be addressed through this route.
- **python** — `urllib.request` does **not** normalise the path. Measured:
  `Request(".../by-key/..").selector` is `'/documents/by-key/..'`, verbatim.
  The key reaches the server, which (or an intervening proxy, which) may still
  normalise it.

**Pinned behaviour in all three languages: encode it and send it.** Do not
special-case a dot key, do not raise a client-side error on one, do not silently
route it somewhere else. Whether `"."` and `".."` are addressable by key at all is
a property of the **route shape** `by-key/{key}` and belongs to the node that
builds that route (T4.4.1, fenced by BLK-1) — not to the wrappers. A wrapper has
no way to know what the server will decide the key means, and guessing is the
failure mode below.

#### This rule is encoding — never validation

A wrapper **must not** reject, pre-normalise, canonicalise, strip or otherwise
rewrite a key the server accepts. `README.md` "What a wrapper is" (lines 47-56)
governs: a wrapper owns transport, auth and error mapping, and is **not a place
for business logic**. A character policy for document keys is business logic, and
it lives in exactly one place — `validateKey`, in the server.

The concrete cost of getting this backwards: a wrapper that refuses `"../.."`
locally makes a document that is **legitimately creatable through the same API**
permanently unreadable through that wrapper. The user creates it (the server says
yes) and can never read it back (the wrapper says no) — a bug with no server-side
trace, reproducible only through that one client. The wrapper would have invented
a validation rule the server does not have, and the two would drift further apart
on the server's next release. Encode the key, send it, and let the server decide
what it means.

#### It applies to *every* interpolation, not only the unsafe one

Encode every caller-supplied path segment on **every** operation — explicitly
including `vars.getByName` (`GET /vars/by-name/{name}`), whose name the server
validates against `NAME_RE = /^[a-z_][a-z0-9_]*$/` and which is therefore URL-safe by
construction **today**. Documents are the unsafe surface; vars are not. Encode
both.

Encoding a value that the validator admits costs one function call and changes
nothing. *Not* encoding it makes the wrapper's correctness depend on a regex in a
different repo that no wrapper test covers: the day that validator relaxes — to
admit a `.`, a `-`, or a namespace separator — a wrapper that encoded "only where
it currently had to" becomes wrong silently, in the field, in a release it was not
part of. "Encode at every interpolation" is a rule a reviewer checks by looking at
the call site. "Encode wherever the server currently permits unsafe characters" is
a rule that requires re-auditing another repo on every release, and nobody will.

The same reasoning covers the `{id}` parameters (`/documents/{id}`, `/vars/{id}`):
server-minted `doc_…` / `var_…` ids are safe by construction, and they are encoded
anyway.

### `W6W_TOKEN` — the bearer credential

Sent as `Authorization: Bearer <token>` on **every** request; there are no
anonymous operations in this surface. A client constructed without a token may be
built (so `--help` and `--version` work offline) but raises the same configuration
error on the first request.

### Precedence

**Explicit constructor arguments override the environment, always.** For the CLI
there is a third, highest tier: an explicit flag.

```
CLI flag (--base-url / --token)  >  constructor argument  >  environment variable
```

An explicitly passed empty string is an explicit value, not "unset" — do not fall
through to the environment on it. Fall through only when the argument is
absent/`undefined`/`None`. (It still does not *produce* a usable base URL: an
explicit `""` reaches the emptiness check and raises the same configuration
error. What it does not do is quietly consult the environment behind the
caller's back.)

**An environment variable behaves the opposite way: present-but-empty is
ABSENT.** A blank env var — `""` or whitespace-only — falls through the
precedence chain exactly as if it were unset, to the next source and ultimately
to the configuration error. This holds for every variable in this surface
(`W6W_BASE_URL`, `W6W_TOKEN`) and in every language.

The asymmetry is deliberate, and it is the difference between a value a *caller*
chose and a value a *shell* produced. `SomeClient({baseUrl: ""})` is a
programmer writing an empty string on purpose; `export W6W_BASE_URL=`,
`ENV W6W_BASE_URL=` with no build arg, and a CI variable whose template did not
interpolate all produce a set-but-empty variable that **nobody chose**. That is
the common case, not the exotic one — and it is indistinguishable from unset in
every log line, so a wrapper that treats it as a value diverges from the
operator's mental model at the worst possible moment. This project has already
paid for the same bug class once: `ENV W6W_COMPOSITION=` yields `""` rather than
an unset variable, which is why the composition fallback is pinned as `||` and
not `??`.

Trimming applies to the **emptiness test**, not to the stored value: a variable
that survives the test is used verbatim. Normalising the shape of a base URL is
the join rule's job, not the env reader's.

### MECHANISM PIN — instance state, never globals

This is not a style choice.

- **Credentials and base URL are instance state on the client object.** Two
  clients constructed in one process must be able to hold different credentials
  and point at different servers, with no interference. The studio's module-global
  mutable `token` + `setApiToken()` is a single-session browser
  assumption and **must not be carried over** (§8).
- **Exactly one module per wrapper reads the environment.** Nothing else in the
  codebase may touch `Deno.env` / `process.env` / `os.environ`.
  - node/cli: `src/config.ts`
  - python: `w6w/_config.py`

  That module resolves the effective base URL and token once, at client
  construction, and hands back a plain config value. Every test of env-var
  behaviour therefore has exactly one seam to exercise (§9), and no operation can
  silently acquire a hidden dependency on ambient state.
- Reading env in the TypeScript wrappers uses a **capability probe**, not a
  runtime assumption, so the same file works under Deno, Node and Bun:

  ```ts
  // src/config.ts — the ONLY place any of this appears.
  function readEnv(name: string): string | undefined {
    const g = globalThis as Record<string, any>;
    let value: string | undefined;
    if (g.Deno?.env?.get) value = g.Deno.env.get(name);
    else if (g.process?.env) value = g.process.env[name];
    else return undefined;
    // Deliberately a truthiness/trim check, and deliberately NOT a nullish
    // coalesce (`??`): nullish-coalescing does not convert "", so an empty env
    // var would survive as a value, short-circuit precedence, and leave the
    // client on an empty base — the relative URL §2 forbids. Blank is absent
    // (see Precedence).
    // Do not "tidy" this back to `??`.
    if (value === undefined || value.trim().length === 0) return undefined;
    return value;   // verbatim — trimming the emptiness test, not the value
  }
  ```

  The Python equivalent is the same shape, and `os.environ.get(name)` needs it
  for the same reason — it too returns `""` for a set-but-empty variable:

  ```python
  # w6w/_config.py — the ONLY place any of this appears.
  def read_env(name: str) -> str | None:
      # os.environ.get returns "" for a set-but-empty variable, never None.
      # So the guard is a truthiness/strip check, not a bare `is None` test —
      # `is None` is the Python spelling of the same nullish-coalesce mistake.
      value = os.environ.get(name)
      if value is None or not value.strip():
          return None
      return value
  ```

---

## 3. Error model

One error type per language, same four fields, same name:

| Language | Type | Fields |
|---|---|---|
| node / cli | `class ApiError extends Error` | `status: number`, `code: string`, `message: string`, `raw: unknown \| null` |
| python | `class ApiError(Exception)` | `status: int`, `code: str`, `message: str`, `raw: Any \| None` |

`raw` is the **parsed response body** when there was one, otherwise null/`None`.
It is kept because error bodies carry fields that the message alone drops — an
invoke error rides alongside `logs` and `apiCalls`.

### The three failure modes — implement these verbatim, in all three languages

Transcribed from `req<T>()`,
which has exactly these three and no others.

**(a) Transport failure** — the request never produced an HTTP response (server
down, DNS failure, TLS failure, connection refused, timeout).

- `status` = **`0`**
- `code` = **`"network_error"`**
- `message` names the **method and the full URL**, plus the underlying error's own
  message. A bare `TypeError: Failed to fetch` / `URLError` is useless on its own.

```
Could not reach the w6w server (GET https://api.example.com/api/vars).
It may be down or unreachable. (Connection refused)
```

In Python this is `urllib.error.URLError` (and socket errors) — **but not**
`HTTPError`, which *is* a response and falls through to (b)/(c).

**(b) Non-JSON body on a non-OK status** — the body did not parse as JSON.

- `status` = the HTTP status
- `code` = **`"bad_response"`**
- `message` includes a **≤ 200-character snippet** of the body.

This is what a proxy or Cloudflare HTML error page looks like. Reporting it as an
opaque JSON `SyntaxError` loses the only diagnostic information present.

> A non-JSON body on an **OK** status is not an error here: an empty `200` body
> parses to null/`None` and the operation returns nothing. Only `!ok` triggers (b).

**(c) Envelope error** — a non-OK status with a JSON body.

- `status` = the HTTP status
- `code` = `body.error.code` if present, else **`"error"`**
- `message` = `body.error.message` if present, else the HTTP **status text**
- `raw` = **the parsed body**

### Classification is by status + code prefix, never an exhaustive code list

The server mints codes freely; an enumerated list in three wrappers would be stale
within a release. Wrappers must not switch on a closed set of code strings. The
shape callers can rely on:

| Pattern | Status | Meaning |
|---|---|---|
| `unknown_*` (`unknown_document`, `unknown_var`, `unknown_workflow`, …) | `404` | The addressed thing does not exist in the caller's scope |
| `invalid_*` (`invalid_name`, `invalid_type`, `invalid_value`, `invalid_body`) | `400` | The request was malformed or failed validation |
| `*_exists` / `*_conflict` (`document_exists`, `var_exists`, `version_conflict`) | `409` | Uniqueness violation |
| `forbidden`, `app_not_entitled` | `403` | Authenticated but not permitted |
| `unauthorized` | `401` | Credential missing, expired or rejected |
| *(any)* | `424` | **App/upstream execute-phase failure** — see below |

If a wrapper offers convenience predicates, derive them from **status** (and the
prefix as a fallback), e.g. `err.status == 404`, not from a hard-coded code list.

**The `424` is load-bearing.** An execute-phase failure is the target action's own
hook throwing — almost always the upstream vendor returning an error, not a w6w
fault — and the server reports it as `424 Failed Dependency`, a 4xx, rather than a
5xx.
The reason is operational: Cloudflare replaces an origin 5xx with its own
CORS-less HTML error page, so a 502 would reach the caller as an opaque failure
with the real message stripped. A `424` passes through untouched with its JSON
intact. **Do not "normalise" 424 into a 5xx or a generic server error** in any
wrapper — you would be undoing the whole point.

### `401` has no side effect

The studio fires an `onAuthError` callback that redirects to `/login`. A library has nowhere to
redirect to. Wrappers raise the `ApiError` and stop. No retry-on-401, no token
refresh, no callback hook (§8).

---

## 4. Outcomes that are not errors

Three rules. They are the most common way a thin client gets this API wrong.

1. **`202` is success.** `workflows.run` returns `202` when the run is queued (the
   default) and again when `?wait=true` times out with the run still going. `run`'s
   workflow arm returns `202` for the same reason (D3). Success statuses are
   declared per-operation in `endpoints.json` as `successStatuses`; a wrapper
   treats `200` and `202` **identically** and never raises on either. The
   distinction the caller needs is `status` in the body, not the HTTP code.

2. **A failed run is data.** A run that failed comes back **`200` with
   `status: "failed"`** and an `error` field in the body. Wrappers **must not** map it
   to a raised exception. The caller inspects `status`.

   > The **CLI** is the one place this becomes an exit code: `w6w workflows run
   > <id> --wait` on a `status: "failed"` exits **3**, per `cli.exitCodes` in
   > `endpoints.json`. That is a CLI presentation decision, not an SDK error.

3. **No wrapper implements client-side run polling.** The server already offers
   `?wait=true`, which polls server-side up to `RUN_WAIT_TIMEOUT_SEC`. The
   studio's 600 × 500 ms client-side poll predates that and **must not be
   transcribed** — re-implementing a poll loop in three languages is three
   different timeout policies, three retry-storm bugs, and three things to keep in
   sync forever. Use `?wait=`, and otherwise hand back the `202` handle
   (`runId` + `status`) and let the caller decide.

---

## 5. Wire types

Read off the studio on `main` — the best
wire-shape reference in the workspace. **Transcribe these; do not import or vendor
the studio's file.** The field lists below are the pin: three languages, same
names, same optionality.

Naming per language: TypeScript keeps these names verbatim; Python uses the same
class names with `snake_case` fields **only where the wire field is already
snake_case** — it is not, so **Python keeps the wire spelling** (`lastTestOk`,
`displayName`, `createdAt`). A client that silently renames wire fields makes
every error message and every doc example wrong.

| Type | Fields |
|---|---|
| `Me` | `tenant: string`, `subject: string`, `account: string`, `role: string`, `versions?: Record<string, string>` |
| `ConnectionSummary` | `id: string`, `appId: string`, `authKey: string`, `owner: string`, `displayName: string`, `state: ConnectionState`, `profile: Record<string, unknown>`, `lastTestOk: boolean \| null`, `lastTestedAt: string \| null`, `createdAt: string`, `updatedAt: string` |
| `ConnectionState` | `"pending" \| "connected" \| "needs_refresh" \| "broken" \| "revoked"` |
| `WorkflowSummary` | `id: string`, `name: string`, `displayName: string`, `description: string`, `status: WorkflowStatus`, `tags: string[]`, `runCount: number`, `updatedAt: string` |
| `WorkflowStatus` | `"draft" \| "active"` |
| `RunStatus` | `"queued" \| "running" \| "succeeded" \| "failed" \| "canceled"` |
| `RunResult` | `runId: string`, `status: RunStatus`, `output?: unknown`, `error?: unknown`, `steps: Record<string, unknown>`, `stepErrors?: StepError[]` |
| `StepError` | `stepId: string`, `error: unknown` |
| `DocFormat` | `"text" \| "markdown" \| "yaml" \| "html" \| "json"` |
| `Doc` | `id: string`, `key: string`, `content: string`, `format: DocFormat`, `description: string`, `createdAt: string`, `updatedAt: string` |
| `VarType` | `"string" \| "number" \| "boolean" \| "json"` |
| `Var` | `id: string`, `name: string`, `type: VarType`, `value: unknown`, `description: string`, `createdAt: string`, `updatedAt: string` |
| `RunEnvelope` | `{kind: "action", value: unknown}` \| `{kind: "function", output: unknown}` \| `{kind: "workflow", runId: string, status: RunStatus}` \| `{kind: string} & Record<string, unknown>` — the union is **open**; see the unknown-`kind` rule below |

Rules that apply to all of them:

- **Timestamps are ISO-8601 strings on the wire, in every language.** `createdAt`,
  `updatedAt`, `lastTestedAt` are serialized from a `Date` server-side and arrive
  as strings. Wrappers keep them as strings — including Python, which does **not**
  parse them to `datetime`. Parsing is a per-field policy decision that would have
  to be identical in three languages and reversible for round-trips; if the SDKs
  ever adopt date parsing they adopt it together, as a versioned change.
- **`error`, `output`, `value` and `steps`' values are opaque pass-through.**
  Model them as `unknown` / `Any` / `Dict[str, Any]`. They come from user
  workflows and vendor apps; a wrapper that models their internals will be wrong
  for someone. `steps` is a **map keyed by step id**, not an array.
- **Unknown fields are tolerated, never rejected.** No wrapper may validate a
  response against a closed schema and fail on an extra key — the server adds
  fields additively and an older client must keep working. In TypeScript,
  interfaces are structural and this is free; in Python, build the dataclass from
  the known keys and **ignore the rest** (never `**body` into a constructor with
  fixed parameters — an added server field would raise `TypeError`).
- **`versions` is optional and open.** It may be absent entirely, and may carry
  keys this version has never heard of. It is a string→string map. It carries
  `composition` (a build string, or `"dev"` when the build arg is absent) and
  `wrapper` (filled client-side from the wrapper's own package version — the
  server cannot know it).
- **Precedence on collision is server-wins.** The wrapper's own version is a
  **default** that any key the server supplied **overrides**, `wrapper`
  included. Concretely `{ wrapper: VERSION, ...body.versions }` in TypeScript,
  `{"wrapper": VERSION, **(body.get("versions") or {})}` in Python; the shipped
  node lane is the reference. The other order
  (`{ ...body.versions, wrapper: VERSION }`) is **wrong** — it makes the
  wrapper's own value win. Both readings satisfied the older wording, they
  differ observably, and this is the one field a bug report is read off, so it
  is pinned here rather than decided three times.
- **A version is never *displayed* as a literal `0.0.0` or as an empty string —
  it is displayed as `"dev"`** (D5). Hand-maintained component versions are
  unreliable (`0.0.0`/`0.0.1` placeholders nobody bumps), and a banner that
  looks authoritative while reporting `0.0.0` forever is worse than one that
  honestly says `"dev"`. This is a **rendering** rule, applied where a version
  is presented to a person — the CLI's `w6w info` banner is the live case. It
  does **not** alter the data a caller receives: **a wrapper does not edit the
  map it returns**, and `versions` reaches the caller exactly as merged above.
- **The two rules above do not conflict**, because they act at different
  layers. *Server-wins* governs the **value carried** in the returned object,
  which stays a faithful transcription of the wire. *Never-display-`0.0.0`*
  governs **what a banner prints**. So a server that sends
  `versions.wrapper: "0.0.0"` is carried through unaltered in the data and
  rendered to the user as `dev` — one precedence rule, one display rule, and no
  lane inventing a third.
- **`RunEnvelope` must be switched on `kind`, and an unknown `kind` RETURNS THE
  RAW ENVELOPE to the caller.** One behaviour, no alternatives: the wrapper does
  **not** raise, and it must not throw a `KeyError` / `TypeError` from a
  destructure either. The default arm of the switch hands back the parsed body
  exactly as it arrived.

  The reason, written down so it is not later "tidied" into a raise: `run`
  dispatches on whatever a URN resolves to, and **the server may grow a new
  `kind` before the wrappers do** — a fourth arm is a purely additive server
  change. A wrapper that raises on an unknown `kind` converts that additive
  change into a hard client breakage for every user of the installed version, on
  the one operation whose entire job is dispatch; the caller is left with an
  exception and no access to a payload the wrapper had already parsed and held.
  Returning the envelope lets a caller handle a kind the wrapper has not learned
  yet, and lets them upgrade on their own schedule. This is the same principle
  as "unknown fields are tolerated, never rejected" two bullets up, applied at
  the variant level instead of the field level: an older client keeps working.

  In typed languages the return type is therefore the union **plus** an open
  fallback arm (`{kind: string} & Record<string, unknown>` / a plain `dict`) —
  not a closed union that makes the fourth kind unrepresentable. Narrowing on
  `kind` is what gives a caller the known arms; the fallback is what keeps the
  unknown one reachable.
- **`Ok`** is the server's `{ "ok": true }` for deletes. It is **not** a public
  type: the wrapper unwraps it to *nothing* (`void` / `None`). See §6.

---

## 6. Transcription map

One row per operation. **The wrapper unwraps the envelope key** and returns the
payload: the array for a list, the object for a single item, and *nothing* for
`{ok:true}`. A caller never sees `{documents: […]}`.

The three symbol columns are copied from each operation's `naming` entry in
`endpoints.json` and must match it character-for-character; `endpoints.json` is
the source, this table is the transcription.

| Operation | HTTP | Envelope key | Wrapper returns | TS | Python | CLI |
|---|---|---|---|---|---|---|
| `me` | `GET /auth/me` | *(none — flat body)* | `Me` | `client.me()` | `client.me()` | `w6w me` |
| `connections.list` | `GET /connections` | `{connections:[…]}` | `ConnectionSummary[]` | `client.connections.list()` | `client.connections.list()` | `w6w connections list` |
| `workflows.list` | `GET /workflows` | `{workflows:[…]}` | `WorkflowSummary[]` | `client.workflows.list(opts?)` | `client.workflows.list(project=None)` | `w6w workflows list [--project <id>]` |
| `workflows.run` | `POST /workflows/{id}/run` | *(none — flat body)* | `RunResult` | `client.workflows.run(id, opts?)` | `client.workflows.run(id, wait=False, variables=None, trigger=None)` | `w6w workflows run <id> [--wait]` |
| `documents.list` | `GET /documents` | `{documents:[…]}` | `Doc[]` | `client.documents.list(opts?)` | `client.documents.list(project=None)` | `w6w documents list [--project <id>]` |
| `documents.get` | `GET /documents/{id}` | `{document:…}` | `Doc` | `client.documents.get(id, opts?)` | `client.documents.get(id, project=None)` | `w6w documents get <id> [--project <id>]` |
| `documents.getByKey` | `GET /documents/by-key/{key}` | `{document:…}` | `Doc` | `client.documents.getByKey(key, opts?)` | `client.documents.get_by_key(key, project=None)` | `w6w documents get-by-key <key> [--project <id>]` |
| `documents.create` | `POST /documents` | `{document:…}` | `Doc` | `client.documents.create(input, opts?)` | `client.documents.create(key, content, format=None, description=None, project=None)` | `w6w documents create <key> --content <text> [--format <f>] [--description <d>] [--project <id>]` |
| `documents.update` | `PATCH /documents/{id}` | `{document:…}` | `Doc` | `client.documents.update(id, patch, opts?)` | `client.documents.update(id, content=None, format=None, description=None, project=None)` | `w6w documents update <id> [--content <text>] [--format <f>] [--description <d>] [--project <id>]` |
| `documents.delete` | `DELETE /documents/{id}` | `{ok:true}` | *(nothing)* | `client.documents.delete(id, opts?)` | `client.documents.delete(id, project=None)` | `w6w documents delete <id> [--project <id>]` |
| `vars.list` | `GET /vars` | `{vars:[…]}` | `Var[]` | `client.vars.list()` | `client.vars.list()` | `w6w vars list` |
| `vars.get` | `GET /vars/{id}` | `{var:…}` | `Var` | `client.vars.get(id)` | `client.vars.get(id)` | `w6w vars get <id>` |
| `vars.getByName` | `GET /vars/by-name/{name}` | `{var:…}` | `Var` | `client.vars.getByName(name)` | `client.vars.get_by_name(name)` | `w6w vars get-by-name <name>` |
| `vars.create` | `POST /vars` | `{var:…}` | `Var` | `client.vars.create(input)` | `client.vars.create(name, type, value, description=None)` | `w6w vars create <name> --type <t> --value <v> [--description <d>]` |
| `vars.update` | `PATCH /vars/{id}` | `{var:…}` | `Var` | `client.vars.update(id, patch)` | `client.vars.update(id, type=None, value=None, description=None)` | `w6w vars update <id> [--type <t>] [--value <v>] [--description <d>]` |
| `vars.delete` | `DELETE /vars/{id}` | `{ok:true}` | *(nothing)* | `client.vars.delete(id)` | `client.vars.delete(id)` | `w6w vars delete <id>` |
| `run` | `POST /run` | *(none — `kind`-tagged body)* | `RunEnvelope` | `client.run(input)` | `client.run(urn, action=None, payload=None)` | `w6w run <urn> [--action <a>] [--payload <json>]` |

Notes that the table cannot carry:

- **`var` is a reserved word in TypeScript.** Read the singular envelope as a
  property (`body["var"]`), never destructure it into a binding of that name.
- **Missing envelope key is a `bad_response`-class bug, not a silent null.** If a
  `200` body lacks the documented key, raise an `ApiError` with `code
  "bad_response"` rather than returning `undefined`/`None`. Three wrappers
  returning null here would hide a server regression.
- **Envelope keys, methods and paths come from `endpoints.json` at author time,
  not at runtime.** The wrapper does not parse `endpoints.json` to dispatch — only
  the conformance runner (§10) reads it.
- `documents.*` take an optional `project` that becomes `?project=`;
  `vars.*` take none (§7).
- `me` is additionally reachable as **`w6w info`** at the CLI (`cliAlias`, D8) —
  same operation, second spelling.

---

## 7. Asset addressing

**Pinned by D6, amended by D12: wrappers mirror the server's addressing exactly.**

| Intent | Addressed by |
|---|---|
| create | the human-chosen **`key`** (documents) / **`name`** (vars) |
| read one | the server-issued **`doc_…` / `var_…` id** — or the `key`/`name` via the dedicated `by-key` / `by-name` route, once it lands |
| update | the **id** |
| delete | the **id** |

`key` and `name` are **immutable** — neither appears in a PATCH body.

**No client-side list-then-filter, in any language.** A `documents.getByKey`
implemented as "list everything, scan for the key" is forbidden: it is O(n) over
someone's whole store, it races, and `README.md` "What a wrapper is" states that a
wrapper needing to compose two calls means the composition belongs in the API. The
key-addressed reads are therefore a **server route** over repository methods that
already exist — landing them is ~6 lines of
route each, fenced by BLK-1 and scheduled as T4.4.1.

Until that route lands, `documents.getByKey` / `vars.getByName` are implemented,
typed and unit-tested against a mocked transport (they are `status: "planned"`,
which is about the **server**, not the wrapper — §10), and they will return `404`
against a live server. **If the fence never clears, the wrappers ship id-addressed
only and the limitation is documented** — they do not grow a client-side
fallback.

### The project asymmetry, stated honestly

- Every `documents.*` operation accepts an **optional `project`**, which becomes
  `?project=`. Omitted, the server resolves the account's default project. An unknown project id is
  `400 unknown_project`.
- **No `vars.*` operation accepts `project`.** Vars are scoped by tenant/subject
  only; the `vars` table has **no `project` column** and no `vars` route reads the
  query parameter.

Do not add a `project` option to any `vars.*` signature to make the two surfaces
look symmetrical. Adding one later, when the column exists, is purely additive;
adding one now would be a parameter the server ignores — a lie that typechecks.
Wrappers document the asymmetry rather than papering over it.

### What a wrapper must NOT promise: multi-account reach

The server resolves the account via `ProjectsRepo.ensureDefaultAccount(tenant)`,
which **returns the tenant id as the account** and **ignores the principal's
`account` claim**. A credential therefore
reaches its tenant's default account, and nothing else.

No wrapper may document, name a parameter for, or otherwise imply that a token
can reach a non-default account's projects. There is no `account` argument on any
operation.

---

## 8. Do not carry over

the studio is the transcription source for
§3 and §5 — it is the most accurate wire reference in the workspace. It is also a
**browser** client, and six of its behaviours are browser couplings that must not
appear in a library. Listed with reasons so no reviewer has to re-derive them:

| # | In the studio client | Why it must not be carried over |
|---|---|---|
| 1 | `const BASE = import.meta.env.VITE_API_BASE ?? "/api"` *(`client.ts:48`)* | `import.meta.env` is a **Vite-only** global — it does not exist in Deno, Node or Python. And the `"/api"` fallback is a same-origin relative URL, meaningless outside a page. Base URL comes from constructor-or-env (§2). |
| 2 | `localStorage.getItem("w6w.token")` token bootstrap *(`client.ts:53-54`)* | `localStorage` is a browser API. A library reads `W6W_TOKEN` or takes the token as an argument, and never reaches for ambient browser storage. |
| 3 | Module-global mutable `token` + `setApiToken()` *(`client.ts:53-57`)* | A single mutable module-level credential means **two clients in one process share one token** — an outright bug for a server-side SDK juggling tenants. Credentials are instance state (§2, MECHANISM PIN). |
| 4 | `onAuthError` callback + `setAuthErrorHandler()` *(`client.ts:63-66`)* | A registration hook for "session died" only makes sense where there is a session and a UI. |
| 5 | `if (res.status === 401 && code === "unauthorized") onAuthError?.()` *(`client.ts:153`)* | A redirect-to-login side effect has no meaning in a library. Wrappers raise the `ApiError` and stop — no redirect, no refresh, no retry (§3). |
| 6 | `runWorkflow`'s **600 × 500 ms client-side poll** *(`client.ts:420-445`)* | The server offers `?wait=true`, which polls server-side. Re-implementing the poll in three languages means three timeout policies and three retry-storm bugs to keep in sync. Use `?wait=` and hand back the `202` handle (§4). |

Positively: the closest thing in the house to what a wrapper actually is, is
the operator console — it talks to the same API server-side, from Node,
with an env-supplied bearer: `apiBase()` at `src/lib/targets.ts:51` (the base-URL
rule in §2), env config with an explicit "configured?" predicate at
`targets.ts:20-48`, and `src/app/api/proxy/route.ts` doing `res.text()` + guarded
`JSON.parse` + status passthrough — the same three failure modes as §3. Prefer it
as the shape reference wherever the two disagree.

---

## 9. Tests and coverage

**Tests never require a live server.** Every test in every wrapper runs against a
**mocked transport** — an injected `fetch`-shaped function (node/cli) or an
injected opener/`urlopen` seam (python). Conformance against a real server is a
separate, later, environment-dependent step and is not part of any wrapper's own
test suite.

The mock seam is constructor-injected, for the same reason the credential is
(§2): a module-patched global cannot be exercised twice differently in one
process. `deno test` and `python3 -m unittest` both run the suite in-process.

### Required tests

For **every operation in `endpoints.json` — all seventeen, `required` and
`planned` alike**:

1. **Success path.** Assert the request the wrapper *made* (method, resolved URL
   including query parameters, `Authorization` header, JSON body) **and** the value
   it *returned* — specifically that the envelope key was unwrapped: a list
   operation returns the array, a single-item operation returns the object, a
   delete returns nothing.
2. **At least one error path.** Assert the raised error's `status` and `code`
   (e.g. `404 unknown_document`, `409 document_exists`, `400 invalid_name`).

Plus these cross-cutting tests, once each per wrapper:

3. **Env-var base-URL resolution** — `W6W_BASE_URL=https://x.example.com` produces
   `https://x.example.com/api/…`; a trailing slash does not double it; a value
   already ending in `/api` is not doubled; an explicit constructor argument
   overrides the env var; a missing base URL raises a configuration error naming
   `W6W_BASE_URL`.

   **Blank-is-absent, as three separate cases with identical behaviour**: the
   env var set to `""`, set to `"   "`, and **unset** must each produce the
   *same* configuration error naming `W6W_BASE_URL`. Write them as three cases
   (a table-driven test over the three inputs is fine, one case each is fine —
   what is not fine is testing only the unset one, which is the gap this closes).
   Assert additionally that **no request is ever made with a relative URL**: a
   test that lets a blank value through would otherwise pass while the wrapper
   silently resolved to `/api`. The same three cases apply to a blank `W6W_TOKEN`
   under item 4.
4. **`W6W_TOKEN`** is sent as `Authorization: Bearer <token>`, and an explicit
   constructor token overrides the env var.
5. **The three failure modes of §3**, one test each: transport failure →
   `status 0` / `network_error`; a non-JSON body on a non-OK status →
   `bad_response` with a snippet; an envelope error → code, message and `raw`
   preserved.
6. **`202` and `status: "failed"` do not raise** (§4), and `RunEnvelope` dispatches
   on `kind` — one case per known arm, plus an **unknown `kind`**.

   The unknown-`kind` case must **discriminate**, not merely survive: feed the
   mock a body such as `{"kind": "batch", "jobId": "job_1"}` and assert that the
   call **returns that object** — same `kind`, and the unknown sibling field
   (`jobId`) still present and reachable. "Does not crash" is not an assertion a
   raising implementation fails, so it is not the requirement; an implementation
   that raises here must **fail this test**. Assert no exception is raised, and
   assert on the returned value.
7. **Caller-supplied values are percent-encoded at every interpolation** (§2's
   encoding pin). At minimum: a document key containing `/` produces `%2F` and
   **not** a second path segment; one containing a space produces `%20`; one
   containing `?` produces `%3F` and does not become a query parameter;
   `vars.getByName` encodes its name too. Plus one negative test that pins the
   encoding-not-validation rule: the key `"../.."` is **encoded and sent**, and
   the wrapper raises no client-side error on it.
8. **Two clients in one process hold different credentials and base URLs** (§2's
   mechanism pin — this test is what actually prevents the module-global
   regression).

### Coverage

Coverage is **measured and reported** in every wrapper's CI, and the gate is
**90 %**.

- node / cli: `deno coverage` (`deno test -A --coverage=cov && deno coverage cov`).
- python: measured in CI; not runnable on this host (no `pip`, §1), so the gate
  lives in the CI job and the reason is written into the wrapper's README rather
  than silently dropped.

**Why 90 and not 100** (HITL-2's pinned default): the intake asked for "100 %
coverage". Taken literally across three languages that costs more than the
wrappers themselves — a thin HTTP client's last few percent are defensive
branches that only exist to fail loudly (unreachable envelope guards,
platform-probe fallbacks in `readEnv`) and driving them to 100 % produces tests
written for the counter rather than for the behaviour. The
substantive requirement — **every operation exercised, every error path covered,
env resolution proven** — is the numbered list above, and it is stricter than a
percentage. 90 % is the floor that catches a whole operation going untested. If
the gate is ever raised to 100, the tests do not change; only the number does.

---

## 10. Conformance runner

Every wrapper carries a conformance test. It is the drift alarm: the actual
failure mode this project guards against is an operation added to two wrappers and
forgotten in a third.

### Input

Read **`endpoints.json`** — one level above the wrapper's own directory. Every
lane lives at the root of this repo (`node/`, `cli/`, `python/`, …) beside the
contract, so from a lane's root the contract is at `../endpoints.json`. Resolve
it from the test file's own location, never from the process working directory:
that is what makes the answer identical in CI, in a laptop checkout, and inside
the monorepo's submodule.

If the file is not found, the test **fails loudly** naming the path it looked for.
It must never skip, and it must never fall back to a copy vendored inside a lane
directory — a stale pinned copy defeats the entire mechanism.

### Assertion

For **every** entry in `operations[]` — **regardless of its `status`** — assert
that the symbol named in `naming.<lang>` is reachable on the client.

Resolving a `naming` string to a symbol, pinned so three runners agree:

1. Truncate at the first `(` — `client.documents.get_by_key(key, project=None)`
   → `client.documents.get_by_key`.
2. Drop the leading `client.` and split the remainder on `.` → the attribute path
   (`["documents", "get_by_key"]`).
3. Walk that path from a constructed client instance (constructed with a dummy
   base URL and token — the runner makes **no network calls**), and assert each
   step exists and that the final attribute is **callable**.

For the **CLI**, `naming.cli` resolves to a command instead:

1. Drop the leading `w6w `.
2. Take tokens up to (not including) the first token starting with `<`, `[` or
   `--` → the command path (`w6w documents get-by-key <key> …` →
   `["documents", "get-by-key"]`).
3. Assert the command is **registered** and that invoking it with `--help`
   **exits 0** and prints help — with **no token set and no server reachable**
   (`cli.help.requiresAuth: false`, `requiresNetwork: false` in `endpoints.json`).

A failure message **names the missing operation** and the symbol it looked for:

```
conformance: operation `documents.getByKey` is not reachable — expected
`client.documents.getByKey` (from endpoints.json naming.ts)
```

The runner asserts **existence and reachability**, not behaviour. Behaviour is
§9's job.

### The runner exempts nothing — and `docs/parity.md` says the same

**This runner exempts nothing**: every operation in `operations[]` is asserted,
`required` and `planned` alike. `docs/parity.md` §Conformance states the same
rule in the same words — "asserts the client exposes **every** operation in
`operations[]` — **regardless of its `status`**" — and defers to this section for
the mechanics. The two documents agree; if they ever drift, **this one is the
pinned spec** and `parity.md` follows it.

The reason is that this project implements all seventeen operations **ahead of the
server**: four are `planned` because the server is fenced (BLK-1), not
because the wrappers are unfinished. **`status` records *server* readiness, not
wrapper obligation.** A wrapper that omitted `run` or `documents.getByKey` "because
they are planned" would ship a surface that silently differs from its two
siblings, and the drift would only be discovered when the fence clears — which is
precisely the failure the lockstep bet exists to prevent.

So: `status` tells a **user** whether calling the operation will reach a live
route today. It tells an **implementer** nothing. Implement all seventeen; test
all seventeen against a mocked transport; assert all seventeen in conformance.
