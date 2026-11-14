---
id: null
key: "python/reference"
title: "Python reference"
section: "clients"
description: "Every Client argument, method and error in the w6w Python package, on one page."
format: "markdown"
shared: true
sourceRepo: null
sourcePath: null
sourceSha: null
sourceRefSha: null
sourceUrl: null
syncedAt: null
createdAt: null
updatedAt: null
---

# Python reference

Everything the `w6w` package exports for application code. Import from `w6w`, except
`EmbedSessionClient` and `exchange_token`, which live in `w6w.server`. For a walkthrough, start with the
[Python](/clients/python/) page.

## `Client(...)`

| Argument | Type | Default | What it does |
| --- | --- | --- | --- |
| `base_url` | `str` | `W6W_BASE_URL`, else `https://api.w6w.io` | Your API origin, such as `https://<your-host>`. Must be an absolute `http` or `https` URL. A path is kept as given. |
| `token` | `str` or a callable | `W6W_TOKEN` | A token, or a synchronous callable called before every authenticated request, as `token()` or `token(force_refresh=True)`. Its result is not cached or shared by the client; cache inside your callable. |
| `project` | `str` | your account's default | Default project for `documents.*`, `workflows.list`, `workflows.create` and `workflows.update`. |
| `refresh_on_unauthorized` | `bool` | `False` | On a `401 unauthorized`, call the token callable with `force_refresh=True` and retry once. |
| `on_unauthorized` | callable | `None` | Called with the final `401` `ApiError`, at most once per call. |
| `headers` | mapping | `None` | Headers sent with every request. Can't override `Authorization`. |
| `transport` | callable | `urllib.request.urlopen` | Takes a `urllib.request.Request` and returns a response. Use it to set a timeout or a proxy. |

`Client()` raises `ConfigError` if the `base_url` you pass is blank, or if the base URL it ends up
with (passed, or from `W6W_BASE_URL`) is relative or not http(s). An unset or empty `W6W_BASE_URL`
is not an error: the client targets `https://api.w6w.io`. A missing token is reported on the
first call instead.

## Client methods

| Method | Returns | Notes |
| --- | --- | --- |
| `me()` | `Me` | `tenant`, `subject`, `account`, `role`, and `versions`, which always holds `"wrapper"` (the client's version). |
| `run(urn, action=None, payload=None)` | `dict` | Runs a `conn_…` action, `fn_…` Function, `ep_…` Endpoint or `wf_…` Workflow. A workflow is queued, not awaited. |
| `request(method, path, query=None, body=None, headers=None)` | `HttpResponse(status, body)` | Calls any route with the client's base URL and token. |

### `run` results

| Check | `kind` | Keys |
| --- | --- | --- |
| `w6w.is_action_run(r)` | `"action"` | `output` (the action's return value; `value` holds the same) |
| `w6w.is_function_run(r)` | `"function"` | `output` |
| `w6w.is_workflow_run(r)` | `"workflow"` | `runId`, `status` (`"queued"`) |

Every result also carries `invocationId`, `startedAt`, `finishedAt` and `durationMs` when the
server records them. Read them with `.get()`.

## `client.connections`

| Method | Returns |
| --- | --- |
| `list()` | `list[ConnectionSummary]`: `id`, `appId`, `displayName`, `state`, `lastTestOk`, `lastTestedAt`, `tenant`, `subject`, `credentialId` (`None` = no stored credential), `autoRefresh`, `lastRefreshedAt` and `refreshFailingSince` (keep-alive state; `None` against an older server), `app` (inline app name, icons and brand colours; `null` or absent when unknown), and `built_in` |
| `get(id)` | `ConnectionSummary`. `404 unknown_connection` for another account's id and for a `zerocred:` built-in row. |
| `delete(id)` | `None`. Same ownership rule (another account's id is `404`); not idempotent. The server removes the connection's trigger subscriptions first. |

`built_in` is `True` for the synthetic zero-credential row (a `zerocred:` id, usable with no
connection step, not stored, not deletable) and `None` otherwise, including against an older server.
Creating, updating, testing and OAuth-connecting a connection are not in the Python client.

## `client.workflows`

| Method | Returns | Notes |
| --- | --- | --- |
| `list(project=None)` | `list[WorkflowSummary]` | `id`, `key`, `name`, `displayName`, `status`, `tags`, `runCount`, `updatedAt` |
| `run(id, wait=False, variables=None, trigger=None, input=None, allow_unpublished=False)` | `WorkflowRunResult` | `runId`, `status`, `terminal`, `output`, `error`, `stepErrors`, `steps`, `httpStatus`. `id` may be the workflow's key. `allow_unpublished=True` runs the stored draft (save first; a disabled workflow is still refused) and is sent in the body only when `True`. |
| `run_version(id, n, wait=False, variables=None, trigger=None, input=None)` | `WorkflowRunResult` | Runs published version `n` instead of the live row. No `allow_unpublished`. |
| `list_versions(id)` | `dict` | `enabled`, `currentPublishedVersion` (`None` before the first publish), `versions` (metadata only). |
| `get_version(id, n)` | `dict` | `versionNumber`, `createdAt`, `createdBy`, `isCurrentPublished`, `definition`. |
| `publish(id)` | `dict` | `version`, `currentPublishedVersion`. Snapshots the stored row, so save first. |
| `revert(id, n)` | `dict` | `kind`, `callableId`, `versionNumber`. Rewrites the live row; does not publish. A following `update` with `if_unmodified_since` needs the fresh `updatedAt`. |
| `enable(id)` / `disable(id)` | `None` | A disabled workflow refuses every run, version and draft runs included. |
| `cancel(id)` | `dict` | `id`, `status` (the status at that moment), `cancelRequestedAt`. `id` is the run id. |
| `get(id)` | `WorkflowDetail` | `workflow` (the definition), `sourceRef`, `updatedAt` |
| `create(definition, project=None)` | `WorkflowSaveResult` | `id`, `name`, `scheduled`, `updatedAt`. Assigns a `wf_…` id if the definition has none. |
| `update(id, definition, project=None, if_unmodified_since=None)` | `WorkflowSaveResult` | Replaces the whole definition. `409 workflow_stale` if `if_unmodified_since` doesn't match. |
| `archive(id)` | `dict` | Required before `delete`. |
| `delete(id)` | `None` | `409 workflow_not_archived` if it's still active. |

## `client.functions`

| Method | Returns | Notes |
| --- | --- | --- |
| `run(name, payload=None, allow_unpublished=False)` | the Function's output | `name` is the key or `fn_…` id. `allow_unpublished=True` runs the stored draft (body field, only when `True`). |
| `run_version(id, n, payload=None)` | the Function's output | Runs published version `n` (wire verb `invoke`). No `allow_unpublished`. |
| `list_versions(id)`, `get_version(id, n)`, `publish(id)`, `revert(id, n)`, `enable(id)`, `disable(id)` | as on `client.workflows` | Same shapes. `revert` is itself unguarded but moves `updatedAt`, so re-read the token before a guarded `update`. |
| `archive(id)` | `dict` | Required before `delete`. Idempotent; one-way. |
| `list()` | `list[FunctionSummary]` | `id`, `key`, `displayName`, `description`, `updatedAt`, `valid`, `archivedAt` (`None` while live) |
| `get(id)` | `FunctionDetail` | `function` (the definition), `valid`, `updatedAt` (the concurrency token) |
| `create(definition)` | `SaveResult` | `id`, `key`, `updatedAt`. Assigns a `fn_…` id if the definition has none. |
| `update(id, definition, if_unmodified_since=None)` | `SaveResult` | Replaces the whole definition. Pass `if_unmodified_since` (the `updatedAt` from `get` or a prior save) to refuse a stale write with `409 function_stale`; omitted or `None`, no header is sent. |
| `delete(id)` | `None` | `409 function_not_archived` unless the Function was archived first (`archive(id)`). |

## `client.apps`

| Method | Returns | Notes |
| --- | --- | --- |
| `by_ids(ids)` | `list[dict]` | Catalog summaries for the given app ids. Duplicates collapse; `[]` returns `[]` with no request; the client sends chunks of at most 100 ids (sequentially). Unknown ids are absent. Prefer the inline `app` on a connection when you have one. Raises `ConfigError` (no request) for a bare string such as `"abc"`; pass a list. |

## `client.dashboard`

| Method | Returns | Notes |
| --- | --- | --- |
| `stats(from_=None, to=None, bucket=None)` | `dict` | `range`, `headline`, `series`, `recent`. Account-scoped: no project is sent. `bucket` is `"day"` or `"week"`. Each argument is sent only when given. |

## `client.projects`

| Method | Returns | Notes |
| --- | --- | --- |
| `list()` | `list[dict]` | Active projects, each with `isDefault`. Read-only. The GET creates the account's default project if there is none. |

## `client.reliability`

| Method | Returns | Notes |
| --- | --- | --- |
| `list(project, app_ids, days=None, limit=None)` | `dict` | The reliability board. The server accepts 1 to 10 ids; anything else is `400 invalid_app_filter`, raised as `ApiError` unchanged. No batching helper: splitting and polling are yours. |
| `members(project, days=None)` | `dict` | `appIds`: the ids to feed, at most 10 at a time, to `list`. No status probes. |

## `client.endpoints`

| Method | Returns | Notes |
| --- | --- | --- |
| `run(name, payload=None)` | `dict` | Same shape as `client.run()`. `name` is the key or `ep_…` id. |

## `client.documents`

Every method takes an optional `project=`.

| Method | Returns |
| --- | --- |
| `list()` | `list[Doc]` |
| `get(id)` | `Doc`: `id`, `key`, `content`, `format`, `description`, `createdAt`, `updatedAt` |
| `get_by_key(key)` | `Doc` |
| `create(key, content, format=None, description=None)` | `Doc` |
| `update(id, content=…, format=…, description=…)` | `Doc`. Only the arguments you pass are changed. |
| `delete(id)` | `None` |

## `client.data_stores`

Every method takes an optional `project=` (per call, then the client's default, otherwise the server's). Results are the server's JSON as plain `dict`s. Unset options are absent from the request, never `null`.

| Method | Returns |
| --- | --- |
| `list(kind=None, cursor=None, limit=None)` | `{"items": [...], "nextCursor"?: str}` |
| `get(id)` | The store. |
| `create(kind, name, description=None, schema=None)` | The new store. `kind` is `"kv"`, `"doc"` or `"table"`. |
| `update(id, name=…, description=…, schema=…)` | The store. Only the arguments you pass are changed. |
| `archive(id)` | `None`. A soft delete: the store then answers `404 data_store_not_found`. |
| `import_csv(id, csv)` | `{"imported": n}`. `csv` is a `str` (sent as UTF-8) or `bytes` (verbatim). |
| `export_csv(id)` | The CSV as a `str`, byte-for-byte as the server sent it. |

`client.data_stores.entries` holds the entry operations:

| Method | Returns |
| --- | --- |
| `list(id, prefix=None, cursor=None, limit=None)` | `{"items": [...], "nextCursor"?: str}` |
| `get(id, key)` | The entry. The key is percent-encoded into the path. |
| `set(id, key, value, if_version=None, ttl_seconds=None)` | The entry. `if_version` makes the write a compare-and-set. |
| `insert(id, value, ttl_seconds=None)` | The new entry (table stores; the server generates the key). |
| `increment(id, key, by=None)` | The entry. Without `by` no body is sent and the server adds 1. |
| `delete(id, key)` | `None` |
| `query(id, where=None, order=None, limit=None)` | `{"items": [...]}`. `where={"col": "v"}` is sent as `where[col]=v`, one pair per column. |

### CSV text mode

`import_csv` and `export_csv` are the only calls that leave JSON. They use two explicit options on `client.request`: `body_encoding="csv"` sends a `str` or `bytes` body verbatim as `Content-Type: text/csv`, and `response_encoding="text"` returns the 2xx body as a `str`, never JSON-parsed. Neither is inferred from the body's type: without `body_encoding`, a `str` body is still a JSON string. A non-2xx raises the usual `ApiError`, for example `400 invalid_value` (with `field`/`column` in `raw["error"]`), `invalid_key`, `invalid_cursor` or `unknown_project`.

## `client.vars`

| Method | Returns |
| --- | --- |
| `list()` | `list[Var]` |
| `get(id)` | `Var`: `id`, `name`, `type`, `value`, `description`, `createdAt`, `updatedAt` |
| `get_by_name(name)` | `Var` |
| `create(name, type, value, description=None)` | `Var` |
| `update(id, type=…, value=…, description=…)` | `Var`. Only the arguments you pass are changed. |
| `delete(id)` | `None` |

## `client.team`

Reading works for any member. The rest need the `owner` or `admin` role.

| Method | Returns |
| --- | --- |
| `members()` | `list[TeamMember]`: `user_id`, `email`, `display_name`, `role`, `created_at` |
| `invite(email=None, role=None)` | `TeamInviteWithLink`, including `token` and `redemption_link`. Leave out `email` for an open link. |
| `invites()` | `list[TeamInvite]` |
| `revoke_invite(id)` | `None` |
| `set_role(user_id, role)` | `TeamMember`. `role` is `"member"` or `"admin"`. |
| `remove_member(user_id)` | `None` |

## `client.models`, `client.model_routes`, `client.model_usage`

The model registry: a catalog of AI models, named **model routes** that pick the model, provider and
fallbacks for you, and a usage report. See the [Node models page](/clients/node/models/) for the walkthrough. Creating and editing routes is
not part of the stable surface.

| Method | Returns |
| --- | --- |
| `models.list(provider=None, status=None, limit=None, cursor=None)` | The whole page, `{"models": [...], "nextCursor": ...}`. Pass `nextCursor` back as `cursor`. |
| `models.get(id)` | One catalog entry, by its catalog id (`mdl_…`). |
| `model_routes.list(project=None)` | `list` of routes. |
| `model_routes.get(name, project=None)` | One route. |
| `model_routes.complete(name, input, project=None, dialect=None, response=None)` | The flat envelope exactly as the server sent it, with `invocationId` and `status`. Not unwrapped to `output`. |
| `model_usage.query(project=None, group_by=None, from_=None, to=None, route=None, model=None, limit=None, cursor=None)` | `{"totals", "totalsTruncated", "groups", "items", "nextCursor"}` as sent. `group_by` is `route`, `model` or `day`. |

`dialect` is `openai`, `anthropic` or `ollama`. `response` is `output`, `raw` or `both`. `project` falls back to the client's `project` setting, then to your account's default
project.

```python
import w6w

client = w6w.Client()

page = client.models.list(provider="openai", limit=20)
route = client.model_routes.get("summarize")

result = client.model_routes.complete(
    "summarize",
    {"messages": [{"role": "user", "content": "Summarize this ticket."}]},
    dialect="openai",
    response="both",
)
print(result["invocationId"], result["status"])

report = client.model_usage.query(group_by="route", from_="2026-10-01", to="2026-10-24")
```

## `w6w.server.EmbedSessionClient(...)`

For backends only. The recommended way to mint a short-lived, account-scoped session for one user: `from w6w.server import EmbedSessionClient`. Walkthrough: [Embed w6w in your product](/guides/embed/).

| Argument | What it is |
| --- | --- |
| `base_url` | Your API origin. Optional: omitted, it is `https://api.w6w.io`; it never reads `W6W_BASE_URL`. Self-hosted deployments must pass their API origin explicitly: when omitted, the helper sends the tenant client credentials to `https://api.w6w.io`. A blank value raises `ConfigError`. Use the final `https` origin. `exchange_token` and `EmbedSessionClient` refuse redirects by default: a 3xx raises `ApiError` and the Basic client credential is never re-sent. An injected `transport` is used as given. |
| `client_id`, `client_secret` | Your tenant's credentials. Keep the secret on your backend. |
| `transport` | Optional. Defaults to a transport that never follows redirects (unlike `Client`); your own transport decides. |
| `now` | Optional clock returning epoch seconds. Defaults to `time.time`. |

`create(subject, account_ref)` makes one exchange. Both arguments are required and non-blank (`ConfigError` otherwise, no request sent). `subject` is sent as given; `account_ref` is trimmed. It returns a dict with exactly `token`, `expiresIn` (seconds), `expiresAt` (ISO-8601 UTC), `subject`, `tenant`, `account` (the resolved `acct_` id) and `accountRef`.

## `w6w.server.exchange_token(...)`

For backends only. The lower-level call, with an optional `account`. Trades your tenant's client credentials for a short-lived token for one user.

| Argument | What it is |
| --- | --- |
| `base_url` | Your API origin. Optional; omitted, it is `https://api.w6w.io`, and it never reads `W6W_BASE_URL`. Self-hosted deployments must pass their API origin explicitly: when omitted, the helper sends the tenant client credentials to `https://api.w6w.io`. |
| `client_id`, `client_secret` | Your tenant's credentials. Keep the secret on your backend. |
| `subject` | Your user's id. |
| `account` | Optional. The w6w account the user works in, from your own records. |
| `transport` | Optional. Defaults to a transport that never follows redirects (unlike `Client`); your own transport decides. |

Returns a dict with `token`, `expiresIn` (seconds) and `user`.

## Errors

| Class | Attributes | Raised when |
| --- | --- | --- |
| `w6w.ConfigError` | `message` | The token is missing, or the base URL you passed is blank, or the base URL is malformed. No request was sent. |
| `w6w.ApiError` | `status`, `code`, `message`, `raw` | A request failed. `status` is `0` for `network_error`. |

## Helpers

| Export | What it does |
| --- | --- |
| `w6w.path("/documents/by-key/{key}", key=k)` | Builds a request path, percent-encoding each value. |
| `w6w.is_terminal_run_status(status)` | `True` for `succeeded`, `failed` and `canceled`. |
| `w6w.__version__` | The installed version. |

## Where to next

- **[Python](/clients/python/)**: install, authenticate and run your first action.
- **[Node SDK reference](/clients/node/reference/)**: the same operations in TypeScript.
