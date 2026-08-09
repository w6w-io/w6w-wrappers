/**
 * `@w6w/sdk/console` — the console-only namespace group.
 *
 * A **second, separate** entry point from the package's root (`@w6w/sdk`),
 * built on the same transport (`../http.ts`, `../errors.ts`, `../config.ts`)
 * but deliberately EXCLUDED from `endpoints.json`'s `operations[]` and from
 * the root barrel (`../../mod.ts`) — see `docs/console.md` and HITL-1 in this
 * task's contract. `client.console` is instance state exactly like every other
 * namespace on `W6wClient` (`docs/implementation.md` §MECHANISM PIN —
 * instance state, never globals): it holds the host it was constructed with
 * and nothing of its own.
 *
 * This file is the append point for the console surface's later phases: each
 * new console domain gets one `this.<domain> = new <Domain>Api(host)` line
 * here, mirroring `reliability` below, rather than being folded into
 * `../client.ts` directly.
 *
 * @module
 */

import type { HttpResponse, RequestOptions } from "../http.ts";
import { AppsApi } from "./apps.ts";
import { AuthApi } from "./auth.ts";
import { ConnectionsApi } from "./connections.ts";
import { DashboardApi } from "./dashboard.ts";
import { ReliabilityApi } from "./reliability.ts";
import { ProjectsApi } from "./projects.ts";
import { SchedulesApi } from "./schedules.ts";
import { WorkflowsApi } from "./workflows.ts";

export { AuthApi } from "./auth.ts";
export type {
  AccountWire,
  AuthHost,
  CreateAccountResponse,
  LoginResponse,
  SignupInput,
  SignupResponse,
  SignupUser,
  SlugAvailabilityResponse,
  User,
} from "./auth.ts";
export { DashboardApi } from "./dashboard.ts";
export type { DashboardHost, DashboardStats, DashboardStatsParams } from "./dashboard.ts";
export { ReliabilityApi } from "./reliability.ts";
export type {
  ReliabilityErrorMix,
  ReliabilityHost,
  ReliabilityService,
  ReliabilityServices,
  ReliabilityState,
  ReliabilityUptimeDay,
  ReliabilityVendorStatus,
} from "./reliability.ts";
export { ProjectsApi } from "./projects.ts";
export type { Project, ProjectsHost } from "./projects.ts";
export { SchedulesApi } from "./schedules.ts";
export type { Schedule, SchedulesHost, ScheduleUpsertInput } from "./schedules.ts";
export { AppsApi } from "./apps.ts";
export type {
  ActionDef,
  ActionParam,
  ApiCallRecord,
  AppDetail,
  AppHealthStatus,
  AppsHost,
  AppSummary,
  AuthDef,
  AuthField,
  CredentialPosture,
  HealthCheckMeta,
  HealthKind,
  HealthQuota,
  HealthReport,
  HealthResult,
  HealthScope,
  HealthSeverity,
  HealthState,
  ImportResponse,
  OAuthConfigSummary,
  PackEntryPreview,
  PackPreviewInfo,
  PreviewSourceResponse,
  RefreshAppResponse,
  TriggerDef,
  UpsertOAuthConfigInput,
} from "./apps.ts";
export { ConnectionsApi } from "./connections.ts";
export type { ConnectionsHost, ConnectionTestResult } from "./connections.ts";
export { WorkflowsApi } from "./workflows.ts";
export type { RunState, RunSummary, WorkflowsHost } from "./workflows.ts";

/**
 * The slice of `W6wClient` the console namespace group needs: the transport,
 * and nothing else. Structural rather than a concrete client type, so
 * `ConsoleApi` stays independently constructible in a test and this module
 * never imports the client back.
 */
export interface ConsoleHost {
  /** Perform one request. */
  request<T>(options: RequestOptions): Promise<HttpResponse<T>>;
}

/**
 * The `console` namespace group on a `W6wClient` — studio-internal, not part
 * of the published partner contract.
 *
 * @example
 * ```ts
 * const board = await client.console.reliability.list(30, 5);
 * ```
 */
export class ConsoleApi {
  /** `console.reliability.*`. */
  readonly reliability: ReliabilityApi;
  /** `console.auth.*`. */
  readonly auth: AuthApi;
  /** `console.dashboard.*`. */
  readonly dashboard: DashboardApi;
  /** `console.projects.*`. */
  readonly projects: ProjectsApi;
  /** `console.schedules.*`. */
  readonly schedules: SchedulesApi;
  /** `console.apps.*`. */
  readonly apps: AppsApi;
  /** `console.connections.*`. */
  readonly connections: ConnectionsApi;
  /** `console.workflows.*`. */
  readonly workflows: WorkflowsApi;

  /**
   * @param host - The client this namespace group issues requests through.
   */
  constructor(host: ConsoleHost) {
    this.reliability = new ReliabilityApi(host);
    this.auth = new AuthApi(host);
    this.dashboard = new DashboardApi(host);
    this.projects = new ProjectsApi(host);
    this.schedules = new SchedulesApi(host);
    this.apps = new AppsApi(host);
    this.connections = new ConnectionsApi(host);
    this.workflows = new WorkflowsApi(host);
  }
}
