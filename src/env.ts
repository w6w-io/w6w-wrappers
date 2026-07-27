/**
 * The **only** module in this package that reads the environment.
 *
 * `docs/implementation.md` §2 (MECHANISM PIN — instance state, never globals)
 * pins exactly one environment-reading module per wrapper; everything else
 * receives resolved configuration as a value. That is not a style preference:
 * it is what keeps `Deno.env` / `process.env` out of the operation modules, so
 * no operation can silently acquire a dependency on ambient state and every
 * env-var behaviour has exactly one seam to exercise in tests (§9).
 *
 * The spec names that module `src/config.ts`; this package splits the *reading*
 * (here) from the *resolving* (`src/config.ts`, which imports this file and is
 * the only caller). The invariant the pin is about — one place touches the
 * environment — is unchanged, and it is enforced mechanically: the repo gate
 * greps the whole `src/` tree for `Deno.env|process.env` and requires exactly
 * one matching file.
 *
 * The read is a **capability probe**, not a runtime assumption, so the same
 * source runs under Deno, Node and Bun (`docs/implementation.md` §1: the client
 * core is runtime-neutral TypeScript over Web-standard globals). Where neither
 * runtime object is present the value degrades to "unset" rather than throwing —
 * a browser bundle of this package must still construct a client from explicit
 * arguments.
 *
 * @module
 */

/** Environment variable holding the server **origin** (see `src/config.ts`). */
export const ENV_BASE_URL = "W6W_BASE_URL";

/** Environment variable holding the bearer token. */
export const ENV_TOKEN = "W6W_TOKEN";

/**
 * The shape this module probes for. Declared structurally rather than with
 * `any` (which `deno lint`'s recommended rules reject) so the probe stays
 * typed: every hop is optional, because the whole point is that none of it may
 * exist.
 */
interface EnvCapableGlobal {
  Deno?: { env?: { get?: (name: string) => string | undefined } };
  process?: { env?: Record<string, string | undefined> };
}

/**
 * Read one environment variable, or `undefined` when it carries no usable
 * value.
 *
 * **A variable that is set but empty — or whitespace-only — reads as ABSENT.**
 * `W6W_BASE_URL=`, `W6W_BASE_URL="   "` and an unset `W6W_BASE_URL` are all the
 * same thing here, and the precedence chain falls through all three to the next
 * source (and ultimately to a configuration error).
 *
 * This deviates deliberately from the pinned snippet in
 * `docs/implementation.md` §2, which reads `g.Deno.env.get(name) ?? undefined`.
 * A nullish coalesce does **not** convert `""` to `undefined`, so an empty
 * `W6W_BASE_URL` would survive as a value, reach the join rule, and resolve to
 * the relative URL `"/api"` — exactly the browser same-origin default that §2
 * forbids a library from having. A relative base URL fails later, somewhere
 * else, with a message about the request rather than about the configuration.
 *
 * So the check below is a **truthiness/trim** check and not a nullish one, on
 * purpose. Do not "tidy" it back to `??`. An empty-string environment variable
 * is not a hypothetical: a Docker `ENV`/`--build-arg` that was never given a
 * value produces exactly this, and it looks absent in every log line while
 * behaving as present in every `??`.
 *
 * The value is returned verbatim (not trimmed) — normalising the *shape* of a
 * base URL belongs to `src/config.ts`, which owns the join rule.
 *
 * @param name - The variable to read, e.g. {@linkcode ENV_BASE_URL}.
 * @returns The value, or `undefined` if unset, empty, blank or unavailable.
 */
export function readEnv(name: string): string | undefined {
  const g = globalThis as unknown as EnvCapableGlobal;
  let value: string | undefined;
  if (g.Deno?.env?.get) value = g.Deno.env.get(name);
  else if (g.process?.env) value = g.process.env[name];
  else return undefined;
  if (value === undefined || value.trim().length === 0) return undefined;
  return value;
}
