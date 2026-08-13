/**
 * `@w6w/react` — the package barrel.
 *
 * A thin React binding over `@w6w/sdk`: `<W6wProvider>` (the C-4
 * token-supplier shim), a small hook set, and `createW6wUiAdapter` (the
 * `@w6w/ui` `W6wApi` structural bridge, C-1/C-2). See `README.md` for the
 * install + wrap-your-root example, the hooks catalog, and this lane's
 * documented limitations.
 *
 * Every public export lives here — a symbol this file does not re-export is
 * not part of the published surface.
 *
 * @module
 */

export { VERSION } from "./src/version.ts";

export {
  type TokenSource,
  useW6wClient,
  W6wProvider,
  type W6wProviderProps,
} from "./src/W6wProvider.tsx";

export {
  type MutationResult,
  type ReadResult,
  useConnections,
  useCreateDocument,
  useCreateVar,
  useDeleteDocument,
  useDeleteVar,
  useDocument,
  useDocumentByKey,
  useDocuments,
  useMe,
  useRun,
  useRunWorkflow,
  useUpdateDocument,
  useUpdateVar,
  useVar,
  useVars,
  useWorkflows,
} from "./src/hooks.ts";

export { createW6wUiAdapter, type W6wApi } from "./src/adapter.ts";
