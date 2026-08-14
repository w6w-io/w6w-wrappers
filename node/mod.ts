/**
 * `@w6w/sdk` — the package barrel.
 *
 * This file is the package's single public entry point. `deno.json` exports it to
 * JSR as `./mod.ts` (TypeScript source, verbatim) and `tsconfig.build.json`
 * compiles it to `dist/mod.js` + `dist/mod.d.ts` for npm. One authored source
 * tree, two registries (D7).
 *
 * **Every operation module must be re-exported here.** A module that is not
 * re-exported from this barrel is not part of the published surface: JSR and npm
 * consumers can only reach what this file exports, and the conformance runner
 * walks the client built from these exports. Adding an operation therefore means
 * adding its export line here in the same change.
 *
 * @module
 */

export { VERSION } from "./src/version.ts";

// Transport core (T2.1.2): the client, its configuration and the error model.
export { W6WClient } from "./src/client.ts";
export { ApiError, ConfigError } from "./src/errors.ts";
export {
  BASE_PATH,
  type FetchLike,
  joinBaseUrl,
  type ResolvedConfig,
  type W6WClientOptions,
} from "./src/config.ts";
export type { HttpMethod, HttpResponse, QueryParams, RequestOptions } from "./src/http.ts";
// Exported because `W6WClient.request` is public: a host reaching an endpoint
// this version does not model yet must have the same encoding-at-interpolation
// tag the operation modules use, or it will concatenate a caller value into a
// path by hand — the one bug the encoding pin exists to prevent.
export { path } from "./src/http.ts";

// Asset operations (T2.1.3): documents and vars. The namespace classes are
// exported alongside their input types because a host that types a helper
// around `client.documents` needs to name them; they are reached through a
// client, never constructed directly.
export { DocumentsApi } from "./src/documents.ts";
export type {
  DocumentCreateInput,
  DocumentOptions,
  DocumentPatch,
  DocumentsHost,
} from "./src/documents.ts";
export { VarsApi } from "./src/vars.ts";
export type { VarCreateInput, VarPatch, VarsHost } from "./src/vars.ts";

// Identity and discovery (T2.1.4): `me`, plus the two list operations that make
// a `conn_…` / `wf_…` id discoverable in the first place (D4). `me` is a method
// on the client, so what is exported here is its host interface and the
// standalone function the client delegates to — a host wiring its own transport
// can call it without constructing a client.
export { fetchMe } from "./src/me.ts";
export type { MeHost } from "./src/me.ts";
export { ConnectionsApi } from "./src/connections.ts";
export type { ConnectionsHost } from "./src/connections.ts";
export { WorkflowsApi } from "./src/workflows.ts";
export type {
  WorkflowListOptions,
  WorkflowRunOptions,
  WorkflowRunResult,
  WorkflowsHost,
} from "./src/workflows.ts";

// Execution (T2.1.5): the URN-addressed `run`. `client.run(input)` is a method
// on the client, so what is exported is its host interface, its input type and
// the standalone function the client delegates to.
export { runUrn } from "./src/run.ts";
export type { RunHost, RunInput } from "./src/run.ts";

// The `kind` discriminators. Exported deliberately and not as an afterthought:
// `RunEnvelope`'s fourth arm is open (so an unknown `kind` can be handed back
// rather than raised), and an open union means a bare `env.kind === "workflow"`
// check does NOT narrow — `env.status` would come out `unknown`. These
// predicates are how a caller, and the CLI, get typed access to an arm.
export { isActionRun, isFunctionRun, isTerminalRunStatus, isWorkflowRun } from "./src/types.ts";

export type {
  ActionRunEnvelope,
  ConnectionState,
  ConnectionSummary,
  Doc,
  DocFormat,
  FunctionRunEnvelope,
  Me,
  RunEnvelope,
  RunResult,
  RunStatus,
  StepError,
  UnknownRunEnvelope,
  Var,
  VarType,
  WorkflowRunEnvelope,
  WorkflowStatus,
  WorkflowSummary,
} from "./src/types.ts";
