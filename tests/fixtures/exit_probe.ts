/**
 * A real `w6w` process, with a fake server behind it.
 *
 * `tests/exit_codes_test.ts` spawns this and asserts the **process exit status**,
 * because that is the only thing a shell script ever sees. Asserting that a
 * mapping function returned a number proves nothing about the binary: break the
 * host's `exit()` so it always ends the process with success and every
 * in-process assertion still passes, while every CI job that checks `$?` starts
 * treating failures as successes. This fixture closes that gap — it goes through
 * the same `main()` and the same `systemRuntime().exit()` the binary does.
 *
 * The only thing substituted is the transport, chosen by the first argument:
 *
 *     deno run --allow-env exit_probe.ts <scenario> [w6w arguments…]
 *
 * The environment is whatever the spawning test set, read through the same seam
 * as always. Nothing here reaches a network.
 */

import { exitCodeFor, main } from "../../mod.ts";
import type { CommandRegistry } from "../../mod.ts";
import { systemRuntime } from "../../src/runtime.ts";
import type { FetchLike } from "@w6w/sdk";

/** A canned JSON response. */
function reply(status: number, body: unknown): Promise<Response> {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
}

/** What the fake server does, per scenario. */
const SCENARIOS: Record<string, FetchLike> = {
  /** An ordinary success. */
  ok: () => reply(200, { ok: true }),
  /** A queued run: the server answered before the workflow finished. */
  queued: () => reply(202, { runId: "run_1", status: "queued" }),
  /** A run that finished, and failed. Reported in the envelope, not as an error. */
  failed: () =>
    reply(200, {
      runId: "run_1",
      status: "failed",
      error: { message: "node nd_1 threw" },
    }),
  /** Auth failure. */
  unauthorized: () => reply(401, { error: { code: "unauthorized", message: "token rejected" } }),
  /** Not found. */
  missing: () => reply(404, { error: { code: "unknown_workflow", message: "no such workflow" } }),
  /** An app or its upstream vendor failed during execute. */
  upstream: () => reply(424, { error: { code: "app_failed", message: "vendor said no" } }),
  /** A server error. */
  broken: () => reply(500, { error: { code: "internal", message: "it broke" } }),
  /** A proxy's HTML error page, where JSON was expected. */
  proxy: () =>
    Promise.resolve(
      new Response("<html>502 Bad Gateway</html>", {
        status: 502,
        headers: { "content-type": "text/html" },
      }),
    ),
  /** The server could not be reached at all. */
  unreachable: () => Promise.reject(new TypeError("connection refused")),
};

const runtime = systemRuntime();
const [scenario, ...argv] = runtime.args;

const commands: CommandRegistry = {
  /** Stands in for any read: one request, render, done. */
  me: async (context) => {
    const { body } = await context.client().request({ method: "GET", path: "/me" });
    context.out.emit(body, () => `answered: ${JSON.stringify(body)}`);
  },

  /**
   * The one command whose exit code depends on the *body* rather than on the
   * status. Reaching the mapping at all is the assertion that a failed run did
   * not raise: an implementation that treated it as an error would never print
   * the line above it.
   */
  "workflows run": async (context) => {
    const wait = context.invocation.options.wait === true;
    const { body } = await context.client().request<{ status?: string }>({
      method: "POST",
      path: "/workflows/wf_1/run",
      query: { wait },
    });
    context.out.emit(body, () => `answered: ${JSON.stringify(body)}`);
    return wait ? exitCodeFor(body) : undefined;
  },
};

const transport = SCENARIOS[scenario];
if (transport === undefined) {
  // Guarded rather than defaulted: without a transport the SDK would fall back
  // to the host's own, and a mistyped scenario would quietly become the one
  // thing no test in this package may do — a real network call.
  runtime.stderr(`exit_probe: unknown scenario \`${scenario}\``);
  runtime.exit(99);
}

const code = await main(argv, runtime, { env: runtime.env, fetch: transport, commands });
runtime.exit(code);
