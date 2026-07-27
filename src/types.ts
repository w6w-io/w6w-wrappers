/**
 * Wire types, transcribed — plus the one envelope reader every operation uses.
 *
 * The shapes below are **transcribed** from `docs/implementation.md` §5 (which
 * reads them off the studio's API types), not imported or vendored from it: this
 * package publishes to npm and JSR and cannot depend on a private workspace
 * source. Field names are the wire's, verbatim — no camel/snake drift, no
 * renaming, no "nicer" aliases. A client that quietly renames a wire field makes
 * every error message and every documentation example wrong.
 *
 * Unknown fields are **tolerated, never rejected**: these are `interface`s, so a
 * field the server adds tomorrow simply arrives and is ignored by an older
 * client. Nothing here validates a response against a closed schema.
 *
 * Every exported member carries an explicit type — JSR publishes this file as
 * TypeScript source and rejects inferred public types ("no slow types",
 * `docs/implementation.md` §1).
 *
 * @module
 */

import { ApiError } from "./errors.ts";
import type { HttpResponse } from "./http.ts";

/**
 * A document's format hint.
 *
 * A **hint only**: it does not gate the content, which the server stores
 * verbatim and never parses. Defaults to `"text"` server-side when a create
 * omits it.
 */
export type DocFormat = "text" | "markdown" | "yaml" | "html" | "json";

/**
 * A document — a keyed blob of text in a project's document store.
 *
 * `id` is the server-issued `doc_…` handle used for update and delete; `key` is
 * the human-chosen name used at create time (and by `documents.getByKey`).
 * `key` is **immutable** — it is not in any patch body
 * (`docs/implementation.md` §7).
 *
 * Timestamps are ISO-8601 **strings**, exactly as they arrive. They are not
 * parsed into `Date`: date parsing is a policy that would have to be identical
 * in three languages and reversible for round-trips, so the wrappers adopt it
 * together or not at all.
 */
export interface Doc {
  /** Server-issued id, `doc_…`. Addresses update and delete. */
  id: string;
  /** Caller-chosen key: non-empty, ≤128 characters, unique per scope + project. */
  key: string;
  /** Raw text. Stored verbatim and never parsed by the server. */
  content: string;
  /** Format hint. */
  format: DocFormat;
  /** Free-text description; `""` when unset. */
  description: string;
  /** ISO-8601 timestamp. */
  createdAt: string;
  /** ISO-8601 timestamp. */
  updatedAt: string;
}

/** A variable's declared type. `value` is validated against it **server-side**. */
export type VarType = "string" | "number" | "boolean" | "json";

/**
 * A typed variable, scoped by tenant/subject.
 *
 * `value` is **`unknown`** on purpose: it is whatever the declared
 * {@linkcode VarType} allows, including an arbitrary JSON document, and a
 * wrapper that modelled its internals would be wrong for someone. Narrow it at
 * the call site after checking `type`.
 */
export interface Var {
  /** Server-issued id, `var_…`. Addresses update and delete. */
  id: string;
  /** Caller-chosen name, matching `^[a-z_][a-z0-9_]*$`. Immutable. */
  name: string;
  /** Declared type. */
  type: VarType;
  /** The value, opaque pass-through. */
  value: unknown;
  /** Free-text description; `""` when unset. */
  description: string;
  /** ISO-8601 timestamp. */
  createdAt: string;
  /** ISO-8601 timestamp. */
  updatedAt: string;
}

/**
 * Read one payload out of the server's envelope, or fail loudly.
 *
 * The server wraps every asset body under a key — `{documents: […]}`,
 * `{document: …}`, `{vars: […]}`, `{var: …}` — and the wrapper's contract is to
 * hand the caller the payload, never the wrapper (`docs/implementation.md` §6).
 *
 * A `2xx` body **missing** that key is a `bad_response`-class bug and raises,
 * rather than returning `undefined`. That is the pinned behaviour, and the
 * reason is worth keeping next to the code: three wrappers each returning a
 * silent `undefined` here would turn a server regression into a `TypeError`
 * thrown somewhere in the caller's code, minutes later, with nothing pointing
 * back at the response that caused it.
 *
 * This is the *only* place an operation module inspects a body's shape. It is
 * not schema validation: extra keys are ignored, and the payload itself is cast,
 * never checked.
 *
 * @param res - The response returned by the transport.
 * @param key - The envelope key to read, e.g. `"document"`, `"vars"`.
 * @returns The unwrapped payload.
 * @throws {ApiError} `bad_response` when the body is not an object or lacks the key.
 */
export function unwrap<T>(res: HttpResponse<unknown>, key: string): T {
  const body = res.body;
  if (typeof body === "object" && body !== null) {
    const value = (body as Record<string, unknown>)[key];
    if (value !== undefined) return value as T;
  }
  throw new ApiError(
    res.status,
    "bad_response",
    `Server returned a ${res.status} with no "${key}" in the response body.`,
    body,
  );
}
