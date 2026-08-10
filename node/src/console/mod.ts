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
import { ApiCallsApi } from "./api-calls.ts";
import { AppsApi } from "./apps.ts";
import { AuthApi } from "./auth.ts";
import { ConnectionsApi } from "./connections.ts";
import { DashboardApi } from "./dashboard.ts";
import { EndpointsApi } from "./endpoints.ts";
import { FunctionsApi } from "./functions.ts";
import { ReliabilityApi } from "./reliability.ts";
import { ProjectsApi } from "./projects.ts";
import { SavedTestsApi } from "./saved-tests.ts";
import { SchedulesApi } from "./schedules.ts";
import { StepTestsApi } from "./step-tests.ts";
import { SubscriptionsApi } from "./subscriptions.ts";
import { TenantOAuthAppsApi } from "./tenant-oauth-apps.ts";
import { TokensApi } from "./tokens.ts";
import { VaultApi } from "./vault.ts";
import { WorkflowsApi } from "./workflows.ts";

export { AuthApi } from "./auth.ts";
export type {
  AccountWire,
  AuthHost,
  ConsoleMe,
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
export { SavedTestsApi } from "./saved-tests.ts";
export type { SavedTest, SavedTestRun, SavedTestsHost, TestRunSummary } from "./saved-tests.ts";
export { StepTestsApi } from "./step-tests.ts";
export type { StepTest, StepTestRun, StepTestsHost } from "./step-tests.ts";
export { VaultApi } from "./vault.ts";
export type { SecretValue, VaultHost, VaultSecretSummary } from "./vault.ts";
export { TokensApi } from "./tokens.ts";
export type { ApiToken, ApiTokenStatus, CreateTokenResponse, TokensHost } from "./tokens.ts";
export { FunctionsApi } from "./functions.ts";
export type {
  FunctionDef,
  FunctionImpl,
  FunctionInput,
  FunctionOutputField,
  FunctionsHost,
  FunctionSummary,
} from "./functions.ts";
export { EndpointsApi, SECRET_MASK } from "./endpoints.ts";
export type {
  ActionTarget,
  Callable,
  EndpointAuthMode,
  EndpointDef,
  EndpointInput,
  EndpointInvokeResult,
  EndpointSecurity,
  EndpointsHost,
  EndpointSummary,
  EndpointTarget,
  Exposure,
} from "./endpoints.ts";
export { SubscriptionsApi } from "./subscriptions.ts";
export type {
  Subscription,
  SubscriptionCreateInput,
  SubscriptionsHost,
  TriggerEventStatus,
  TriggerEventSummary,
} from "./subscriptions.ts";
export { ApiCallsApi } from "./api-calls.ts";
export type { ApiCallsFilter, ApiCallsHost } from "./api-calls.ts";
export { TenantOAuthAppsApi } from "./tenant-oauth-apps.ts";
export type {
  SetTenantOAuthAppInput,
  TenantOAuthAppsHost,
  TenantOAuthAppsResponse,
  TenantOAuthAppSummary,
} from "./tenant-oauth-apps.ts";

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
  /** `console.savedTests.*`. */
  readonly savedTests: SavedTestsApi;
  /** `console.stepTests.*`. */
  readonly stepTests: StepTestsApi;
  /** `console.vault.*`. */
  readonly vault: VaultApi;
  /** `console.tokens.*`. */
  readonly tokens: TokensApi;
  /** `console.functions.*`. */
  readonly functions: FunctionsApi;
  /** `console.endpoints.*`. */
  readonly endpoints: EndpointsApi;
  /** `console.subscriptions.*`. */
  readonly subscriptions: SubscriptionsApi;
  /** `console.apiCalls.*`. */
  readonly apiCalls: ApiCallsApi;
  /** `console.tenantOAuthApps.*` — the caller's OWN tenant, never a tenant of its choosing. */
  readonly tenantOAuthApps: TenantOAuthAppsApi;

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
    this.savedTests = new SavedTestsApi(host);
    this.stepTests = new StepTestsApi(host);
    this.vault = new VaultApi(host);
    this.tokens = new TokensApi(host);
    this.functions = new FunctionsApi(host);
    this.endpoints = new EndpointsApi(host);
    this.subscriptions = new SubscriptionsApi(host);
    this.apiCalls = new ApiCallsApi(host);
    this.tenantOAuthApps = new TenantOAuthAppsApi(host);
  }
}
