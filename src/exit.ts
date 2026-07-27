/**
 * The exit-code mapping — the CLI's machine-readable half of every answer.
 *
 * A command's stdout is for a human or for `jq`; its exit code is for the shell
 * that called it, and it is the only part of the answer a CI job reads. So the
 * four codes are a contract, generated into `src/help.generated.ts` from the
 * shared wrapper surface contract rather than restated here:
 *
 * | code | meaning |
 * |---|---|
 * | 0 | success — including help, and including a queued or running workflow |
 * | 1 | usage error — a bad invocation, or a client that was never configured |
 * | 2 | API error — the server was reached and answered with a failure |
 * | 3 | run failure — `--wait` came back with a run whose status is `failed` |
 *
 * Two of those are traps, and {@linkcode exitCodeFor} exists so that every
 * command falls into them the same way instead of each deciding for itself:
 *
 * - **A queued run is success.** Enqueuing a workflow answers before the run
 *   finishes; the caller asked for it to start, and it started.
 * - **A failed run is data, not an error.** The server reports a run-level
 *   failure inside the response envelope, with an ordinary success status — so
 *   the SDK returns it rather than raising, and only the CLI turns it into a
 *   distinct code. Keeping it apart from an API error is the whole point: a
 *   failed workflow and an unreachable server demand opposite responses, and a
 *   script that cannot tell them apart will retry the wrong one.
 *
 * @module
 */

import { ApiError } from "@w6w/sdk";
import { EXIT_API_ERROR, EXIT_RUN_FAILURE, EXIT_SUCCESS, EXIT_USAGE } from "./help.generated.ts";

export { EXIT_API_ERROR, EXIT_RUN_FAILURE, EXIT_SUCCESS, EXIT_USAGE };

/** The run status that means the workflow itself failed. */
const FAILED = "failed";

/**
 * Whether an outcome is a terminal run that failed.
 *
 * Structural on purpose: the run envelope arrives from the SDK as data, and the
 * only field this mapping is entitled to read is the one the exit-code contract
 * names.
 */
function isFailedRun(outcome: unknown): boolean {
  if (typeof outcome !== "object" || outcome === null) return false;
  return (outcome as { status?: unknown }).status === FAILED;
}

/**
 * Whether a thrown value is an error raised by the server having answered.
 *
 * `instanceof` is the primary test. The name check behind it is not ceremony:
 * an installed CLI resolves `@w6w/sdk` through the package manager, and a host
 * that ends up with two copies of the SDK on disk produces an `ApiError` that
 * fails `instanceof` against *this* copy's class. Falling back to the name keeps
 * a genuine server failure out of the usage bucket in that case.
 */
function isApiError(outcome: unknown): boolean {
  return outcome instanceof ApiError ||
    (outcome instanceof Error && outcome.name === "ApiError");
}

/**
 * Map a command's outcome — its return value, or the error it threw — to an
 * exit code.
 *
 * This is the only place any command decides what to exit with; there are no
 * other codes anywhere in the CLI.
 *
 * ```ts
 * try {
 *   return exitCodeFor(await client.workflows.run(id, { wait: true }));
 * } catch (err) {
 *   return exitCodeFor(err);
 * }
 * ```
 *
 * @param outcome - A returned payload, or a caught error.
 * @returns One of the four codes above.
 */
export function exitCodeFor(outcome: unknown): number {
  // The server answered, and what it answered was a failure.
  if (isApiError(outcome)) return EXIT_API_ERROR;
  // Anything else that was thrown never reached the server: a configuration
  // error (no base URL, no token, a token that cannot be sent) or a local bug.
  // The split matters — an API error means the request was made and refused,
  // and a caller that retries on it would be retrying nothing here.
  if (outcome instanceof Error) return EXIT_USAGE;
  // Returned data. A run that came back failed is the one payload that is not
  // success; every other payload is.
  if (isFailedRun(outcome)) return EXIT_RUN_FAILURE;
  return EXIT_SUCCESS;
}
