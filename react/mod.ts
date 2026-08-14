/**
 * `@w6w/react` — the package barrel.
 *
 * A thin React binding over `@w6w/sdk`: `<W6WProvider>` (the C-4
 * token-supplier shim), a small hook set, and `createW6WUiAdapter` (the
 * `@w6w/ui` `W6WApi` structural bridge, C-1/C-2). See `README.md` for the
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
  useW6WClient,
  W6WProvider,
  type W6WProviderProps,
} from "./src/W6WProvider.tsx";

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

export { createW6WUiAdapter, type W6WApi } from "./src/adapter.ts";
