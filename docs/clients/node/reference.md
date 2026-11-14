---
id: null
key: "node/reference"
title: "Node SDK reference"
section: "clients"
description: "Every W6WClient option, method and error in @w6w/sdk, on one page."
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

# Node SDK reference

Everything `@w6w/sdk` exports for application code. For a walkthrough, start with the
[Node SDK](/clients/node/) page.

## Entry points

| Import from | What it holds |
| --- | --- |
| `@w6w/sdk` | `W6WClient`, `ApiError`, `ConfigError`, `path`, `VERSION`, the result guards and every type. |
| `@w6w/sdk/server` | `createEmbedSessionClient` (the recommended session minter) and the lower-level `exchangeToken`, for backends only. Self-hosted deployments must pass `baseUrl` explicitly: when omitted, the helpers send the tenant client credentials to `https://api.w6w.io`. See [Embed w6w in your product](/guides/embed/). |
| `@w6w/sdk/console` | The calls Studio makes. Unstable: it can change in any release. |

## `new W6WClient(options?)`

| Option | Type | Default | What it does |
| --- | --- | --- | --- |
| `baseUrl` | `string` | `W6W_BASE_URL`, then `https://api.w6w.io` | Your API origin, such as `https://<your-host>`. Must be an absolute `http` or `https` URL. A path is kept as given. |
| `token` | `string` or a function | `W6W_TOKEN` | A token, or a supplier called per request with `{ forceRefresh }` (concurrent requests share one call; memoize it yourself). May be async. |
| `project` | `string` | your account's default | Default project for `documents.*`, `workflows.list`, `workflows.create` and `workflows.update`. |
| `refreshOnUnauthorized` | `boolean` | `false` | On a `401 unauthorized`, call the token supplier with `{ forceRefresh: true }` and retry once. |
| `onUnauthorized` | `(err: ApiError) => void` | none | Called with the final `401` error, at most once per call. |
| `headers` | `Record<string, string>` | none | Headers sent with every request. Can't override `Authorization`. |
| `fetch` | `typeof fetch` | the global `fetch` | Your own fetch, for proxies or tests. |

The constructor raises `ConfigError` if the base URL is malformed or an explicit empty string. A missing token is reported on
the first call instead.

## Client methods

| Method | Returns | Notes |
| --- | --- | --- |
| `me({ signal? })` | `Me` | `tenant`, `subject`, `account`, `role`, and `versions`, which always holds `wrapper` (the SDK's version). |
| `run({ urn, action?, payload? })` | `RunEnvelope` | Runs a `conn_…` action, `fn_…` Function, `ep_…` Endpoint or `wf_…` Workflow. A workflow is queued, not awaited. |
| `request<T>({ method, path, query?, body?, headers?, signal? })` | `{ status, body }` | Calls any route with the client's base URL and token. |

### `run` results

Check the result with a guard before reading fields:

| Guard | `kind` | Fields |
| --- | --- | --- |
| `isActionRun(r)` | `"action"` | `output` (the action's return value; `value` holds the same and is kept for older code) |
| `isFunctionRun(r)` | `"function"` | `output` |
| `isWorkflowRun(r)` | `"workflow"` | `runId`, `status` (`"queued"`) |

Every result also carries `invocationId` (`inv_…`), `startedAt`, `finishedAt` and `durationMs`
when the server records them. A `kind` the SDK doesn't recognise is returned unchanged.

## `client.connections`

| Method | Returns | Notes |
| --- | --- | --- |
| `list({ signal? })` | `ConnectionSummary[]`: `id`, `appId`, `displayName`, `state`, `lastTestOk`, `lastTestedAt`, `tenant`, `subject`, `credentialId` (the stored credential it uses; `null` = none), `autoRefresh`, `lastRefreshedAt` and `refreshFailingSince` (keep-alive state; absent on an older server), and `app` (inline app name, icons and brand colours; `null` or absent when unknown) | |
| `get(id, { signal? })` | `ConnectionSummary` | `404 unknown_connection` for an unknown or another account's id, and for a built-in `zerocred:` row |
| `delete(id, { signal? })` | nothing | Account-owned; also tears down the connection's trigger subscriptions. Same `404` rules. |

`state` is `pending`, `connected`, `needs_refresh`, `broken` or `revoked`; `broken` means reconnect it. `builtIn` is `true` only on
the synthetic zero-credential row in a list (optional; absent on older servers).

## `client.apps`, `client.dashboard`, `client.projects`, `client.reliability`

| Method | Returns | Notes |
| --- | --- | --- |
| `apps.byIds(ids, { signal? })` | `AppSummary[]` | Chunks to the server's 100-id cap; `[]` makes no request; duplicates collapsed. For a connection's app prefer its inline `app`. |
| `dashboard.stats({ from?, to?, bucket?, signal? })` | `DashboardStats` | Account-scoped; no project. |
| `projects.list({ signal? })` | `Project[]` | Read-only; includes `isDefault`. The first call on a new account creates the default project. |
| `reliability.list(project, appIds, { days?, limit?, signal? })` | `ReliabilityServices` | At most 10 app ids; the server's `400` is raised as `ApiError`. No batching helper. |
| `reliability.members(project, { days?, signal? })` | `ReliabilityServiceMembers` | `appIds` of the apps the project's calls touch. |

## `client.workflows`

| Method | Returns | Notes |
| --- | --- | --- |
| `list({ project?, signal? })` | `WorkflowSummary[]` | `id`, `key`, `name`, `displayName`, `status` (`draft`, `active` or `archived`), `tags`, `runCount`, `updatedAt` |
| `run(idOrKey, { wait?, input?, variables?, trigger?, allowUnpublished?, entry? })` | `WorkflowRunResult` | `runId`, `status`, `terminal`, `output`, `error`, `stepErrors`, `steps`, `httpStatus`. A failed run is returned, not raised. |
| `cancel(runId)` | `{ id, status, cancelRequestedAt }` | Requests cancellation. `status` is the run's status at that moment. |
| `get(id, { signal? })` | `{ workflow, sourceRef, updatedAt }` | The full definition. |
| `create(definition, { project? })` | `{ workflow: { id, name }, scheduled, updatedAt }` | Assigns a `wf_…` id if the definition has none. |
| `update(id, definition, { project?, ifUnmodifiedSince? })` | same as `create` | Replaces the whole definition. `409 workflow_stale` if `ifUnmodifiedSince` doesn't match. |
| `archive(id)` | the archived definition | Required before `delete`. |
| `delete(id)` | nothing | `409 workflow_not_archived` if it's still active. |
| `listVersions(id)` | `VersionList` | `enabled`, `currentPublishedVersion`, `versions[]`. Metadata only. |
| `getVersion(id, n)` | `VersionDetail` | One version with its `definition`. `404 unknown_version`. |
| `publish(id)` | `PublishResult` | Snapshots the **saved** definition; save first. |
| `revert(id, n)` | `RevertResult` | Rewrites the live definition from version `n`; does not publish. Re-read `updatedAt` before your next save. |
| `enable(id)` | nothing | Idempotent. |
| `disable(id)` | nothing | Idempotent. Runs then raise `workflow_disabled`. |
| `runVersion(id, n, { wait?, input?, variables?, trigger? })` | `WorkflowRunResult` | Runs one published version. Same result as `run`. |

## `client.functions`

| Method | Returns | Notes |
| --- | --- | --- |
| `run(idOrKey, { payload?, allowUnpublished? })` | the Function's output | `404 unknown_function`, `422 function_incomplete`. `allowUnpublished: true` runs the saved definition without a publish. |
| `list({ signal? })` | `FunctionSummary[]` | `id`, `key`, `displayName`, `description`, `updatedAt`, `valid` |
| `get(id, { signal? })` | `{ function, valid, updatedAt }` | `valid` is `false` when the Function can't run yet. `updatedAt` is the save token. |
| `create(definition)` | `{ id, key, updatedAt }` | Assigns a `fn_…` id if the definition has none. |
| `update(id, definition, { ifUnmodifiedSince? })` | `{ id, key, updatedAt }` | Replaces the whole definition. A stale `ifUnmodifiedSince` is `409 function_stale`. |
| `archive(id)` | the archived definition | Required before `delete`. |
| `delete(id)` | nothing | `409 function_not_archived` if it's still active. |
| `listVersions(id)` | `VersionList` | `enabled`, `currentPublishedVersion`, `versions[]`. Metadata only. |
| `getVersion(id, n)` | `VersionDetail` | One version with its `definition`. `404 unknown_version`. |
| `publish(id)` | `PublishResult` | Snapshots the **saved** definition; save first. |
| `revert(id, n)` | `RevertResult` | Rewrites the live definition from version `n`; does not publish. Re-read `updatedAt` before your next save. |
| `enable(id)` | nothing | Idempotent. |
| `disable(id)` | nothing | Idempotent. Runs then raise `function_disabled`. |
| `runVersion(id, n, { payload? })` | the Function's output | Runs one published version. Same output as `run`. |

## `client.endpoints`

| Method | Returns | Notes |
| --- | --- | --- |
| `run(idOrKey, { payload? })` | `RunEnvelope` | Same result shape as `client.run()`. `404 unknown_endpoint`. |

## `client.documents`

All take an optional last argument `{ project?, signal? }`.

| Method | Returns |
| --- | --- |
| `list()` | `Doc[]` |
| `get(id)` | `Doc`: `id`, `key`, `content`, `format`, `description`, `createdAt`, `updatedAt` |
| `getByKey(key)` | `Doc` |
| `create({ key, content, format?, description? })` | `Doc` |
| `update(id, { content?, format?, description? })` | `Doc` |
| `delete(id)` | nothing |

`format` is `text`, `markdown`, `yaml`, `html` or `json`.

## `client.vars`

| Method | Returns |
| --- | --- |
| `list({ signal? })` | `Var[]` |
| `get(id, { signal? })` | `Var`: `id`, `name`, `type`, `value`, `description`, `createdAt`, `updatedAt` |
| `getByName(name)` | `Var` |
| `create({ name, type, value, description? })` | `Var` |
| `update(id, { type?, value?, description? })` | `Var` |
| `delete(id)` | nothing |

`type` is `string`, `number`, `boolean` or `json`.

## `client.team`

Reading the team works for any member. Inviting, revoking, changing roles and removing members need
the `owner` or `admin` role.

| Method | Returns | Notes |
| --- | --- | --- |
| `members()` | `TeamMember[]` | `userId`, `email`, `displayName`, `role`, `createdAt` |
| `invite({ email?, role? })` | `TeamInviteWithLink` | Leave out `email` for an open invite link. `role` is `member` (default) or `admin`. The result includes `token` and `redemptionLink`. |
| `invites()` | `TeamInvite[]` | Open invites. |
| `revokeInvite(id)` | nothing | |
| `setRole(userId, role)` | `TeamMember` | `member` or `admin`. The owner's role can't be changed. |
| `removeMember(userId)` | nothing | The owner can't be removed. |

## Errors

| Class | Fields | Raised when |
| --- | --- | --- |
| `ConfigError` | `message` | The base URL is malformed or the token is missing. No request was sent. |
| `ApiError` | `status`, `code`, `message`, `raw` | A request failed. `status` is `0` for `network_error` and `cancelled`. `raw` is the parsed error body. |

See [Handle errors](/clients/node/#handle-errors) for how to read `status` and `code`.

## Helpers

| Export | What it does |
| --- | --- |
| `` path`/documents/by-key/${key}` `` | Builds a request path, percent-encoding each interpolated value. |
| `isTerminalRunStatus(status)` | `true` for `succeeded`, `failed` and `canceled`. |
| `VERSION` | The installed SDK version. |

## Where to next

- **[Node SDK](/clients/node/)**: install, authenticate and run your first action.
- **[Python](/clients/python/)**: the same operations in Python.
