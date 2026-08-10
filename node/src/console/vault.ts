/**
 * `client.console.vault.*` — the write-only secret store (list, get, create,
 * update, delete, seal), relocated from the studio's own API client.
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
 * **Write-only, no-plaintext-in-responses is the invariant this whole domain
 * rests on** (`packages/server/packages/api/admin/vault.ts:1-21`'s own header
 * comment: "plaintext values NEVER appear in a response"). `list`/`get` never
 * carry `value` — by the server's wire contract itself, not by client
 * discipline — which is why {@linkcode VaultSecretSummary} has no `value`
 * field. `create`/`update` forward `value` verbatim to *write* it, and it is
 * simply never echoed back. `seal` is the one deliberate exception, and even
 * there it never returns the plaintext: it answers with a ciphertext envelope
 * (`SecretValue`) — an encrypt-only oracle with no matching decrypt route, so
 * an authed caller learns nothing they didn't already provide.
 *
 * Six methods relocate from the studio's own `// Vault` comment block
 * (`packages/studio/src/api/client.ts:257-278` on the current merged tree) —
 * field-for-field, not redesigned.
 *
 * `value` is opaque — forwarded verbatim on `create`/`update`/`seal`, never
 * inspected, logged, or transformed. This is a security-adjacent discipline,
 * not a style note: the whole point of this field is a caller-opaque secret
 * payload.
 *
 * None of these methods take a `project` scoping parameter — vault secrets
 * are subject-scoped like `vars`, not project-scoped — so `VaultHost` needs
 * only the transport, mirroring `VarsHost`/`ConnectionsHost`, not
 * `DocumentsHost`.
 *
 * @module
 */

import { type HttpResponse, path, type RequestOptions } from "../http.ts";
import { unwrap } from "../types.ts";

/**
 * The slice of `W6wClient` this namespace needs: the transport, and nothing
 * else. Structural rather than a concrete client type, so the namespace stays
 * independently constructible in a test and this module never imports the
 * client back — mirrors `ConnectionsHost` in `./connections.ts`.
 */
export interface VaultHost {
  /** Perform one request. */
  request<T>(options: RequestOptions): Promise<HttpResponse<T>>;
}

/**
 * Public projection of a stored vault secret. **`value` is deliberately
 * absent** — the server never puts a secret's plaintext on the wire for
 * `list`/`get`/`create`/`update`, and declaring the field here would promise a
 * caller something that can never arrive.
 */
export interface VaultSecretSummary {
  /** Server-issued id, `sec_…`. */
  id: string;
  /** Caller-chosen name, matching `^[a-z_][a-z0-9_]*$`. */
  name: string;
  /** Free-text description; `""` when unset. */
  description: string;
  /** ISO-8601 timestamp. */
  createdAt: string;
  /** ISO-8601 timestamp. */
  updatedAt: string;
}

/**
 * An at-rest ciphertext envelope for one ad-hoc secret value, produced by
 * {@linkcode VaultApi.seal}. Field-for-field identical to
 * `packages/ui/src/types.ts`'s `SecretValue` shape, defined locally here
 * rather than imported from `@w6w/ui` — this SDK has no dependency on
 * `packages/ui` and must not gain one (wrong dependency direction for a
 * published SDK). TypeScript's structural typing makes this value satisfy
 * `@w6w/ui`'s `ExpressionOptions.sealSecret` prop shape at a studio call site
 * with no shared import needed.
 */
export interface SecretValue {
  type: "secret";
  /** Base64-encoded ciphertext. */
  ciphertext: string;
  /** Base64-encoded initialization vector. */
  iv: string;
}

/**
 * The `console.vault` namespace on a `W6wClient`.
 *
 * @example
 * ```ts
 * const secrets = await client.console.vault.list();
 * const created = await client.console.vault.create({ name: "openai_key", value: "sk-…" });
 * await client.console.vault.update(created.id, { description: "Prod key" });
 * const sealed = await client.console.vault.seal("sk-live-…");
 * await client.console.vault.delete(created.id);
 * ```
 */
export class VaultApi {
  readonly #host: VaultHost;

  /**
   * @param host - The client this namespace issues requests through.
   */
  constructor(host: VaultHost) {
    this.#host = host;
  }

  /**
   * List the account's vault secrets.
   *
   * @returns The secrets, unwrapped from the `secrets` envelope. Never
   * carries `value`.
   */
  async list(): Promise<VaultSecretSummary[]> {
    const res = await this.#host.request<unknown>({ method: "GET", path: "/vault" });
    return unwrap<VaultSecretSummary[]>(res, "secrets");
  }

  /**
   * Fetch one secret's metadata.
   *
   * **Zero studio callers today** — built for SDK completeness only. No 404
   * special-casing — propagates as `ApiError` like every other "get" in this
   * package except `console.schedules.get`, which has its own documented,
   * unrelated exception.
   *
   * @param id - The `sec_…` id.
   * @returns The secret, unwrapped from the `secret` envelope. Never carries `value`.
   * @throws {ApiError} `404 unknown_secret` when there is no such id.
   */
  async get(id: string): Promise<VaultSecretSummary> {
    const res = await this.#host.request<unknown>({ method: "GET", path: path`/vault/${id}` });
    return unwrap<VaultSecretSummary>(res, "secret");
  }

  /**
   * Create a secret.
   *
   * `value` is opaque — forwarded verbatim, never inspected, logged, or
   * transformed.
   *
   * @param body - `name` (unique, matches `^[a-z_][a-z0-9_]*$`), `value` (the
   * plaintext to store), and an optional `description`.
   * @returns The created secret, unwrapped from the `secret` envelope (the
   * server answers `201`). Never carries `value`.
   * @throws {ApiError} `400 invalid_name`/`invalid_value`/`invalid_description`; `409 secret_exists`.
   */
  async create(
    body: { name: string; value: string; description?: string },
  ): Promise<VaultSecretSummary> {
    const res = await this.#host.request<unknown>({ method: "POST", path: "/vault", body });
    return unwrap<VaultSecretSummary>(res, "secret");
  }

  /**
   * Update a secret: replace its value and/or its description.
   *
   * `value` is opaque — forwarded verbatim, never inspected, logged, or
   * transformed, same discipline as {@linkcode create}.
   *
   * @param id - The `sec_…` id.
   * @param body - `value` and/or `description`, forwarded verbatim.
   * @returns The updated secret, unwrapped from the `secret` envelope. Never carries `value`.
   * @throws {ApiError} `400 invalid_value`/`invalid_description`; `404 unknown_secret`.
   */
  async update(
    id: string,
    body: { value?: string; description?: string },
  ): Promise<VaultSecretSummary> {
    const res = await this.#host.request<unknown>({
      method: "PATCH",
      path: path`/vault/${id}`,
      body,
    });
    return unwrap<VaultSecretSummary>(res, "secret");
  }

  /**
   * Delete a secret.
   *
   * Returns nothing: the server's `{ok: true}` carries no information a
   * caller can use, mirroring `console.projects.delete`/
   * `console.schedules.delete`/`console.connections.delete` in this same
   * package (NOT `console.apps.delete`, which is the one documented
   * exception) — vault delete has no such value to preserve.
   *
   * @param id - The `sec_…` id.
   * @throws {ApiError} `404 unknown_secret` when there is no such id.
   */
  async delete(id: string): Promise<void> {
    await this.#host.request<unknown>({ method: "DELETE", path: path`/vault/${id}` });
  }

  /**
   * Encrypt an ad-hoc secret value into an at-rest ciphertext envelope,
   * without storing it.
   *
   * **An encrypt-only oracle — there is no matching decrypt route.** The
   * server's own header comment states the security property directly: "an
   * authed caller learns nothing they didn't provide." `value` is opaque —
   * forwarded verbatim, never inspected, logged, or transformed. **No
   * envelope key to peel on the request side** — the body IS `{ value }` —
   * but the *response* IS enveloped under `sealed`, unlike `console.
   * connections.test`'s/`console.reliability.list`'s whole-body responses.
   *
   * @param value - The plaintext to seal. Never logged, never echoed back.
   * @returns The ciphertext envelope, unwrapped from the `sealed` envelope.
   * @throws {ApiError} `400 invalid_value` when `value` is empty.
   */
  async seal(value: string): Promise<SecretValue> {
    const res = await this.#host.request<unknown>({
      method: "POST",
      path: "/vault/seal",
      body: { value },
    });
    return unwrap<SecretValue>(res, "sealed");
  }
}
