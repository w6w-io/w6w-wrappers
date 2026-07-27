/**
 * The lockstep bet, made mechanical and local.
 *
 * `docs/parity.md` says one `VERSION` governs all three w6w wrappers and that a
 * manifest disagreeing with it is the manifest that is wrong. This suite is what
 * turns that promise into a failing test instead of a release-day surprise: it
 * fails if the version string differs in any of the four places it appears —
 * `src/version.ts`, `deno.json`, `package.json`, and the monorepo's shared
 * `packages/wrappers/VERSION`.
 *
 * Every path is resolved from this file's own location (`import.meta.url`), never
 * from the process working directory, so the suite behaves the same however it is
 * invoked.
 */

import { assertEquals, assertMatch } from "@std/assert";
import { VERSION } from "../src/version.ts";

const denoJsonUrl = new URL("../deno.json", import.meta.url);
const packageJsonUrl = new URL("../package.json", import.meta.url);
/** The monorepo's shared source of truth: this repo sits at `packages/wrappers/node`. */
const sharedVersionUrl = new URL("../../VERSION", import.meta.url);

async function readManifestVersion(url: URL): Promise<string> {
  const parsed = JSON.parse(await Deno.readTextFile(url)) as { version?: unknown };
  if (typeof parsed.version !== "string") {
    throw new Error(`${url.pathname} has no string "version" field`);
  }
  return parsed.version;
}

async function readSharedVersion(): Promise<string> {
  try {
    return (await Deno.readTextFile(sharedVersionUrl)).trim();
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      // Fail loudly naming the path, and never fall back to a copy vendored in
      // this repo — a stale pinned copy defeats the whole mechanism.
      throw new Error(
        `lockstep: the shared version file was not found at ${sharedVersionUrl.pathname}. ` +
          "This repo is checked out at packages/wrappers/node in the w6w monorepo and reads " +
          "packages/wrappers/VERSION as ../../VERSION from this test file (docs/parity.md).",
      );
    }
    throw err;
  }
}

Deno.test("VERSION is a semver-shaped string", () => {
  assertMatch(VERSION, /^\d+\.\d+\.\d+(?:[-+].+)?$/);
});

Deno.test("src/version.ts matches deno.json", async () => {
  assertEquals(VERSION, await readManifestVersion(denoJsonUrl));
});

Deno.test("src/version.ts matches package.json", async () => {
  assertEquals(VERSION, await readManifestVersion(packageJsonUrl));
});

Deno.test("deno.json and package.json agree", async () => {
  assertEquals(await readManifestVersion(denoJsonUrl), await readManifestVersion(packageJsonUrl));
});

Deno.test("src/version.ts matches the monorepo's packages/wrappers/VERSION", async () => {
  assertEquals(VERSION, await readSharedVersion());
});

Deno.test("the barrel re-exports VERSION", async () => {
  const mod = await import("../mod.ts");
  assertEquals(mod.VERSION, VERSION);
});
