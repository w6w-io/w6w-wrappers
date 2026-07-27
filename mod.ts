/**
 * `@w6w/sdk` — the package barrel.
 *
 * This file is the package's single public entry point. `deno.json` exports it to
 * JSR as `./mod.ts` (TypeScript source, verbatim) and `tsconfig.build.json`
 * compiles it to `dist/mod.js` + `dist/mod.d.ts` for npm. One authored source
 * tree, two registries (D7).
 *
 * **Every operation module must be re-exported here.** A module that is not
 * re-exported from this barrel is not part of the published surface: JSR and npm
 * consumers can only reach what this file exports, and the conformance runner
 * walks the client built from these exports. Adding an operation therefore means
 * adding its export line here in the same change.
 *
 * @module
 */

export { VERSION } from "./src/version.ts";

// Transport core (T2.1.2): the client, its configuration and the error model.
export { W6wClient } from "./src/client.ts";
export { ApiError, ConfigError } from "./src/errors.ts";
export {
  BASE_PATH,
  type FetchLike,
  joinBaseUrl,
  type ResolvedConfig,
  type W6wClientOptions,
} from "./src/config.ts";
export type { HttpMethod, HttpResponse, QueryParams, RequestOptions } from "./src/http.ts";
// Exported because `W6wClient.request` is public: a host reaching an endpoint
// this version does not model yet must have the same encoding-at-interpolation
// tag the operation modules use, or it will concatenate a caller value into a
// path by hand — the one bug the encoding pin exists to prevent.
export { path } from "./src/http.ts";
