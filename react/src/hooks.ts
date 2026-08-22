/**
 * The hook set — one small primitive underneath (`useAsync` / a private
 * mutation primitive), every read/mutation hook a thin wrapper over
 * `useW6WClient()`. No react-query or any other data-fetching dependency
 * anywhere (`package.json` carries none — see README).
 *
 * Built only over the PUBLIC, non-`console` surface (`me`, `documents`,
 * `vars`, `connections`, `workflows`, `functions`, `run`) — `console.*` is
 * studio-internal and unstable (see README), so no hook here reaches for it.
 * The workflow and Function definition lifecycles moved onto that public
 * surface at contract `0.5.0`, which is why hooks for them live here now
 * rather than being unreachable without `console.*`.
 *
 * Cancellation: `@w6w/sdk`'s transport has no `AbortSignal` to hook into
 * (`node/src/http.ts`), so a read hook can only IGNORE a result that resolves
 * after unmount (the `mountedRef` guard below), never truly abort the
 * in-flight request. See README.
 *
 * @module
 */
import type {
  ConnectionSummary,
  Doc,
  DocumentCreateInput,
  DocumentOptions,
  DocumentPatch,
  FunctionDefinition,
  FunctionDetail,
  FunctionSummary,
  Me,
  RunEnvelope,
  RunInput,
  Var,
  VarCreateInput,
  VarPatch,
  WorkflowDefinition,
  WorkflowDetail,
  WorkflowListOptions,
  WorkflowRunOptions,
  WorkflowRunResult,
  WorkflowSaveResult,
  WorkflowSummary,
  WorkflowWriteOptions,
} from "@w6w/sdk";
import { useCallback, useEffect, useRef, useState } from "react";
import { useW6WClient } from "./W6WProvider.tsx";

/** What every read hook returns. */
export interface ReadResult<T> {
  /** The last successfully fetched value, or `undefined` before the first resolves. */
  data: T | undefined;
  /** The error the last fetch rejected with, or `undefined`. */
  error: unknown;
  /** `true` while a fetch is in flight (including one triggered by `refetch`). */
  loading: boolean;
  /** Re-run the fetch imperatively. */
  refetch: () => void;
}

/** What every mutation hook returns. */
export interface MutationResult<Args extends unknown[], T> {
  /** Perform the mutation. Resolves with the result; rejects rather than swallowing an error. */
  call: (...args: Args) => Promise<T>;
  /** The last successful result, or `undefined`. */
  data: T | undefined;
  /** The error the last call rejected with, or `undefined`. */
  error: unknown;
  /** `true` while a call is in flight. */
  loading: boolean;
}

interface AsyncState<T> {
  data: T | undefined;
  error: unknown;
  loading: boolean;
}

/**
 * Shared plumbing behind every read hook: fetch once on mount, expose
 * `refetch` for an imperative re-fetch, and drop a result that resolves after
 * unmount. `fetcher` must be a `useCallback`-stabilized function — each hook
 * below owns that decision by listing exactly the values its own fetch
 * depends on, so this primitive's own dependency array (`[fetcher]`) stays
 * exhaustive and needs no lint override.
 */
function useAsync<T>(fetcher: () => Promise<T>): ReadResult<T> {
  const [state, setState] = useState<AsyncState<T>>({
    data: undefined,
    error: undefined,
    loading: true,
  });
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refetch = useCallback(() => {
    setState((s) => ({ ...s, loading: true }));
    fetcher().then(
      (data) => {
        if (mountedRef.current) setState({ data, error: undefined, loading: false });
      },
      (error: unknown) => {
        if (mountedRef.current) setState({ data: undefined, error, loading: false });
      },
    );
  }, [fetcher]);

  useEffect(() => {
    refetch();
  }, [refetch]);

  return { data: state.data, error: state.error, loading: state.loading, refetch };
}

/**
 * Shared plumbing behind every mutation hook: imperative only, no auto-fetch.
 * `mutator` is read through a "latest" ref (updated every render, never a
 * `useCallback` dependency) so `call`'s own identity stays stable across
 * renders without ever invoking a stale closure.
 */
function useMutationResource<Args extends unknown[], T>(
  mutator: (...args: Args) => Promise<T>,
): MutationResult<Args, T> {
  const [state, setState] = useState<AsyncState<T>>({
    data: undefined,
    error: undefined,
    loading: false,
  });
  const mutatorRef = useRef(mutator);
  mutatorRef.current = mutator;

  const call = useCallback(async (...args: Args): Promise<T> => {
    setState({ data: undefined, error: undefined, loading: true });
    try {
      const data = await mutatorRef.current(...args);
      setState({ data, error: undefined, loading: false });
      return data;
    } catch (error) {
      setState({ data: undefined, error, loading: false });
      throw error;
    }
  }, []);

  return { call, data: state.data, error: state.error, loading: state.loading };
}

// ── reads ────────────────────────────────────────────────────────────────

export function useMe(): ReadResult<Me> {
  const client = useW6WClient();
  const fetcher = useCallback(() => client.me(), [client]);
  return useAsync(fetcher);
}

export function useDocuments(options?: DocumentOptions): ReadResult<Doc[]> {
  const client = useW6WClient();
  const project = options?.project;
  const fetcher = useCallback(
    () => client.documents.list(project === undefined ? undefined : { project }),
    [client, project],
  );
  return useAsync(fetcher);
}

export function useDocument(id: string, options?: DocumentOptions): ReadResult<Doc> {
  const client = useW6WClient();
  const project = options?.project;
  const fetcher = useCallback(
    () => client.documents.get(id, project === undefined ? undefined : { project }),
    [client, id, project],
  );
  return useAsync(fetcher);
}

export function useDocumentByKey(key: string, options?: DocumentOptions): ReadResult<Doc> {
  const client = useW6WClient();
  const project = options?.project;
  const fetcher = useCallback(
    () => client.documents.getByKey(key, project === undefined ? undefined : { project }),
    [client, key, project],
  );
  return useAsync(fetcher);
}

export function useVars(): ReadResult<Var[]> {
  const client = useW6WClient();
  const fetcher = useCallback(() => client.vars.list(), [client]);
  return useAsync(fetcher);
}

export function useVar(id: string): ReadResult<Var> {
  const client = useW6WClient();
  const fetcher = useCallback(() => client.vars.get(id), [client, id]);
  return useAsync(fetcher);
}

export function useConnections(): ReadResult<ConnectionSummary[]> {
  const client = useW6WClient();
  const fetcher = useCallback(() => client.connections.list(), [client]);
  return useAsync(fetcher);
}

export function useWorkflows(options?: WorkflowListOptions): ReadResult<WorkflowSummary[]> {
  const client = useW6WClient();
  const project = options?.project;
  const fetcher = useCallback(
    () => client.workflows.list(project === undefined ? undefined : { project }),
    [client, project],
  );
  return useAsync(fetcher);
}

/**
 * One workflow's stored definition, plus the two things that are not in it.
 *
 * `data.updatedAt` is the optimistic-concurrency token: hand it to
 * {@linkcode useUpdateWorkflow}'s `ifUnmodifiedSince` and a save that would
 * clobber someone else's edit is refused instead of winning silently. That is
 * the whole reason this is a read hook and not just a fetch — the token has to
 * survive from the read to the write, and a component that re-reads on every
 * render would keep handing itself a fresh one.
 */
export function useWorkflow(id: string): ReadResult<WorkflowDetail> {
  const client = useW6WClient();
  const fetcher = useCallback(() => client.workflows.get(id), [client, id]);
  return useAsync(fetcher);
}

export function useFunctions(): ReadResult<FunctionSummary[]> {
  const client = useW6WClient();
  const fetcher = useCallback(() => client.functions.list(), [client]);
  return useAsync(fetcher);
}

export function useFunction(id: string): ReadResult<FunctionDetail> {
  const client = useW6WClient();
  const fetcher = useCallback(() => client.functions.get(id), [client, id]);
  return useAsync(fetcher);
}

// ── mutations ────────────────────────────────────────────────────────────

export function useCreateDocument(): MutationResult<[DocumentCreateInput, DocumentOptions?], Doc> {
  const client = useW6WClient();
  return useMutationResource((input: DocumentCreateInput, options?: DocumentOptions) =>
    client.documents.create(input, options),
  );
}

export function useUpdateDocument(): MutationResult<
  [string, DocumentPatch, DocumentOptions?],
  Doc
> {
  const client = useW6WClient();
  return useMutationResource((id: string, patch: DocumentPatch, options?: DocumentOptions) =>
    client.documents.update(id, patch, options),
  );
}

export function useDeleteDocument(): MutationResult<[string, DocumentOptions?], void> {
  const client = useW6WClient();
  return useMutationResource((id: string, options?: DocumentOptions) =>
    client.documents.delete(id, options),
  );
}

export function useCreateVar(): MutationResult<[VarCreateInput], Var> {
  const client = useW6WClient();
  return useMutationResource((input: VarCreateInput) => client.vars.create(input));
}

export function useUpdateVar(): MutationResult<[string, VarPatch], Var> {
  const client = useW6WClient();
  return useMutationResource((id: string, patch: VarPatch) => client.vars.update(id, patch));
}

export function useDeleteVar(): MutationResult<[string], void> {
  const client = useW6WClient();
  return useMutationResource((id: string) => client.vars.delete(id));
}

/**
 * `wait` defaults to `true` when the caller's options omit it. `workflows.run`
 * without `wait` (`node/src/workflows.ts`) leaves the caller with only a
 * `runId` and no public polling operation to follow it with —
 * `console.workflows.getRun` exists, but it is studio-internal and unstable
 * (see README), so this hook does not reach for it. A caller that genuinely
 * wants the queued-and-walk-away behaviour can still pass `wait: false`
 * explicitly; the default only fills in what the caller left unstated.
 */
export function useRunWorkflow(): MutationResult<[string, WorkflowRunOptions?], WorkflowRunResult> {
  const client = useW6WClient();
  return useMutationResource((id: string, options?: WorkflowRunOptions) =>
    client.workflows.run(id, { ...options, wait: options?.wait ?? true }),
  );
}

export function useRun(): MutationResult<[RunInput], RunEnvelope> {
  const client = useW6WClient();
  return useMutationResource((input: RunInput) => client.run(input));
}

/**
 * ── The definition lifecycle ──
 *
 * Ten hooks over the same ten SDK methods, and three properties they inherit
 * from it rather than invent:
 *
 * 1. **`create` mints the id.** The server requires one in the body and never
 *    generates it, so `create({name, steps})` works and the `wf_…`/`fn_…` id
 *    comes back in the result.
 * 2. **`update` is a full replacement, not a patch.** This is the one place
 *    these differ from `useUpdateDocument`/`useUpdateVar`, whose second
 *    argument is a `Patch` of the fields to change. Here it is the whole
 *    definition: read with {@linkcode useWorkflow} / {@linkcode useFunction},
 *    spread, change, send. A component that passed only the changed fields
 *    would delete the rest.
 * 3. **Deleting a workflow is two calls**, `archive` then `delete`. No hook
 *    here chains them — a UI that offers "delete" should offer the archive
 *    step too, because that is the step a user can still change their mind
 *    after.
 *
 * None of them refetch a list on success, matching every other mutation hook
 * in this file: this lane carries no cache to invalidate (no react-query, by
 * design — see README), so a component pairs the mutation with the read hook's
 * own `refetch`.
 */
export function useCreateWorkflow(): MutationResult<
  [WorkflowDefinition, WorkflowWriteOptions?],
  WorkflowSaveResult
> {
  const client = useW6WClient();
  return useMutationResource((definition: WorkflowDefinition, options?: WorkflowWriteOptions) =>
    client.workflows.create(definition, options),
  );
}

export function useUpdateWorkflow(): MutationResult<
  [string, WorkflowDefinition, WorkflowWriteOptions?],
  WorkflowSaveResult
> {
  const client = useW6WClient();
  return useMutationResource(
    (id: string, definition: WorkflowDefinition, options?: WorkflowWriteOptions) =>
      client.workflows.update(id, definition, options),
  );
}

export function useArchiveWorkflow(): MutationResult<[string], WorkflowDefinition> {
  const client = useW6WClient();
  return useMutationResource((id: string) => client.workflows.archive(id));
}

export function useDeleteWorkflow(): MutationResult<[string], void> {
  const client = useW6WClient();
  return useMutationResource((id: string) => client.workflows.delete(id));
}

export function useCreateFunction(): MutationResult<
  [FunctionDefinition],
  { id: string; key: string }
> {
  const client = useW6WClient();
  return useMutationResource((definition: FunctionDefinition) =>
    client.functions.create(definition),
  );
}

export function useUpdateFunction(): MutationResult<
  [string, FunctionDefinition],
  { id: string; key: string }
> {
  const client = useW6WClient();
  return useMutationResource((id: string, definition: FunctionDefinition) =>
    client.functions.update(id, definition),
  );
}

export function useDeleteFunction(): MutationResult<[string], void> {
  const client = useW6WClient();
  return useMutationResource((id: string) => client.functions.delete(id));
}
