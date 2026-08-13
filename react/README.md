# @w6w/react

React bindings for [`@w6w/sdk`](../node) — a `<W6wProvider>` that holds one memoized
`W6wClient` with per-request token freshness, a small hook set over the SDK's public
surface (`me`, `documents`, `vars`, `connections`, `workflows`, `run`), and
`createW6wUiAdapter`, a structural bridge from a `W6wClient` to
[`@w6w/ui`](https://github.com/w6w-io/w6w-ui)'s `W6wApi` contract.

License: MIT · Version: 0.3.0

This lane implements no endpoint — it composes `@w6w/sdk`, which is already
conformant against [`endpoints.json`](../endpoints.json). There is nothing here to
re-verify against the wire contract; verify `@w6w/sdk` instead.

## Install

```bash
npm install @w6w/react react
```

`react-dom` is not a dependency of this package — `<W6wProvider>`'s only JSX is a
context wrapper (`<Ctx.Provider>`), never a DOM element of its own. Your app already
depends on `react-dom` to mount itself; nothing extra is needed here.

## Quick start

Wrap your app root once:

```tsx
import { W6wProvider } from "@w6w/react";

function App() {
  return (
    <W6wProvider baseUrl="https://api.example.com" token={() => getCurrentJwt()}>
      <YourApp />
    </W6wProvider>
  );
}
```

`token` accepts a literal string, or a supplier function called fresh on every
request — pass a supplier when your token rotates (e.g. a short-lived JWT read from
an auth SDK) and the client will pick up the new value on the very next call, with no
teardown/rebuild of the underlying `W6wClient`. See `src/W6wProvider.tsx`'s module
header for the exact mechanism (the C-4 shim).

Then, anywhere under the provider:

```tsx
import { useDocuments, useW6wClient } from "@w6w/react";

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
`W6wApi` object through their own `<W6wUIProvider api={...}>`. Build one from your
`@w6w/react` client with `createW6wUiAdapter`:

```tsx
import { createW6wUiAdapter, useW6wClient, W6wProvider } from "@w6w/react";
import { W6wUIProvider, AppPicker } from "@w6w/ui";

function UiBridge({ children }: { children: React.ReactNode }) {
  const client = useW6wClient();
  const api = useMemo(() => createW6wUiAdapter(client), [client]);
  return <W6wUIProvider api={api}>{children}</W6wUIProvider>;
}

function App() {
  return (
    <W6wProvider baseUrl="https://api.example.com" token={jwtSupplier}>
      <UiBridge>
        <AppPicker onPick={(appId) => console.log(appId)} />
      </UiBridge>
    </W6wProvider>
  );
}
```

**`@w6w/ui` is not on npm today.** The `@w6w` scope holds only `@w6w/sdk` and
`@w6w/cli` at the time of writing (`npm view @w6w/ui` → 404); the source itself IS a
public GitHub repository (`w6w-io/w6w-ui`). `createW6wUiAdapter`'s `W6wApi` return
type targets that contract *structurally* — this package names `@w6w/ui` nowhere in
its own manifest and needs no change whenever `@w6w/ui` becomes reachable another
way (this monorepo, a `git+https://` dependency on the public repo, or a private
registry). This is an honest statement of today's install story, not a promise that
`npm i @w6w/ui` resolves.

`createW6wUiAdapter` is built entirely on `@w6w/sdk/console` — the SAME namespace
`packages/studio`'s own facade uses for these routes (`packages/ui/src/createW6wApi.ts`
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
| `useRunWorkflow()` | `client.workflows.run()`, defaults `wait: true` |
| `useRun()` | `client.run()` (the generic URN dispatch) |

`useRunWorkflow()`'s `call` defaults `wait: true` when the caller's options omit
`wait`: `workflows.run` without `wait` (`node/src/workflows.ts`) leaves the caller
with only a `runId` and no public polling operation to follow it with —
`console.workflows.getRun` exists, but it is the same studio-internal, unstable
surface described above, so this hook does not reach for it. Pass `wait: false`
explicitly if you genuinely want the queued-and-walk-away behaviour.

`useW6wClient()` returns the underlying `W6wClient` for anything not covered by a
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
  against its OWN `ApiError` class (`packages/ui/src/createW6wApi.ts`), not a
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
