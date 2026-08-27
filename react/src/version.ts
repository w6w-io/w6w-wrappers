/**
 * The published version of this package.
 *
 * It is the same string as `package.json`'s `version` and the monorepo's
 * `packages/wrappers/VERSION` — the single source of truth all three w6w
 * wrappers publish under (see `docs/parity.md`); this lane joins the same
 * lockstep. `src/__tests__/version.test.ts` fails if any of those disagree,
 * so this constant cannot drift silently. (Only `package.json` and the shared
 * `VERSION` file, not `deno.json` — this lane has none.)
 *
 * The explicit `: string` annotation is required, not decorative: it is not
 * about JSR here (this lane never publishes there, see README) — the
 * monorepo's `release.yml` `verify` step reads this exact file with a
 * `from_regex` pattern (`VERSION:\s*string\s*=\s*"([^"]+)"`) to cross-check
 * every wrapper's version in lockstep, and that pattern depends on the literal
 * `: string` shape being present.
 */
export const VERSION: string = "0.7.0";
