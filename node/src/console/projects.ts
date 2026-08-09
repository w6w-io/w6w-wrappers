/**
 * `client.console.projects.*` — account-level projects, relocated from the
 * studio's own API client.
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
 * **Scope is studio's actual call surface, not the server's full route
 * surface.** The server also exposes `PATCH /projects/:id` (rename),
 * `POST /projects/:id/archive` and `POST /projects/:id/unarchive` — none of
 * these were ever wrapped in studio's `api/client.ts` (zero client-side
 * coverage, not just zero callers), and `GeneralPage.tsx`'s own header comment
 * confirms this is deliberate ("no rename/archive/unarchive/view-archived
 * here"). This module relocates exactly `listProjects`/`createProject`/
 * `deleteProject` and no more — see this task's contract Requirement and
 * `plan.md`'s FINDINGS DISPOSITION for the full reasoning.
 *
 * Neither method here takes a scoping parameter beyond what is modeled below:
 * projects operate at the account level, so `ProjectsHost` needs only the
 * transport, no client configuration — mirrors `VarsHost` in `../vars.ts`, not
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
 * client back — mirrors `VarsHost` in `../vars.ts`.
 */
export interface ProjectsHost {
  /** Perform one request. */
  request<T>(options: RequestOptions): Promise<HttpResponse<T>>;
}

/**
 * A project — a workspace within the account; each owns its own workflows.
 * Field-for-field per `packages/studio/src/api/types.ts:308-317` — this module
 * does not redesign the shape, only gives it a second home.
 */
export interface Project {
  id: string;
  account: string;
  name: string;
  isDefault: boolean;
  /** `archived` projects are hidden from the switcher; the default is never archived. */
  status: "active" | "archived";
  createdAt: string;
  updatedAt: string;
}

/**
 * The `console.projects` namespace on a `W6wClient`.
 *
 * @example
 * ```ts
 * const projects = await client.console.projects.list();
 * const created = await client.console.projects.create("Acme");
 * await client.console.projects.delete(created.id);
 * ```
 */
export class ProjectsApi {
  readonly #host: ProjectsHost;

  /**
   * @param host - The client this namespace issues requests through.
   */
  constructor(host: ProjectsHost) {
    this.#host = host;
  }

  /**
   * List the account's projects.
   *
   * No query parameter — the default excludes archived projects, and this
   * method sends none: studio's own `listProjects` never exposed
   * `includeArchived`, and this relocation does not add it
   * (`packages/server/packages/api/admin/projects.ts:55-63`).
   *
   * @returns The projects, unwrapped from the `projects` envelope.
   * @throws {ApiError} On any non-2xx.
   */
  async list(): Promise<Project[]> {
    const res = await this.#host.request<unknown>({ method: "GET", path: "/projects" });
    return unwrap<Project[]>(res, "projects");
  }

  /**
   * Create a project under a caller-chosen name.
   *
   * @param name - The project's display name.
   * @returns The created project (the server answers `201`).
   * @throws {ApiError} On any non-2xx.
   */
  async create(name: string): Promise<Project> {
    const res = await this.#host.request<unknown>({
      method: "POST",
      path: "/projects",
      body: { name },
    });
    return unwrap<Project>(res, "project");
  }

  /**
   * Delete a project.
   *
   * Returns nothing: the server's `{ok: true}` carries no information a caller
   * can use, and unwrapping it to a value would invite `if (await delete(...))`.
   * Deleting an unknown id, or the account's default project, both answer
   * `404 unknown_project` (`admin/projects.ts:131-147`) — this method does not
   * discriminate the two, only whether the call succeeded.
   *
   * @param id - The `prj_…` id.
   * @throws {ApiError} `404 unknown_project` when there is no such id, or it is the default project.
   */
  async delete(id: string): Promise<void> {
    await this.#host.request<unknown>({ method: "DELETE", path: path`/projects/${id}` });
  }
}
