/**
 * `client.console.apps.*` — the app catalog (install, inspect, invoke,
 * per-installation OAuth config), relocated from the studio's own API
 * client.
 *
 * **Studio-internal, not the published partner contract.** This namespace
 * lives under the `console` subpath export (`@w6w/sdk/console`), excluded from
 * `endpoints.json` and from the root barrel (`mod.ts`) — see `docs/console.md`
 * and HITL-1 in this task's contract. `@w6w/sdk`'s instance-state mechanism
 * pin still applies here exactly as it does to every other namespace
 * (`docs/implementation.md` §MECHANISM PIN — instance state, never globals):
 * this class holds no state of its own beyond the injected host, so two
 * clients in one process never share a credential.
 *
 * **The largest single domain in this project** — 16 methods, relocated from
 * `packages/studio/src/api/client.ts`'s single `// Apps` comment block
 * (`client.ts:235-393` on the studio base tree). Method names below are
 * SHORTENED (dropping the `App`/`Apps` prefix `client.ts`'s flat method names
 * carry) to match `console.projects`'s/`console.schedules`'s own short-verb
 * convention — a naming-only change: every wire call (method/path/body/query)
 * is unchanged.
 *
 * **`listApiCalls` is deliberately NOT modeled here** — it lives under the
 * same `client.ts` comment block but has no named apps-domain consumer (its
 * only caller is reliability's drill-down page); it groups with a future
 * `reliability`+`api-calls` sub-project instead. See this task's contract
 * Requirement and `plan.md`'s FINDINGS DISPOSITION.
 *
 * **Two live server routes with zero client-side coverage ever are also
 * excluded**: `DELETE /apps/:id/versions/:version` and
 * `PATCH /apps/:id/lifecycle` — both `requireOperator`-gated, neither was ever
 * wrapped in `client.ts` at all (not just zero callers). `requireOperator`
 * otherwise has no bearing on this file: access control is unaffected by this
 * relocation — every route reachable through `console.*` (this domain
 * included) requires only an authenticated principal client-side, and the
 * console/partner split is a naming and export-surface fence, not an
 * authorization boundary. The methods below that DO happen to hit a
 * `requireOperator` route server-side (`listOAuthConfig`,
 * `upsertOAuthConfig`, `deleteOAuthConfig`, `preview`, `refresh`) still send
 * the request the same way as every other method here; a non-operator caller
 * simply gets a `403` back from the server like any other `ApiError`.
 *
 * **Four methods are HITL-4 dead code** — `getHealth`, `listOAuthConfig`,
 * `upsertOAuthConfig`, `deleteOAuthConfig` have zero call sites anywhere in
 * studio or `@w6w/ui`. They are still built to full type fidelity (real
 * implementation, JSDoc, `@throws`) for SDK/wrapper coverage; only the test
 * bar for them is deliberately lighter.
 *
 * **`delete`'s return value is a deliberate asymmetry** vs. `projects.delete`
 * and `schedules.delete` in this same package: those two discard the server's
 * uninformative `{ok: true}` and resolve `void`. This app-catalog delete does
 * NOT — the server answers `{removed: number}`, a genuinely informative count
 * (`apps-catalog.ts:646-651`), and this method preserves it instead of
 * "fixing" it to match the other two.
 *
 * None of these 16 methods take a `project` scoping parameter — apps operate
 * at the account/global level — so `AppsHost` needs only the transport,
 * mirroring `VarsHost`/`ProjectsHost`, not `DocumentsHost`.
 *
 * @module
 */

import { type HttpResponse, path, type RequestOptions } from "../http.ts";
import { unwrap } from "../types.ts";

/**
 * The slice of `W6WClient` this namespace needs: the transport, and nothing
 * else. Structural rather than a concrete client type, so the namespace stays
 * independently constructible in a test and this module never imports the
 * client back — mirrors `VarsHost` in `../vars.ts`.
 */
export interface AppsHost {
  /** Perform one request. */
  request<T>(options: RequestOptions): Promise<HttpResponse<T>>;
}

/**
 * An app's catalog summary, as `list` projects it. Field-for-field per
 * `packages/studio/src/api/types.ts:10-32` — this module does not redesign
 * the shape, only gives it a second home.
 */
/**
 * The incoming state a single-step test is run against — what the upstream
 * steps last produced. The server projects it onto the scope roots an
 * `ExprValue` reads (`steps.<id>.output`, `trigger.event`), so a step whose
 * params reference an upstream step resolves them instead of getting `""`.
 *
 * Deliberately loose about `output`: it is whatever that step returned.
 */
export interface InvokeStartState {
  steps?: Record<string, { output?: unknown }>;
  trigger?: { event?: unknown };
}

/** Options for {@link AppsNamespace.invoke}. */
export interface InvokeOptions {
  /** Run the action with this connection; omitted, the server picks one. */
  connectionId?: string;
  /** Which project's vars and documents `ExprValue` params resolve against. */
  project?: string;
  /** Upstream state to resolve `steps.<id>.output` / `trigger.event` against. */
  state?: InvokeStartState;
}

export interface AppSummary {
  id: string;
  displayName: string;
  version: string;
  description: string;
  categories: string[];
  sourceRef: string;
  importedAt: string;
  /** Inlined data: URI (or absolute URL) for the app's icon. May be empty. */
  iconSvg?: string;
  /** Optional dark-mode variant; when present, AppIcon uses it in dark theme. */
  iconSvgDark?: string;
  brandColor?: string;
  brandColorDark?: string;
  versionCount?: number;
  maturity?: string;
  visibility?: string;
  successor?: string;
  /** Number of health checks declared by the app's manifest. */
  healthCheckCount?: number;
  /** True when at least one declared health check is app-scoped and needs no credential. */
  hasPublicHealthCheck?: boolean;
  /**
   * True when the app declares an `oauth2` auth method. Server-computed from
   * `app.latest.auth` by `summarize` (`packages/server/packages/api/wire-summary.ts:81`),
   * so no client ever re-derives it and no caller needs the per-app
   * `GET /apps/:id/auths` read just to know whether OAuth is on the table.
   */
  supportsOAuth?: boolean;
  /** How many triggers this app's latest version declares. 0 when it declares none. */
  triggerCount?: number;
  /**
   * Ownership sentinels: neither set -> global · `tenant` set, `subject` empty
   * -> tenant-owned · both -> user-owned. Projected server-side by `wireOwner`
   * (`wire-summary.ts:70-72`), which is why both members are plain strings here
   * and never `undefined`.
   *
   * **Optional on this type even though the server always sends it**
   * (`WireAppSummary.owner` at `wire-summary.ts:57` is required and has shipped
   * since T2.2): the type is also satisfied by a literal a caller writes and by
   * an older host, and declaring it required would break both.
   */
  owner?: { tenant: string; subject: string };
}

/**
 * One declared parameter of an action. Field-for-field per
 * `packages/studio/src/api/types.ts:35-42`.
 */
export interface ActionParam {
  key: string;
  label?: string;
  type: "string" | "text" | "number" | "boolean" | "json" | "secret" | string;
  required?: boolean;
  default?: unknown;
  hint?: string;
}

/** An app-declared action. Field-for-field per `packages/studio/src/api/types.ts:44-51`. */
export interface ActionDef {
  key: string;
  type: string;
  title: string;
  description?: string;
  params?: ActionParam[];
  output?: unknown;
}

/**
 * One outbound HTTP call an action made while running — the exact (redacted)
 * request sent to the third-party API and the response it returned. Rides
 * along with an `invoke` result. Field-for-field per
 * `packages/studio/src/api/types.ts:59-80`.
 */
export interface ApiCallRecord {
  id?: string;
  appId?: string;
  actionKey?: string;
  connectionId?: string | null;
  sessionId?: string | null;
  host: string;
  method: string;
  /** 0 when the request never produced a response (`error` says why). */
  status: number;
  url?: string;
  requestHeaders?: Record<string, string>;
  requestBody?: string | null;
  responseHeaders?: Record<string, string>;
  responseBody?: string | null;
  responseBytes?: number;
  durationMs?: number;
  /** A captured body hit the size cap and was cut. */
  truncated?: boolean;
  error?: string | null;
  createdAt?: string;
}

/**
 * One field on an Auth method's connection form. Field-for-field per
 * `packages/studio/src/api/types.ts:83-90`.
 */
export interface AuthField {
  key: string;
  label: string;
  type: "string" | "number" | "boolean" | "secret" | string;
  required?: boolean;
  default?: unknown;
  hint?: string;
}

/**
 * Auth method declaration as exposed by an app's manifest. Field-for-field
 * per `packages/studio/src/api/types.ts:93-114`.
 */
export interface AuthDef {
  key: string;
  type: "oauth2" | "apiKey" | "basic" | "bearer" | "custom" | string;
  displayName?: string;
  description?: string;
  connectionLabel?: string;
  fields?: AuthField[];
  /** OAuth2 endpoints (only present when type === "oauth2"). */
  oauth2?: Record<string, unknown>;
  /**
   * Server-side availability flag. False when the method requires per-host
   * configuration that hasn't been provided yet (e.g. an oauth2 method with
   * no app_oauth_config row). The connection modal filters these out.
   */
  available?: boolean;
  /**
   * Names of host-side config keys this method needs. Present on `oauth2`
   * (["clientId", "clientSecret", "redirectUri"]). Empty / undefined for
   * types that source everything from end-user input.
   */
  requiresHostConfig?: string[];
}

/**
 * One entry in a pack preview — the shallow peek returned by `preview`.
 * Field-for-field per `packages/studio/src/api/types.ts:120-131`.
 */
export interface PackEntryPreview {
  path: string;
  id?: string;
  displayName?: string;
  version?: string;
  description?: string;
  alreadyRegistered: boolean;
  pinnedVersion?: string;
  pinnedId?: string;
  optional?: boolean;
  peekError?: string;
}

/** Field-for-field per `packages/studio/src/api/types.ts:133-139`. */
export interface PackPreviewInfo {
  name: string;
  displayName?: string;
  description?: string;
  version?: string;
  count: number;
}

/**
 * `preview`'s result — a discriminated union on `kind`. Field-for-field per
 * `packages/studio/src/api/types.ts:141-143`.
 */
export type PreviewSourceResponse =
  | { kind: "app"; sourceRef: string; app: { id?: string; version?: string; displayName?: string } }
  | { kind: "pack"; sourceRef: string; pack: PackPreviewInfo; entries: PackEntryPreview[] };

/**
 * `import`'s result — a discriminated union on `kind`. Field-for-field per
 * `packages/studio/src/api/types.ts:146-172`.
 */
export type ImportResponse =
  | {
    kind: "app";
    sourceRef: string;
    app: Record<string, unknown>;
    actions: ActionDef[];
    registered: boolean;
    latestAdvanced: boolean;
  }
  | {
    kind: "pack";
    sourceRef: string;
    pack: PackPreviewInfo;
    registered: number;
    failed: number;
    results: Array<
      | {
        path: string;
        ok: true;
        id: string;
        version: string;
        registered: boolean;
        latestAdvanced: boolean;
      }
      | { path: string; ok: false; optional: boolean; error: { code: string; message: string } }
    >;
  };

/**
 * `refresh`'s result — a re-import from the app's recorded source.
 * Field-for-field per `packages/studio/src/api/types.ts:175-188`.
 */
export interface RefreshAppResponse {
  app: Record<string, unknown>;
  actions: ActionDef[];
  sourceRef: string;
  version: string;
  digest: string;
  /** True when the refresh stored a new version (false → content unchanged). */
  registered: boolean;
  latestAdvanced: boolean;
  /** True when the stored version was auto-bumped past the source's manifest version. */
  bumped: boolean;
  /** The source manifest's version, unchanged — diff against `version` to spot a bump. */
  sourceVersion: string;
}

/**
 * Public projection of a stored per-installation OAuth config. Secret never
 * leaves the server. Field-for-field per
 * `packages/studio/src/api/types.ts:191-200`.
 */
export interface OAuthConfigSummary {
  appId: string;
  authKey: string;
  clientId: string;
  redirectUri: string;
  hasClientSecret: true;
  extra: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

/** Health-model literal unions, mirroring @w6w/types. */
export type HealthState = "ok" | "degraded" | "down" | "unknown";
export type HealthKind = "service" | "credential" | "quota" | "dependency";
export type HealthScope = "app" | "connection";
export type CredentialPosture = "none" | "context" | "signed";
export type HealthSeverity = "fatal" | "degraded" | "informational";

/**
 * Declared health-check metadata as exposed on an app detail. A thin local
 * copy of the persisted `HealthCheck` (no probe fn). Field-for-field per
 * `packages/studio/src/api/types.ts:213-224`.
 */
export interface HealthCheckMeta {
  key: string;
  title: string;
  description?: string;
  kind: HealthKind;
  scope?: HealthScope;
  covers?: string[];
  credential?: CredentialPosture;
  severity?: HealthSeverity;
  /** Present when the check can't run (e.g. missing host config); `reason` explains why. */
  unavailable?: { reason: string };
}

/** One quota line reported by a health probe. Field-for-field per `types.ts:227-233`. */
export interface HealthQuota {
  id?: string;
  limit?: number;
  remaining?: number;
  resetAt?: string;
  unit?: string;
}

/** The outcome payload a single health probe returns. Field-for-field per `types.ts:236-243`. */
export interface HealthReport {
  state: HealthState;
  message?: string;
  components?: Record<string, { state: HealthState; message?: string }>;
  quota?: HealthQuota[];
  ttlSeconds?: number;
  latencyMs?: number;
}

/** One probe's result within a verdict. Field-for-field per `types.ts:246-252`. */
export interface HealthResult {
  key: string;
  check: HealthCheckMeta;
  report: HealthReport;
  checkedAt: string;
  durationMs: number;
}

/**
 * Live health verdict for an app, returned by `getHealthStatus`.
 * Field-for-field per `packages/studio/src/api/types.ts:258-262`.
 */
export interface AppHealthStatus {
  state: HealthState;
  attributedTo: string[];
  results: HealthResult[];
}

/**
 * The full app detail — one registered app's latest manifest, actions and
 * overlay. Field-for-field per `packages/studio/src/api/types.ts:264-274`.
 */
export interface AppDetail {
  app: Record<string, unknown> & { displayName?: string };
  actions: ActionDef[];
  health?: HealthCheckMeta[];
  sourceRef: string;
  version?: string;
  digest?: string;
  versionCount?: number;
  overlay?: Record<string, unknown>;
  effective?: { maturity: string; visibility: string; successor?: string };
}

/**
 * App-declared trigger as returned by `getTriggers`. Same shape as
 * `ActionDef` minus `execute` — declaration only, no behavior.
 * Field-for-field per `packages/studio/src/api/types.ts:426-434`.
 */
export interface TriggerDef {
  key: string;
  title: string;
  description?: string;
  requiresAuth?: boolean;
  params?: unknown[];
  output?: unknown;
  sample?: unknown;
}

/** The body of `upsertOAuthConfig`, forwarded verbatim. */
export interface UpsertOAuthConfigInput {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  extra?: Record<string, unknown>;
}

/** One page of `GET /apps`, as `list`'s pagination loop reads it. */
interface AppsPage {
  apps: AppSummary[];
  nextCursor?: string;
}

/**
 * The `console.apps` namespace on a `W6WClient`.
 *
 * @example
 * ```ts
 * const apps = await client.console.apps.list();
 * const detail = await client.console.apps.get(apps[0].id);
 * const result = await client.console.apps.invoke(detail.app.id as string, "send", { to: "a@b.com" });
 * ```
 */
export class AppsApi {
  readonly #host: AppsHost;

  /**
   * @param host - The client this namespace issues requests through.
   */
  constructor(host: AppsHost) {
    this.#host = host;
  }

  /**
   * List every registered app the caller can see.
   *
   * Every consumer treats this as the complete catalog with no "load more"
   * UI, so this method fetches every page itself — a bare `GET /apps` only
   * returns the server's default page and would silently hide anything past
   * it. Capped at 20 pages (~4000 apps at the 200-per-page size) as a runaway
   * backstop, not an expected limit; relocated verbatim from
   * `client.ts:244-256`.
   *
   * @returns Every app summary across all pages, in the order the server sent them.
   * @throws {ApiError} On any non-2xx.
   */
  async list(): Promise<AppSummary[]> {
    const apps: AppSummary[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const res = await this.#host.request<AppsPage>({
        method: "GET",
        path: "/apps",
        query: { limit: 200, cursor },
      });
      apps.push(...res.body.apps);
      if (!res.body.nextCursor) break;
      cursor = res.body.nextCursor;
    }
    return apps;
  }

  /**
   * Fetch one registered app's detail (latest manifest + actions + overlay).
   *
   * @param id - The app id.
   * @returns The whole response body — no envelope key to peel.
   * @throws {ApiError} `404 unknown_app` when there is no such id.
   */
  async get(id: string): Promise<AppDetail> {
    const res = await this.#host.request<AppDetail>({
      method: "GET",
      path: path`/apps/${id}`,
    });
    return res.body;
  }

  /**
   * List an app's auth methods, annotated with `available` and any
   * `requiresHostConfig` fields.
   *
   * @param id - The app id.
   * @returns The auth methods, unwrapped from the `auths` envelope.
   * @throws {ApiError} `404 unknown_app` when there is no such id.
   */
  async getAuth(id: string): Promise<AuthDef[]> {
    const res = await this.#host.request<unknown>({
      method: "GET",
      path: path`/apps/${id}/auths`,
    });
    return unwrap<AuthDef[]>(res, "auths");
  }

  /**
   * Fetch an app's declared actions.
   *
   * Sourced from the app detail's `actions` array — a separate call from
   * {@linkcode get}, relocated verbatim from `client.ts:268-271` rather than
   * refactored to call `get` internally.
   *
   * @param id - The app id.
   * @returns The declared actions; `[]` when the app declares none.
   * @throws {ApiError} `404 unknown_app` when there is no such id.
   */
  async getActions(id: string): Promise<ActionDef[]> {
    const res = await this.#host.request<AppDetail>({
      method: "GET",
      path: path`/apps/${id}`,
    });
    return res.body.actions ?? [];
  }

  /**
   * List an app's declared triggers.
   *
   * @param id - The app id.
   * @returns The declared triggers, unwrapped from the `triggers` envelope.
   * @throws {ApiError} `404 unknown_app` when there is no such id.
   */
  async getTriggers(id: string): Promise<TriggerDef[]> {
    const res = await this.#host.request<unknown>({
      method: "GET",
      path: path`/apps/${id}/triggers`,
    });
    return unwrap<TriggerDef[]>(res, "triggers");
  }

  /**
   * Fetch an app's declared health-check metadata.
   *
   * **Dead code (HITL-4)** — zero call sites anywhere in studio or
   * `@w6w/ui`. Built for SDK completeness only; see this module's header.
   * Sourced from the app detail's `health` array — a separate call from
   * {@linkcode get}, relocated verbatim from `client.ts:278-281` rather than
   * refactored to call `get` internally.
   *
   * @param id - The app id.
   * @returns The declared health checks; `[]` when the app declares none.
   * @throws {ApiError} `404 unknown_app` when there is no such id.
   */
  async getHealth(id: string): Promise<HealthCheckMeta[]> {
    const res = await this.#host.request<AppDetail>({
      method: "GET",
      path: path`/apps/${id}`,
    });
    return res.body.health ?? [];
  }

  /**
   * Run an app's PUBLIC health checks and return the live verdict.
   *
   * @param id - The app id.
   * @returns The whole response body — no envelope key to peel.
   * @throws {ApiError} `404 unknown_app` when there is no such id.
   */
  async getHealthStatus(id: string): Promise<AppHealthStatus> {
    const res = await this.#host.request<AppHealthStatus>({
      method: "GET",
      path: path`/apps/${id}/health`,
    });
    return res.body;
  }

  /**
   * List every stored per-installation OAuth config summary for an app (no secrets).
   *
   * **Dead code (HITL-4)** — zero call sites anywhere in studio or
   * `@w6w/ui`. Built for SDK completeness only; see this module's header.
   *
   * @param appId - The app id.
   * @returns The configs, unwrapped from the `configs` envelope.
   * @throws {ApiError} `404 unknown_app` when there is no such id.
   */
  async listOAuthConfig(appId: string): Promise<OAuthConfigSummary[]> {
    const res = await this.#host.request<unknown>({
      method: "GET",
      path: path`/apps/${appId}/oauth-config`,
    });
    return unwrap<OAuthConfigSummary[]>(res, "configs");
  }

  /**
   * Upsert the OAuth client credentials for one (app, auth method).
   *
   * **Dead code (HITL-4)** — zero call sites anywhere in studio or
   * `@w6w/ui`. Built for SDK completeness only; see this module's header.
   *
   * @param appId - The app id.
   * @param authKey - The oauth2 auth method's key, as declared by the app's manifest.
   * @param body - The client credentials, forwarded verbatim.
   * @returns The stored config summary (the server answers `201`).
   * @throws {ApiError} `404 unknown_app`/`unknown_auth`; `400 invalid_auth_type`/`invalid_body`.
   */
  async upsertOAuthConfig(
    appId: string,
    authKey: string,
    body: UpsertOAuthConfigInput,
  ): Promise<OAuthConfigSummary> {
    const res = await this.#host.request<unknown>({
      method: "PUT",
      path: path`/apps/${appId}/oauth-config/${authKey}`,
      body,
    });
    return unwrap<OAuthConfigSummary>(res, "config");
  }

  /**
   * Remove the stored OAuth client credentials for one (app, auth method).
   *
   * **Dead code (HITL-4)** — zero call sites anywhere in studio or
   * `@w6w/ui`. Built for SDK completeness only; see this module's header.
   * Returns nothing: the server's `{ok: true}` carries no information a
   * caller can use, mirroring `documents.ts`'s/`projects.ts`'s established
   * delete convention.
   *
   * @param appId - The app id.
   * @param authKey - The oauth2 auth method's key.
   * @throws {ApiError} `404 unknown_oauth_config` when there is no such config.
   */
  async deleteOAuthConfig(appId: string, authKey: string): Promise<void> {
    await this.#host.request<unknown>({
      method: "DELETE",
      path: path`/apps/${appId}/oauth-config/${authKey}`,
    });
  }

  /**
   * Kick off an OAuth 2.0 flow: the server builds the provider's authorize
   * URL for the caller to open.
   *
   * No studio-page caller, but this method's shape must exactly match
   * `W6WApi.startAppOAuthFlow`'s signature on the `@w6w/ui` facade
   * (`packages/ui/src/provider.tsx:110-114`), which calls it.
   *
   * @param appId - The app id.
   * @param authKey - The oauth2 auth method's key, as declared by the app's manifest.
   * @param body - Optional display name for the resulting connection; omitted fields are left to the server.
   * @returns The whole response body — no envelope key to peel.
   * @throws {ApiError} `404 unknown_app`/`unknown_auth`; `400 invalid_auth_type`; `409 oauth_not_configured`.
   */
  async startOAuthFlow(
    appId: string,
    authKey: string,
    body: { displayName?: string } = {},
  ): Promise<{ authorizationUrl: string; state: string; expiresIn: number }> {
    const res = await this.#host.request<
      { authorizationUrl: string; state: string; expiresIn: number }
    >(
      {
        method: "POST",
        path: path`/apps/${appId}/oauth-config/${authKey}/authorize-url`,
        body,
      },
    );
    return res.body;
  }

  /**
   * Peek what installing a source ref would touch, without persisting
   * anything. Distinguishes a single-app ref from a pack ref, and (for a
   * pack) previews each entry for a checkbox picker.
   *
   * @param source - A source ref (e.g. `github:org/repo`, `file:./local-app`).
   * @param opts - `refresh: true` busts the sources cache — needed for a
   * moving GitHub pointer (`@main`, `@HEAD`, or no `@ref`) whenever the
   * remote has advanced since the last fetch.
   * @returns The whole response body — a `kind`-discriminated union, no envelope key to peel.
   * @throws {ApiError} `400 invalid_source` and whatever the source resolution itself raises.
   */
  async preview(source: string, opts: { refresh?: boolean } = {}): Promise<PreviewSourceResponse> {
    const res = await this.#host.request<PreviewSourceResponse>({
      method: "POST",
      path: "/apps/preview",
      body: { source, ...(opts.refresh ? { refresh: true } : {}) },
    });
    return res.body;
  }

  /**
   * Install a single app or a pack from a source ref.
   *
   * @param source - A source ref (e.g. `github:org/repo`, `file:./local-app`).
   * @param opts - `paths` (pack refs only) limits which entries are
   * installed — omitted, every entry is installed. `refresh: true` busts the
   * sources cache (see {@linkcode preview}).
   * @returns The whole response body — a `kind`-discriminated union, no envelope key to peel.
   * @throws {ApiError} `400 invalid_source`; `403 user_import_disabled`/`local_import_forbidden` for a non-operator.
   */
  async import(
    source: string,
    opts: { paths?: string[]; refresh?: boolean } = {},
  ): Promise<ImportResponse> {
    const res = await this.#host.request<ImportResponse>({
      method: "POST",
      path: "/apps/import",
      body: {
        source,
        ...(opts.paths ? { paths: opts.paths } : {}),
        ...(opts.refresh ? { refresh: true } : {}),
      },
    });
    return res.body;
  }

  /**
   * Re-resolve an already-registered app from its recorded source ref and
   * re-register it (operator-only server-side — non-operators get a `403`).
   *
   * @param id - The app id.
   * @param opts - `force: true` busts the sources cache ("Reload"); the
   * server ignores unknown fields, so `force` is harmless until server-side
   * handling for it lands.
   * @returns The whole response body — no envelope key to peel.
   * @throws {ApiError} `404 unknown_app`; `403` for a non-operator.
   */
  async refresh(id: string, opts: { force?: boolean } = {}): Promise<RefreshAppResponse> {
    const res = await this.#host.request<RefreshAppResponse>({
      method: "POST",
      path: path`/apps/${id}/refresh`,
      body: opts.force ? { force: true } : {},
    });
    return res.body;
  }

  /**
   * Invoke one of an app's actions.
   *
   * This method's shape must exactly match `W6WApi.invokeAction`'s signature on
   * the `@w6w/ui` facade (`packages/ui/src/provider.tsx`). It now models the
   * WHOLE of that `opts` — `project` and `state` included.
   *
   * **They are not decoration, and modelling only `connectionId` was a live
   * bug.** `params` may contain unresolved `ExprValue` envelopes, which the
   * server resolves against an ambient scope built from exactly these two
   * fields (`invoke.ts` → `buildAmbientScope`): `state` seeds
   * `steps.<id>.output` and `trigger.event`, `project` chooses which project's
   * vars and documents are in scope. Dropped, every
   * `{{ steps.<id>.output.<field> }}` in a step test resolves to the empty
   * string and the action fails on a required param it was visibly given — the
   * editor's own preview resolves locally and shows the right value, so the
   * failure reads as an app bug rather than a lost field.
   *
   * @param appId - The app id.
   * @param actionKey - The action's key, as declared by the app's manifest.
   * @param params - The action's parameters, forwarded verbatim.
   * @param opts - `connectionId` to run with (omitted, the server picks);
   *   `project` to scope vars/documents to; `state` to resolve upstream
   *   references against.
   * @returns The whole response body — no envelope key to peel.
   * @throws {ApiError} On any non-2xx, including an action's own failure (`424`).
   */
  async invoke(
    appId: string,
    actionKey: string,
    params: Record<string, unknown>,
    opts: InvokeOptions = {},
  ): Promise<{ value: unknown; logs?: string[]; apiCalls?: ApiCallRecord[] }> {
    const res = await this.#host.request<
      { value: unknown; logs?: string[]; apiCalls?: ApiCallRecord[] }
    >(
      {
        method: "POST",
        path: path`/apps/${appId}/actions/${actionKey}/invoke`,
        body: { params, ...opts },
      },
    );
    return res.body;
  }

  /**
   * Unregister an app (all versions by default).
   *
   * **Returns the server's real value, unlike `projects.delete`/`schedules.delete`
   * in this same package** — the server answers `{removed: number}`, a
   * genuinely informative count (`apps-catalog.ts:646-651`), and this method
   * preserves it rather than discarding it to `void`. This is the one
   * deliberate asymmetry vs. this package's other two `delete` conventions;
   * see this module's header.
   *
   * @param appId - The app id.
   * @returns `{removed}` — how many versions were unregistered.
   * @throws {ApiError} `404 unknown_app`; `403 forbidden` when a non-operator does not own the app.
   */
  async delete(appId: string): Promise<{ removed: number }> {
    const res = await this.#host.request<{ removed: number }>({
      method: "DELETE",
      path: path`/apps/${appId}`,
    });
    return res.body;
  }
}
