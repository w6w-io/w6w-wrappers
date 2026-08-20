/**
 * `client.endpoints.*` — run an Endpoint by the key you gave it.
 *
 * An Endpoint is a callable entry point that dispatches to whatever it targets:
 * an app action, a Function, or a Workflow. Before this namespace existed,
 * calling one meant `client.run({ urn: "ep_…" })` — an opaque id, buried inside
 * an object, for an Endpoint the user named `send-email`. Now:
 *
 * ```ts
 * await client.endpoints.run("send-email", { payload: { to, subject } });
 * ```
 *
 * The name is the FIRST argument, matching `workflows.run` and `functions.run`,
 * so all three runnable kinds read alike.
 *
 * ID OR KEY, one argument: `/endpoints/{idOrKey}/invoke` accepts either, because
 * an id carries a kind prefix (and so an underscore) while a key is kebab-case
 * (which forbids one). No flag, no prefix — pass whichever you have.
 *
 * UNLIKE `functions.run`, THIS RETURNS AN ENVELOPE, and that asymmetry is the
 * honest one: a Function's kind is settled by the method name, but an Endpoint
 * dispatches to one of three things and the caller genuinely does not know which
 * answered. The `kind` discriminant is information here, not ceremony — and the
 * Workflow arm is asynchronous (`202`, a `runId`) where the other two are not.
 */
import type { ResolvedConfig } from "./config.ts";
import { ApiError } from "./errors.ts";
import { type HttpResponse, path, type RequestOptions } from "./http.ts";
import type { RunEnvelope } from "./types.ts";

/**
 * What this namespace needs from the client — the same narrow seam
 * `WorkflowsApi` and `FunctionsApi` take.
 */
export interface EndpointsHost {
  /** The resolved configuration. */
  readonly config: ResolvedConfig;
  /** Perform one request. */
  request<T>(options: RequestOptions): Promise<HttpResponse<T>>;
}

/** Per-call options for `endpoints.run`. */
export interface EndpointRunOptions {
  /**
   * The Endpoint's input, by input key.
   *
   * Named `payload` for the same reason as `functions.run`: one word across
   * every runnable kind, even though the wire spells this one `input`.
   */
  payload?: Record<string, unknown>;
}

/**
 * The `endpoints` namespace on a `W6WClient`.
 *
 * @example
 * ```ts
 * const envelope = await client.endpoints.run("send-email", { payload: { to } });
 * if (envelope.kind === "workflow") console.log(envelope.runId); // async arm
 * ```
 */
export class EndpointsApi {
  readonly #host: EndpointsHost;

  /**
   * @param host - The client this namespace issues requests through.
   */
  constructor(host: EndpointsHost) {
    this.#host = host;
  }

  /**
   * Run one Endpoint; the envelope's `kind` says which arm answered.
   *
   * @param name - The Endpoint's key (`"send-email"`) or its `ep_…` id. Percent-encoded into the path.
   * @param options - `payload`, the Endpoint's input.
   * @returns The `kind`-discriminated envelope, returned exactly as it arrived.
   * @throws {ApiError} `404 unknown_endpoint` when no Endpoint of that name exists for the caller.
   * @throws {ApiError} `bad_response` when a success body carries no string `kind`.
   */
  async run(name: string, options?: EndpointRunOptions): Promise<RunEnvelope> {
    const res = await this.#host.request<unknown>({
      method: "POST",
      path: path`/endpoints/${name}/invoke`,
      body: { input: options?.payload ?? {} },
    });

    const body = res.body;
    // The same guard `run.ts` applies, for the same reason: an object-only
    // check lets `{}` and `[]` through and hands back an envelope whose `kind`
    // is `undefined` at runtime — a lie the compiler cannot catch.
    if (
      typeof body !== "object" || body === null ||
      typeof (body as { kind?: unknown }).kind !== "string"
    ) {
      throw new ApiError(
        res.status,
        "bad_response",
        `Server returned a ${res.status} with no "kind" in the response body.`,
        body,
      );
    }
    // Returned as it arrived — an unknown `kind` reaches the caller intact.
    return body as RunEnvelope;
  }
}
