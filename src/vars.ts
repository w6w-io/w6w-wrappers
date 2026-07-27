/**
 * `client.vars.*` — typed variables, addressed the way the server addresses
 * them.
 *
 * Six operations, one HTTP call each. **Create by `name`, read by id or by
 * name, update and delete by id** (`docs/implementation.md` §7, D6 amended by
 * D12). No client-side list-then-filter: `getByName` targets a real route,
 * `GET /vars/by-name/{name}`, which is `status: "planned"` in `endpoints.json`
 * and lands with T4.4.1 (fenced by BLK-1). Until it does, a live server answers
 * `404` — which is the correct failure and is not papered over here.
 *
 * **There is no scoping query parameter on any variable operation, and this
 * module cannot invent one.** Variables are scoped by tenant/subject only; the
 * server's `vars` routes read no such parameter and the table has no column for
 * it, while every document route does — so the two asset surfaces are
 * deliberately asymmetric (`docs/implementation.md` §7, and `src/documents.ts`
 * for the other half). The asymmetry is enforced structurally rather than by
 * discipline: {@linkcode VarsHost} exposes the transport and **not** the
 * client's resolved configuration, so nothing in this file can reach a default
 * scope to send even by accident. Adding the parameter later, once the server
 * honours it, is purely additive; adding it now would be an argument the server
 * ignores — a lie that typechecks.
 *
 * @module
 */

import { type HttpResponse, path, type RequestOptions } from "./http.ts";
import { unwrap, type Var, type VarType } from "./types.ts";

/**
 * The slice of `W6wClient` this namespace needs: the transport, and nothing
 * else. Structural rather than a concrete client type, so the namespace stays
 * independently constructible in a test and this module never imports the
 * client back.
 */
export interface VarsHost {
  /** Perform one request. */
  request<T>(options: RequestOptions): Promise<HttpResponse<T>>;
}

/**
 * The body of `vars.create`.
 *
 * Addressed by `name`, because that is how the server addresses a create (D6).
 */
export interface VarCreateInput {
  /** Must match `^[a-z_][a-z0-9_]*$` (`400 invalid_name`); unique (`409 var_exists`). */
  name: string;
  /** The declared type. */
  type: VarType;
  /** The value, validated server-side against `type` (`400 invalid_value`). */
  value: unknown;
  /** Free text. */
  description?: string;
}

/**
 * The body of `vars.update`. Every field is optional; an omitted field is left
 * alone.
 *
 * **`name` is deliberately absent.** The server's PATCH body has no `name` and
 * the name is immutable, so there is no field here to put one in — the type is
 * what enforces it, not a comment.
 *
 * A `value` sent **without** a `type` is validated against the variable's
 * existing type.
 */
export interface VarPatch {
  /** Replacement type. */
  type?: VarType;
  /** Replacement value. */
  value?: unknown;
  /** Replacement description. */
  description?: string;
}

/**
 * The `vars` namespace on a `W6wClient`.
 *
 * @example
 * ```ts
 * const v = await client.vars.create({ name: "sender_email", type: "string", value: "a@b.c" });
 * await client.vars.update(v.id, { value: "c@d.e" });
 * await client.vars.delete(v.id);
 * ```
 */
export class VarsApi {
  readonly #host: VarsHost;

  /**
   * @param host - The client this namespace issues requests through.
   */
  constructor(host: VarsHost) {
    this.#host = host;
  }

  /**
   * List the caller's variables.
   *
   * @returns The variables, unwrapped from the `vars` envelope.
   * @throws {ApiError} On any non-2xx.
   */
  async list(): Promise<Var[]> {
    const res = await this.#host.request<unknown>({ method: "GET", path: "/vars" });
    return unwrap<Var[]>(res, "vars");
  }

  /**
   * Fetch one variable by its server-issued id.
   *
   * @param id - The `var_…` id.
   * @returns The variable.
   * @throws {ApiError} `404 unknown_var` when there is no such id.
   */
  async get(id: string): Promise<Var> {
    const res = await this.#host.request<unknown>({ method: "GET", path: path`/vars/${id}` });
    // The singular envelope key is `var` — a reserved word in TypeScript, so it
    // is read as a property and never destructured into a binding.
    return unwrap<Var>(res, "var");
  }

  /**
   * Fetch one variable by the `name` its author chose.
   *
   * The name is percent-encoded at interpolation by the `path` tag. The server's
   * own rule (`^[a-z_][a-z0-9_]*$`) contains nothing that needs encoding — but
   * that rule is the *server's* to enforce, and this method encodes rather than
   * validates: a name the server accepts is sent as-is (encoded), and a name it
   * rejects comes back as `400 invalid_name` from the one place that owns the
   * rule, instead of as a client-side error that would go stale the moment the
   * rule changed.
   *
   * **`status: "planned"`** — the route lands with T4.4.1; until then a live
   * server answers `404`.
   *
   * @param name - The variable name, sent encoded and otherwise untouched.
   * @returns The variable.
   * @throws {ApiError} `404 unknown_var` when there is no such name.
   */
  async getByName(name: string): Promise<Var> {
    const res = await this.#host.request<unknown>({
      method: "GET",
      path: path`/vars/by-name/${name}`,
    });
    return unwrap<Var>(res, "var");
  }

  /**
   * Create a typed variable under a caller-chosen name.
   *
   * @param input - `name`, `type` and `value` are required.
   * @returns The created variable (the server answers `201`).
   * @throws {ApiError} `409 var_exists` on a duplicate name — the code reaches the caller intact.
   */
  async create(input: VarCreateInput): Promise<Var> {
    const res = await this.#host.request<unknown>({
      method: "POST",
      path: "/vars",
      // Assembled field by field rather than forwarded wholesale: the body that
      // goes on the wire is exactly the four documented fields, and `undefined`
      // ones are dropped by JSON serialisation.
      body: {
        name: input.name,
        type: input.type,
        value: input.value,
        description: input.description,
      },
    });
    return unwrap<Var>(res, "var");
  }

  /**
   * Patch a variable's type, value or description.
   *
   * Addressed by id, never by name, and the name itself cannot be changed.
   *
   * @param id - The `var_…` id.
   * @param patch - The fields to change; omitted fields are left alone.
   * @returns The updated variable.
   * @throws {ApiError} `404 unknown_var` when there is no such id.
   */
  async update(id: string, patch: VarPatch): Promise<Var> {
    const res = await this.#host.request<unknown>({
      method: "PATCH",
      path: path`/vars/${id}`,
      body: {
        type: patch.type,
        value: patch.value,
        description: patch.description,
      },
    });
    return unwrap<Var>(res, "var");
  }

  /**
   * Delete a variable.
   *
   * Returns nothing: the server's `{ok: true}` carries no information a caller
   * can use. Deleting an unknown id is `404 unknown_var`, **not** a silent
   * success — the delete is not idempotent and this method does not pretend
   * otherwise.
   *
   * @param id - The `var_…` id.
   * @throws {ApiError} `404 unknown_var` when there is no such id.
   */
  async delete(id: string): Promise<void> {
    await this.#host.request<unknown>({ method: "DELETE", path: path`/vars/${id}` });
  }
}
