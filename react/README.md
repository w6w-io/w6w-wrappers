# @w6w/react

React bindings for [`@w6w/sdk`](../node) — a `<W6WProvider>` that holds one memoized
`W6WClient` with per-request token freshness, a small hook set over the SDK's public
surface (`me`, `documents`, `vars`, `connections`, `workflows`, `run`), and
`createW6WUiAdapter`, a structural bridge from a `W6WClient` to
[`@w6w/ui`](https://github.com/w6w-io/w6w-ui)'s `W6WApi` contract.

License: MIT · Version: 0.3.0

This lane implements no endpoint — it composes `@w6w/sdk`, which is already
conformant against [`endpoints.json`](../endpoints.json). There is nothing here to
re-verify against the wire contract; verify `@w6w/sdk` instead.

## Install

```bash
npm install @w6w/react react
```

`react-dom` is not a dependency of this package — `<W6WProvider>`'s only JSX is a
context wrapper (`<Ctx.Provider>`), never a DOM element of its own. Your app already
depends on `react-dom` to mount itself; nothing extra is needed here.

## Quick start

Wrap your app root once:

```tsx
import { W6WProvider } from "@w6w/react";

function App() {
  return (
    <W6WProvider baseUrl="https://api.example.com" token={() => getCurrentJwt()}>
      <YourApp />
    </W6WProvider>
  );
}
```

`token` accepts a literal string, or a supplier function called fresh on every
request — pass a supplier when your token rotates (e.g. a short-lived JWT read from
an auth SDK) and the client will pick up the new value on the very next call, with no
teardown/rebuild of the underlying `W6WClient`. See `src/W6WProvider.tsx`'s module
header for the exact mechanism (the C-4 shim).

Then, anywhere under the provider:

```tsx
import { useDocuments, useW6WClient } from "@w6w/react";

function DocList() {
  const { data, loading, error, refetch } = useDocuments();
  if (loading) return <p>Loading…</p>;
  if (error) return <p>Failed: {String(error)}</p>;
  return (
    <ul>
      {data?.map((doc) => <li key={doc.id}>{doc.key}</li>)}
    </ul>
  );
}
```

## Using this package with `@w6w/ui`

`@w6w/ui`'s components (e.g. `AppPicker`, `ActionTestForm`, the flow editor) take a
`W6WApi` object through their own `<W6WUIProvider api={...}>`. Build one from your
`@w6w/react` client with `createW6WUiAdapter`:

```tsx
import { createW6WUiAdapter, useW6WClient, W6WProvider } from "@w6w/react";
import { W6WUIProvider, AppPicker } from "@w6w/ui";

function UiBridge({ children }: { children: React.ReactNode }) {
  const client = useW6WClient();
  const api = useMemo(() => createW6WUiAdapter(client), [client]);
  return <W6WUIProvider api={api}>{children}</W6WUIProvider>;
}

function App() {
  return (
    <W6WProvider baseUrl="https://api.example.com" token={jwtSupplier}>
      <UiBridge>
        <AppPicker onPick={(appId) => console.log(appId)} />
      </UiBridge>
    </W6WProvider>
  );
}
```

**`@w6w/ui` is not on npm today.** The `@w6w` scope holds only `@w6w/sdk` and
`@w6w/cli` at the time of writing (`npm view @w6w/ui` → 404); the source itself IS a
public GitHub repository (`w6w-io/w6w-ui`). `createW6WUiAdapter`'s `W6WApi` return
type targets that contract *structurally* — this package names `@w6w/ui` nowhere in
its own manifest and needs no change whenever `@w6w/ui` becomes reachable another
way (this monorepo, a `git+https://` dependency on the public repo, or a private
registry). This is an honest statement of today's install story, not a promise that
`npm i @w6w/ui` resolves.

`createW6WUiAdapter` is built entirely on `@w6w/sdk/console` — the SAME namespace
`packages/studio`'s own facade uses for these routes (`packages/ui/src/createW6WApi.ts`
is the *other* hand-rolled client for them; this package is not a third one).
**`client.console.*` is documented "Studio-internal… unstable" and is deliberately
excluded from `endpoints.json`'s conformance runner** (`node/src/client.ts:114-116`).
That means a `console.*` signature change ships with no lockstep protection for this
bridge beyond `@w6w/sdk`'s own version — pin your `@w6w/sdk` version alongside
`@w6w/react`'s, and re-test the bridge on an upgrade rather than assuming it.

## Hooks catalog

Every read hook returns `{data, error, loading, refetch}`; every mutation hook
returns `{call, data, error, loading}`. None depends on react-query or any other
data-fetching library.

| Hook | Wraps |
|---|---|
| `useMe()` | `client.me()` |
| `useDocuments(options?)` | `client.documents.list()` |
| `useDocument(id, options?)` | `client.documents.get()` |
| `useDocumentByKey(key, options?)` | `client.documents.getByKey()` |
| `useCreateDocument()` | `client.documents.create()` |
| `useUpdateDocument()` | `client.documents.update()` |
| `useDeleteDocument()` | `client.documents.delete()` |
| `useVars()` | `client.vars.list()` |
| `useVar(id)` | `client.vars.get()` |
| `useCreateVar()` | `client.vars.create()` |
| `useUpdateVar()` | `client.vars.update()` |
| `useDeleteVar()` | `client.vars.delete()` |
| `useConnections()` | `client.connections.list()` |
| `useWorkflows(options?)` | `client.workflows.list()` |
| `useWorkflow(id)` | `client.workflows.get()` |
| `useCreateWorkflow()` | `client.workflows.create()` |
| `useUpdateWorkflow()` | `client.workflows.update()` |
| `useArchiveWorkflow()` | `client.workflows.archive()` |
| `useDeleteWorkflow()` | `client.workflows.delete()` |
| `useRunWorkflow()` | `client.workflows.run()`, defaults `wait: true` |
| `useFunctions()` | `client.functions.list()` |
| `useFunction(id)` | `client.functions.get()` |
| `useCreateFunction()` | `client.functions.create()` |
| `useUpdateFunction()` | `client.functions.update()` |
| `useDeleteFunction()` | `client.functions.delete()` |
| `useRun()` | `client.run()` (the generic URN dispatch) |

Three things the definition hooks inherit from the SDK rather than invent:

- **`create` mints the id.** The server requires one in the body and never
  generates it, so `useCreateWorkflow().call({name, steps})` works and the
  `wf_…` / `fn_…` id comes back in the result.
- **`update` is a full replacement, not a patch.** This is the one place they
  differ from `useUpdateDocument`/`useUpdateVar`, whose second argument is a
  patch of just the fields to change. Read with `useWorkflow`/`useFunction`,
  spread, change, send the whole thing back — passing only the changed fields
  deletes the rest. `useUpdateWorkflow()`'s third argument carries
  `ifUnmodifiedSince`: hand it the `updatedAt` from `useWorkflow` and a save
  that would clobber someone else's edit is refused with `409 workflow_stale`
  rather than winning silently.
- **Deleting a workflow is two calls**, `useArchiveWorkflow` then
  `useDeleteWorkflow`. Nothing chains them for you: the archive step is the one
  a user can still change their mind after.

No mutation hook refetches a list on success — this package carries no cache to
invalidate, so pair one with the matching read hook's own `refetch`.

`client.functions.run()` has **no** hook, and neither does `endpoints.run()` —
that predates the definition hooks and is unchanged by them. `useRun()` reaches
a Function by its `fn_…` id today (the server dispatches it through the same
service the dedicated invoke route uses); calling one by the `key` a user gave
it still means `useW6WClient().functions.run("send-email", …)`.

`useRunWorkflow()`'s `call` defaults `wait: true` when the caller's options omit
`wait`: `workflows.run` without `wait` (`node/src/workflows.ts`) leaves the caller
with only a `runId` and no public polling operation to follow it with —
`console.workflows.getRun` exists, but it is the same studio-internal, unstable
surface described above, so this hook does not reach for it. Pass `wait: false`
explicitly if you genuinely want the queued-and-walk-away behaviour.

`useW6WClient()` returns the underlying `W6WClient` for anything not covered by a
hook (e.g. `client.console.*` directly, at your own risk per the caveat above).

## Known limitations

- **`getAppActions`'s declared `ActionDef.params` type is a strict field subset of
  `@w6w/ui`'s richer `ActionParam`.** `@w6w/sdk/console`'s `ActionParam` carries 6
  fields (`key, label, type, required, default, hint`); `@w6w/ui`'s carries 14 more,
  presentation-only fields (`placeholder, advanced, row, item, showIf, options,
  config, children, section, title, subtitle, layout, collapsed`). This typechecks
  fine — every extra field is optional — and there is no runtime data loss (the JSON
  payload is unfiltered); a caller typing a variable through this adapter's declared
  return type just gets no autocomplete for those extra fields.
- **`ActionTestForm.tsx:149,176`'s error handling cannot be satisfied from this
  package.** `@w6w/ui`'s `ActionTestForm` does a NOMINAL `instanceof ApiError` check
  against its OWN `ApiError` class (`packages/ui/src/createW6WApi.ts`), not a
  duck-typed one. No error object this adapter throws can ever satisfy that check
  without importing `@w6w/ui`'s class directly, which this package's MIT/C-1
  boundary forbids. Concretely: on a failed `invokeAction` used together with
  `@w6w/ui`'s `ActionTestForm`, the 401/403 permission-hint messaging falls back to a
  generic message, and the `ApiCallsPanel` egress log renders empty instead of
  showing the outbound calls the action made — even though this adapter's thrown
  error genuinely carries that data on `.body`/`.raw`. This adapter still aliases
  `@w6w/sdk`'s `ApiError.raw` onto `.body` (`err.body === err.raw`) and sets
  `err.name = "ApiError"`, so it is already correct for any DUCK-TYPING consumer, and
  needs no further change the moment `@w6w/ui` switches its own check to one. The fix
  belongs to `@w6w/ui`, not this package, and is filed there:
  `.ai/projects/backlog/26-08-13-01-ui-error-nominal-check.md`.
- **No `AbortSignal`/cancellation support in the hook set.** `@w6w/sdk`'s transport
  (`node/src/http.ts`) has nothing to hook an abort into. A read hook only IGNORES a
  result that resolves after its component unmounts (a mounted-ref guard); it cannot
  cancel the in-flight request itself.
