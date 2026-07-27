/**
 * `client.documents.*` — the document store, addressed the way the server
 * addresses it.
 *
 * Six operations, one HTTP call each. **Create by `key`, read by id or by key,
 * update and delete by id** (`docs/implementation.md` §7, D6 amended by D12).
 * There is no key-addressed façade over the id routes and no client-side
 * list-then-filter anywhere in this file: a `getByKey` implemented as "list
 * everything and scan" is O(n) over someone's whole store, it races, and a
 * wrapper that has to compose two calls is describing an operation that belongs
 * in the API.
 *
 * `getByKey` therefore targets a real route — `GET /documents/by-key/{key}`
 * (verified live 2026-07-28).
 *
 * Documents are **project-scoped**: every route below accepts an optional
 * `?project=`, resolved per call, then from the client's default, and otherwise
 * left to the server (which picks the account's default project). Vars are not
 * — see `src/vars.ts`.
 *
 * @module
 */

import type { ResolvedConfig } from "./config.ts";
import { type HttpResponse, path, type RequestOptions } from "./http.ts";
import { type Doc, type DocFormat, unwrap } from "./types.ts";

/**
 * The slice of `W6wClient` this namespace needs: the transport, plus
 * the resolved configuration it reads the **default project** out of. Structural
 * rather than a concrete client type, so the namespace stays independently
 * constructible in a test and this module never imports the client back.
 */
export interface DocumentsHost {
  /** The resolved configuration; only `project` is read. */
  readonly config: ResolvedConfig;
  /** Perform one request. */
  request<T>(options: RequestOptions): Promise<HttpResponse<T>>;
}

/**
 * Per-call options shared by every document operation.
 *
 * `project` overrides the client's default for this one call. Omitted
 * everywhere, the server resolves the account's default project; an unknown id
 * is `400 unknown_project`.
 */
export interface DocumentOptions {
  /** Project id to scope this call to. */
  project?: string;
}

/**
 * The body of `documents.create`.
 *
 * Addressed by `key`, because that is how the server addresses a create (D6).
 */
export interface DocumentCreateInput {
  /** Non-empty, ≤128 characters, unique per scope + project. `409 document_exists` if taken. */
  key: string;
  /** Raw text; stored verbatim and never parsed. */
  content: string;
  /** Format hint; the server defaults it to `"text"`. */
  format?: DocFormat;
  /** Free text. */
  description?: string;
}

/**
 * The body of `documents.update`. Every field is optional; an omitted field is
 * left alone.
 *
 * **`key` is deliberately absent.** The server's PATCH body has no `key` and the
 * key is immutable, so there is no field here to put one in — the type is what
 * enforces it, not a comment.
 */
export interface DocumentPatch {
  /** Replacement content. */
  content?: string;
  /** Replacement format hint. */
  format?: DocFormat;
  /** Replacement description. */
  description?: string;
}

/**
 * The `documents` namespace on a `W6wClient`.
 *
 * @example
 * ```ts
 * const doc = await client.documents.create({ key: "welcome", content: "# Hi" });
 * await client.documents.update(doc.id, { content: "# Hello" });
 * await client.documents.delete(doc.id);
 * ```
 */
export class DocumentsApi {
  readonly #host: DocumentsHost;

  /**
   * @param host - The client this namespace issues requests through.
   */
  constructor(host: DocumentsHost) {
    this.#host = host;
  }

  /**
   * The project this call is scoped to: per-call argument first, then the
   * client's default, then nothing at all — an absent value means "no
   * `?project=`", which is how the caller asks for the account's default.
   */
  #project(options?: DocumentOptions): string | undefined {
    return options?.project ?? this.#host.config.project ?? undefined;
  }

  /**
   * List the caller's documents.
   *
   * @param options - Optional per-call project scope.
   * @returns The documents, unwrapped from the `documents` envelope.
   * @throws {ApiError} On any non-2xx, e.g. `400 unknown_project`.
   */
  async list(options?: DocumentOptions): Promise<Doc[]> {
    const res = await this.#host.request<unknown>({
      method: "GET",
      path: "/documents",
      query: { project: this.#project(options) },
    });
    return unwrap<Doc[]>(res, "documents");
  }

  /**
   * Fetch one document by its server-issued id.
   *
   * @param id - The `doc_…` id.
   * @param options - Optional per-call project scope.
   * @returns The document.
   * @throws {ApiError} `404 unknown_document` when there is no such id.
   */
  async get(id: string, options?: DocumentOptions): Promise<Doc> {
    const res = await this.#host.request<unknown>({
      method: "GET",
      path: path`/documents/${id}`,
      query: { project: this.#project(options) },
    });
    return unwrap<Doc>(res, "document");
  }

  /**
   * Fetch one document by the `key` its author chose.
   *
   * The key is percent-encoded at interpolation by the `path` tag, which is not
   * ceremony: the server accepts any non-empty key up to 128 characters, so
   * `"a/b"` and `".."` are keys a user can legitimately create, and concatenated
   * naively they address a *different route* — `".."` resolves to the list
   * endpoint and returns every document with a `200` and no error anywhere.
   *
   * Encoding, never validation: a key the server accepts is sent as-is
   * (encoded). This method does not reject, trim or canonicalise a key —
   * refusing one locally would make a document that exists permanently
   * unreadable through this client.
   *
   * @param key - The document key, sent encoded and otherwise untouched.
   * @param options - Optional per-call project scope.
   * @returns The document.
   * @throws {ApiError} `404 unknown_document` when there is no such key.
   */
  async getByKey(key: string, options?: DocumentOptions): Promise<Doc> {
    const res = await this.#host.request<unknown>({
      method: "GET",
      path: path`/documents/by-key/${key}`,
      query: { project: this.#project(options) },
    });
    return unwrap<Doc>(res, "document");
  }

  /**
   * Create a document under a caller-chosen key.
   *
   * @param input - `key` and `content` are required; `format` defaults server-side to `"text"`.
   * @param options - Optional per-call project scope.
   * @returns The created document (the server answers `201`).
   * @throws {ApiError} `409 document_exists` on a duplicate key — the code reaches the caller intact.
   */
  async create(input: DocumentCreateInput, options?: DocumentOptions): Promise<Doc> {
    const res = await this.#host.request<unknown>({
      method: "POST",
      path: "/documents",
      query: { project: this.#project(options) },
      // Assembled field by field rather than forwarded wholesale: the body that
      // goes on the wire is exactly the four documented fields, and `undefined`
      // ones are dropped by JSON serialisation.
      body: {
        key: input.key,
        content: input.content,
        format: input.format,
        description: input.description,
      },
    });
    return unwrap<Doc>(res, "document");
  }

  /**
   * Patch a document's content, format or description.
   *
   * Addressed by id, never by key, and the key itself cannot be changed.
   *
   * @param id - The `doc_…` id.
   * @param patch - The fields to change; omitted fields are left alone.
   * @param options - Optional per-call project scope.
   * @returns The updated document.
   * @throws {ApiError} `404 unknown_document` when there is no such id.
   */
  async update(id: string, patch: DocumentPatch, options?: DocumentOptions): Promise<Doc> {
    const res = await this.#host.request<unknown>({
      method: "PATCH",
      path: path`/documents/${id}`,
      query: { project: this.#project(options) },
      body: {
        content: patch.content,
        format: patch.format,
        description: patch.description,
      },
    });
    return unwrap<Doc>(res, "document");
  }

  /**
   * Delete a document.
   *
   * Returns nothing: the server's `{ok: true}` carries no information a caller
   * can use, and unwrapping it to a value would invite `if (await delete(...))`.
   * Deleting an unknown id is `404 unknown_document`, **not** a silent success —
   * the delete is not idempotent and this method does not pretend otherwise.
   *
   * @param id - The `doc_…` id.
   * @param options - Optional per-call project scope.
   * @throws {ApiError} `404 unknown_document` when there is no such id.
   */
  async delete(id: string, options?: DocumentOptions): Promise<void> {
    await this.#host.request<unknown>({
      method: "DELETE",
      path: path`/documents/${id}`,
      query: { project: this.#project(options) },
    });
  }
}
