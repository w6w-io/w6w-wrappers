/**
 * Flags and environment in, a configured `@w6w/sdk` client out.
 *
 * This module is the CLI's whole configuration story, and it is deliberately
 * thin: **no transport, no base-path joining, no HTTP error mapping lives here**
 * — all of that is the SDK's, and duplicating any of it in a second package is
 * how two clients of one API start disagreeing about what a base URL means.
 * What belongs here is the one thing the SDK cannot know: that a command line
 * has a flag which outranks the environment variable.
 *
 * ```
 * CLI flag (--base-url / --token)  >  environment variable  >  nothing (an error)
 * ```
 *
 * The resolved values are passed to the SDK **explicitly**, and the SDK is never
 * left to read the environment on the CLI's behalf. That is a mechanism choice,
 * not a stylistic one: the CLI has to be able to say *which* source it was
 * looking at when it reports a missing or malformed value, and a library that
 * reads the environment behind you cannot tell you that. It also means every
 * environment-dependent behaviour in this package has one seam a test can
 * substitute — {@linkcode EnvReader} — instead of a real process environment
 * that only one test at a time can own.
 *
 * @module
 */

import { ConfigError, type FetchLike, W6WClient } from "@w6w/sdk";
import type { GlobalOptions } from "./args.ts";

/**
 * Reads one environment variable, or `undefined` where the host has none.
 *
 * The same shape as `src/runtime.ts`'s `env`, which is the only thing in this
 * package that reads a real process environment; everything downstream — this
 * module included — receives it as a value.
 */
export type EnvReader = (name: string) => string | undefined;

/** Environment variable holding the server **origin**. Falls behind `--base-url`. */
export const ENV_BASE_URL = "W6W_BASE_URL";

/** Environment variable holding the bearer token. Falls behind `--token`. */
export const ENV_TOKEN = "W6W_TOKEN";

/** An environment with nothing in it. The default, so nothing leaks in by accident. */
export const NO_ENV: EnvReader = () => undefined;

/**
 * Read an environment variable, treating a blank value as **absent**.
 *
 * `W6W_BASE_URL=`, `W6W_BASE_URL="   "` and an unset `W6W_BASE_URL` are the same
 * thing: all three fall through the precedence chain to the next source, and
 * ultimately to a usage error naming both sources.
 *
 * The check is a trim-and-emptiness test and deliberately **not** a nullish
 * coalesce. `??` does not convert `""`, so a set-but-empty variable would
 * survive as a value and be resolved into an empty base URL — every request
 * then goes out relative, which fails much later with a message about a request
 * instead of here with a message about configuration. A blank variable is not
 * exotic: `export W6W_TOKEN=`,
 * a Dockerfile `ENV` with no build argument behind it, and a CI variable whose
 * template did not interpolate all produce exactly this, and all three look
 * unset in every log line.
 *
 * The surviving value is returned **verbatim**; trimming applies to the test,
 * not to the value.
 *
 * @param env - The environment seam to read through.
 * @param name - The variable to read.
 * @returns The value, or `undefined` when it is unset or blank.
 */
export function envValue(env: EnvReader, name: string): string | undefined {
  const value = env(name);
  if (value === undefined || value.trim().length === 0) return undefined;
  return value;
}

/**
 * Apply the precedence rule to one setting.
 *
 * A flag that was **given** wins outright, even when what it was given is empty:
 * that is a value the user typed, and quietly consulting the environment behind
 * an explicit `--token=` would be the CLI second-guessing them. (It still does
 * not produce a usable value — an empty flag reaches the same error — but it
 * gets there without a detour through the environment.) Only an **absent** flag
 * falls through.
 */
function resolve(flag: string | undefined, env: EnvReader, name: string): string | undefined {
  if (flag !== undefined) return flag;
  return envValue(env, name);
}

/**
 * A value the CLI cannot work with, phrased as a usage error.
 *
 * Every message names **both** sources, because "which one was I supposed to
 * set?" is the only question the user has at this point, and the answer depends
 * on whether they are typing a command or writing a deploy manifest.
 *
 * The type is the SDK's {@linkcode ConfigError}, not a new one: the split that
 * matters is configuration-versus-API, and it already exists. A `ConfigError`
 * means the request never left this machine — `src/exit.ts` maps it to the usage
 * code. An `ApiError` means the server answered.
 */
function configError(problem: string, flag: string, variable: string, hint: string): ConfigError {
  return new ConfigError(
    `${problem} Set it with ${flag} or the ${variable} environment variable. ${hint}`,
  );
}

/**
 * Reject a base URL the CLI cannot actually send a request to.
 *
 * A relative base (`/api`, `localhost:8080`) is a **usage** error and is caught
 * here, at the point the user can still do something about it. Left alone it
 * becomes a transport failure much later, reported as "the server may be down" —
 * a misdiagnosis a user will act on, restarting a server that was never the
 * problem. The scheme is required for the same reason: `localhost:8080` parses
 * as a URL whose scheme is `localhost:`, not as a host.
 */
function requireAbsolute(baseUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw configError(
      `The w6w base URL must be an absolute origin, and \`${baseUrl}\` is not one.`,
      "--base-url",
      ENV_BASE_URL,
      "It looks like `https://api.example.com` — scheme and host, no path.",
    );
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw configError(
      `The w6w base URL must be an http or https origin, and \`${baseUrl}\` is not one.`,
      "--base-url",
      ENV_BASE_URL,
      "It looks like `https://api.example.com` — scheme and host, no path.",
    );
  }
  return baseUrl;
}

/**
 * Characters that cannot be carried in an HTTP header value: the C0 controls,
 * `DEL`, and anything above the single-byte range.
 *
 * A token is normally opaque ASCII, so this rejects almost nothing real — except
 * the one thing that happens constantly, which is a trailing newline on a token
 * read out of a file (`W6W_TOKEN=$(cat token.txt)`). Left unchecked that reaches
 * the header builder and comes back as a bare `TypeError` from outside anyone's
 * error model: a stack trace, for a typo.
 */
function isUnsendable(token: string): boolean {
  for (const character of token) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f || code > 0xff) return true;
  }
  return false;
}

/** The token, checked well enough that it can actually be put on the wire. */
function requireSendableToken(token: string): string {
  if (!isUnsendable(token)) return token;
  throw configError(
    "The w6w API token contains a character that cannot be sent in an HTTP header " +
      "(a control character, such as a newline).",
    "--token",
    ENV_TOKEN,
    "A token read out of a file usually carries a trailing newline — strip it.",
  );
}

/** Anything the caller wants to hand the client beyond the global flags. */
export interface ClientOptions {
  /**
   * Transport override, passed straight to the SDK. The seam the test suite
   * runs against; nothing in normal operation sets it.
   */
  fetch?: FetchLike;
  /** Default project id for the project-scoped operations. */
  project?: string;
}

/**
 * Build the API client for one invocation.
 *
 * Call this **lazily**, when a command has decided it needs the API — never at
 * module load, and never on the help or `--version` path, which must resolve
 * with no token configured and no server reachable.
 *
 * @param globals - The parsed global flags.
 * @param env - The environment seam. Defaults to an empty environment.
 * @param options - Transport and default project.
 * @returns A configured client.
 * @throws {ConfigError} When the base URL or token is missing or unusable — a usage error.
 */
export function createClient(
  globals: GlobalOptions,
  env: EnvReader = NO_ENV,
  options: ClientOptions = {},
): W6WClient {
  const baseUrl = resolve(globals.baseUrl, env, ENV_BASE_URL);
  if (baseUrl === undefined || baseUrl.trim().length === 0) {
    throw configError(
      "No w6w base URL is configured.",
      "--base-url",
      ENV_BASE_URL,
      "It holds the server's origin, like `https://api.example.com`; the API is served at its root, so no path is appended.",
    );
  }

  const token = resolve(globals.token, env, ENV_TOKEN);
  if (token === undefined || token.trim().length === 0) {
    throw configError(
      "No w6w API token is configured.",
      "--token",
      ENV_TOKEN,
      "Every w6w API command is authenticated.",
    );
  }

  // The join rule (origin in, base path appended, never doubled) belongs to the
  // SDK and is applied by the constructor. Nothing here re-derives it — read it
  // back off `client.config.baseUrl` if you need to know where a request went.
  return new W6WClient({
    baseUrl: requireAbsolute(baseUrl.trim()),
    token: requireSendableToken(token),
    project: options.project,
    fetch: options.fetch,
  });
}
