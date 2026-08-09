/**
 * Type-level assertions against `src/types.ts`, made runtime-observable.
 *
 * A plain compile-time check (`const s: WorkflowStatus = "archived"`) with no
 * corresponding `Deno.test` would never run and could bit-rot silently; wiring
 * it into an assertion means `deno task check` fails loudly the moment a
 * mutant narrows the union back, and `deno task test` still reports it as one
 * more passing assertion today.
 */

import { assertEquals } from "@std/assert";
import type { WorkflowStatus } from "../src/types.ts";

Deno.test("WorkflowStatus includes archived", () => {
  // Fails `deno task check` if the union narrows back to "draft" | "active" —
  // a mutant reverting T2.5.1's widening is a compile error here, not just a
  // runtime assertion that could pass by accident.
  const s: WorkflowStatus = "archived";
  assertEquals(s, "archived");
});
