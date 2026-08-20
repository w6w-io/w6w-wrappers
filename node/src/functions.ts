/**
 * `client.functions.*` — run a Function by the name you gave it.
 *
 * A Function is a canonical, vendor-stable interface bound to one swappable app
 * Action. Before this namespace existed, calling one meant the URN operation:
 *
 * ```ts
 * await client.run({ urn: "fn_a9b39917-cd4e-4eea-ab89-c3d079684193", payload });
 * ```
 *
 * — an opaque id, buried inside an object, for a Function the user named
 * `send-email`. `client.run` is still the right tool when the caller is
 * *dispatching* something whose kind it does not know; it is the wrong tool for
 * "call my send-email Function", which is what this is:
 *
 * ```ts
 * await client.functions.run("send-email", { payload: { to, subject, html } });
 * ```
 *
 * The name is the FIRST argument, matching `workflows.run(id, opts?)` — the
 * namespace already shaped this way — so all three runnable kinds read alike.
 *
 * ID OR KEY, one argument. The server's `/functions/{idOrKey}/invoke` accepts
 * either, because the two shapes cannot collide: an id carries a kind prefix and
 * therefore an underscore, and a key is kebab-case, which forbids one. So this
 * takes no flag and no prefix to say which you meant — pass whichever you have.
 */
import type { ResolvedConfig } from "./config.ts";
import { ApiError } from "./errors.ts";
import { type HttpResponse, path, type RequestOptions } from "./http.ts";

/**
 * What this namespace needs from the client — the same narrow seam
 * `WorkflowsApi` takes, so it is constructible in a test and this module never
 * imports the client back.
 */
export interface FunctionsHost {
  /** The resolved configuration. */
  readonly config: ResolvedConfig;
  /** Perform one request. */
  request<T>(options: RequestOptions): Promise<HttpResponse<T>>;
}

/** Per-call options for `functions.run`. */
export interface FunctionRunOptions {
  /**
   * The Function's canonical inputs, by input key.
   *
   * Named `payload` rather than `inputs` so every runnable kind in this SDK
   * takes the same word — the wire spells it `inputs` for a Function and
   * `input` for an Endpoint, and reconciling that is exactly the job of a
   * wrapper. Defaults to `{}` rather than being omitted: the server's parameter
   * schemas are written against an object, and `{}` says "no input" where an
   * absent key says "I forgot".
   */
  payload?: Record<string, unknown>;
}

/**
 * The `functions` namespace on a `W6WClient`.
 *
 * @example
 * ```ts
 * const output = await client.functions.run("send-email", {
 *   payload: { to: "ada@example.com", subject: "Hi", html: "<p>Hello</p>" },
 * });
 * ```
 */
export class FunctionsApi {
  readonly #host: FunctionsHost;

  /**
   * @param host - The client this namespace issues requests through.
   */
  constructor(host: FunctionsHost) {
    this.#host = host;
  }

  /**
   * Run one Function and return its output.
   *
   * Returns the Function's OUTPUT, not an envelope. `client.run` returns a
   * `kind`-discriminated envelope because the caller does not know what the URN
   * will resolve to; here the kind is in the method name, so the discriminant
   * would be a field the caller has to unwrap to learn nothing.
   *
   * @param name - The Function's key (`"send-email"`) or its `fn_…` id. Percent-encoded into the path.
   * @param options - `payload`, the Function's canonical inputs.
   * @returns The Function's output, unwrapped from the `output` envelope.
   * @throws {ApiError} `404 unknown_function` when no Function of that name exists for the caller.
   * @throws {ApiError} `422 function_incomplete` when the Function has no runnable `impl`.
   * @throws {ApiError} `bad_response` when a success body carries no `output` key at all.
   */
  async run(name: string, options?: FunctionRunOptions): Promise<unknown> {
    const res = await this.#host.request<unknown>({
      method: "POST",
      path: path`/functions/${name}/invoke`,
      body: { inputs: options?.payload ?? {} },
    });

    // Deliberately NOT `unwrap(res, "output")`. That helper treats `null` as
    // "the server did not send what it promised" — correct for a `documents` or
    // `vars` envelope, where null is never a document. It is wrong here: a
    // Function's output is an OPAQUE pass-through, and an action that returns
    // nothing yields `{"output": null}`, which is a successful run and not a
    // malformed response. So the guard is PRESENCE of the key, not truthiness
    // of the value.
    const body = res.body;
    if (typeof body !== "object" || body === null || !("output" in body)) {
      throw new ApiError(
        res.status,
        "bad_response",
        `Server returned a ${res.status} with no "output" in the response body.`,
        body,
      );
    }
    return (body as { output: unknown }).output;
  }
}
