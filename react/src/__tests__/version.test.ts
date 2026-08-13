/**
 * The lockstep bet, made mechanical and local — the same purpose as
 * `../../../node/tests/version_test.ts`, adapted to Node's test runner and to
 * this lane's shallower manifest set: react has no `deno.json` to cross-check,
 * so there are 3 manifest-comparison cases here rather than node's 4, plus the
 * barrel re-export case both suites share.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { VERSION } from "../version.ts";

function readManifestVersion(path: string): string {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as { version?: unknown };
  if (typeof parsed.version !== "string") {
    throw new Error(`${path} has no string "version" field`);
  }
  return parsed.version;
}

const packageJsonPath = fileURLToPath(new URL("../../package.json", import.meta.url));
/** The monorepo's shared source of truth: this package sits at `packages/wrappers/react`. */
const sharedVersionPath = fileURLToPath(new URL("../../../VERSION", import.meta.url));

test("VERSION is a semver-shaped string", () => {
  assert.match(VERSION, /^\d+\.\d+\.\d+(?:[-+].+)?$/);
});

test("src/version.ts matches package.json", () => {
  assert.equal(VERSION, readManifestVersion(packageJsonPath));
});

test("src/version.ts matches the monorepo's packages/wrappers/VERSION", () => {
  assert.equal(VERSION, readFileSync(sharedVersionPath, "utf8").trim());
});

test("the barrel re-exports VERSION", async () => {
  const mod = (await import("../../mod.ts")) as { VERSION: string };
  assert.equal(mod.VERSION, VERSION);
});
