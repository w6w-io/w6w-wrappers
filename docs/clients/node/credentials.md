---
id: null
key: "node/credentials"
title: "Credentials"
section: "clients"
description: "Create, rotate, disable, test and delete stored credentials from the Node SDK, and attach one to a connection by id."
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

# Credentials

A credential is a secret you store once and reuse. Connections point at it by id, so rotating the
secret updates every connection that uses it. This page shows the Node SDK calls. They live under
`client.console.credentials`, in the console subpath (`@w6w/sdk/console`), not in the stable
operation contract.

```ts
import { W6WClient } from "@w6w/sdk";
import "@w6w/sdk/console";

const client = new W6WClient();

const cred = await client.console.credentials.create({
  name: "Ops mailbox",
  contract: "api_key",
  source: { key: "sk_live_…" },
});

// Attach it: a connection that uses the stored credential by id.
const conn = await client.console.connections.create("sendgrid", {
  authKey: "apiKey",
  credentialId: cred.id,
});
console.log(conn.credentialId === cred.id); // true
```

## Methods

| Call | Does |
| --- | --- |
| `list({ contract?, appId?, authKey?, accessScope? })` | List credentials; only the filters you pass are sent. |
| `get(id)` | Read one credential. |
| `create({ name, contract, source, accessScope? })` | Store a new credential. Leave `accessScope` out for a shared (account) credential. |
| `update(id, { name })` | Rename it. |
| `rotate(id, { source })` | Replace the secret. |
| `disable(id)` / `enable(id)` | Turn it off and on again. |
| `test(id)` | Probe it. Returns `{ ok, code?, message? }`. A failed probe is `ok: false`, not an error. |
| `dependents(id)` | The connections that use it. |
| `types()` | The credential types the server stores and the fields each collects (`GET /credential-types`). |
| `delete(id)` | Delete it. There is no force option. |

## What you never get back

`source` is sent to the server and forwarded as-is. The SDK does not read it, log it or return it,
and no response carries it. A `CredentialSummary` has the id, name, contract, status, revision,
non-secret `display` labels, whether it is `private`, how many connections use it
(`connectionCount`) and its timestamps. On a current server it also has `accessScope`: `"account"` (shared) or `"user"` (only its creator; absent on an older server). `private` keeps its own meaning, private to one connection.

## Personal ("Only me") credentials

Pass `accessScope: "user"` to `create` (or to `console.connections.create`) to keep a key to yourself. Check `(await client.me()).capabilities?.userScopedCredentials === true` first; an older server does not know the field. The server answers with one of these codes, which reach you as an `ApiError` with that `code`: `user_context_required`, `credential_scope_mismatch`, `user_scope_unsupported`, `user_scope_not_enabled`, `ai_credential_policy_denied`. The type `OwnershipErrorCode` lists them with the two model-call codes `personal_key_required` and `personal_key_unavailable`.

Two more console namespaces cover the personal side. `client.console.aiKeys` has `defaults()`, `setDefault(providerAppId, connectionId)` and `clearDefault(providerAppId)`: the caller's own default key per provider, with no user or account parameter. `client.console.aiCredentialPolicy` has `get()` and `put({ mode })` for the tenant's policy on which key kinds AI calls may use (`both`, `account_only`, `user_only`); `put` needs a tenant admin.

## Keeping a connection signed in

The server refreshes a connection's credential in the background so that an unused refresh token
does not expire. It is on by default. Pass `autoRefresh: false` to `console.connections.create`,
`console.connections.update` or `console.apps.startOAuthFlow` to turn it off, and `true` to turn it
back on. `console.apps.getAuth(appId)` marks each auth method `refreshable` when the server can keep
its connections signed in.

Every connection read then carries `autoRefresh`, `lastRefreshedAt` (the last successful refresh,
or when the connection was made) and `refreshFailingSince` (`null` unless background refreshes are
currently failing). None of them is secret, and an older server sends none of them. A connection
whose refresh needs a new sign-in moves to `state: "broken"`; reconnect it.

If an auth method signs in at connect time and the sign-in is refused, `create` (or an `update`
with a new `credential`) fails with an `ApiError` whose `status` is `422` and `code` is
`credential_invalid`. The app's own short code, when it gave one, is on the raw body:

```ts
import { ApiError } from "@w6w/sdk";

try {
  await client.console.connections.create("my-app", {
    authKey: "login",
    credential: { email, password },
  });
} catch (err) {
  if (err instanceof ApiError && err.code === "credential_invalid") {
    const raw = err.raw as { error: { hookCode?: string } };
    console.log(raw.error.hookCode); // e.g. "invalid_credentials"
  }
}
```

## Listing credential types

```ts
const types = await client.console.credentials.types();
// [{ id: "bearer.v1", label: "...", fields: [{ key: "token", label: "...", secret: true }] }, ...]
```

Each descriptor's `id` is the contract id to pass as `contract` to `create`; `fields` are the inputs
to collect (render `secret` ones masked).

## Deleting a credential that is in use

```ts
import { ApiError } from "@w6w/sdk";

try {
  await client.console.credentials.delete(cred.id);
} catch (err) {
  if (err instanceof ApiError && err.code === "credential_in_use") {
    const raw = err.raw as { error: { dependents: { connections: { id: string }[] } } };
    console.log(raw.error.dependents.connections.map((c) => c.id));
  }
}
```

Detach or delete those connections first.
