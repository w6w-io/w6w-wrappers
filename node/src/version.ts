/**
 * The published version of this package.
 *
 * It is the same string as `deno.json`'s `version`, `package.json`'s `version`
 * and the monorepo's `packages/wrappers/VERSION` — the single source of truth all
 * three w6w wrappers publish under (see `docs/parity.md`). `tests/version_test.ts`
 * fails if any of those four disagree, so this constant cannot drift silently.
 *
 * The explicit `: string` annotation is required, not decorative: JSR publishes
 * this file as TypeScript source and rejects inferred public types ("no slow
 * types").
 */
export const VERSION: string = "0.5.0";
