/**
 * Type-level pins for the list-row summaries: `deno check` is the assertion.
 * The runtime test only keeps the file in the suite.
 */
import { assertEquals } from "@std/assert";
import type {
  ConnectionSummary,
  FunctionSummary as PublicFunctionSummary,
  Me,
} from "../src/types.ts";
import type { FunctionSummary } from "../src/console/functions.ts";
import type { EndpointSummary } from "../src/console/endpoints.ts";
import type {
  FunctionRead,
  FunctionUpsertOptions,
  ReliabilityServiceMembers,
} from "../src/console/mod.ts";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true
  : false;
const pin = <_T extends true>() => 0;
// Exact, required types: an optional, widened or dropped field makes Equal false (TS2344).
pin<Equal<PublicFunctionSummary["archivedAt"], string | null>>();
pin<Equal<FunctionSummary["archivedAt"], string | null>>();
pin<Equal<EndpointSummary["archivedAt"], string | null>>();
pin<Equal<ConnectionSummary["credentialId"], string | null>>();
pin<Equal<EndpointSummary["status"], "draft" | "ready">>();
pin<Equal<EndpointSummary["incomplete"], boolean>>();
// Requiredness: an optional key is not assignable to its required counterpart.
pin<
  Equal<
    Required<Pick<PublicFunctionSummary, "archivedAt">>,
    Pick<PublicFunctionSummary, "archivedAt">
  >
>();
pin<Equal<Required<Pick<FunctionSummary, "archivedAt">>, Pick<FunctionSummary, "archivedAt">>>();
pin<
  Equal<Required<Pick<ConnectionSummary, "credentialId">>, Pick<ConnectionSummary, "credentialId">>
>();
pin<
  Equal<
    Required<Pick<EndpointSummary, "archivedAt" | "status" | "incomplete">>,
    Pick<EndpointSummary, "archivedAt" | "status" | "incomplete">
  >
>();

Deno.test("summary types carry the list fields the server sends", () => {
  const publicArchived: PublicFunctionSummary["archivedAt"] = null as string | null;
  const consoleArchived: FunctionSummary["archivedAt"] = null as string | null;
  const endpointArchived: EndpointSummary["archivedAt"] = null as string | null;
  const status: EndpointSummary["status"] = "draft" as "draft" | "ready";
  const ready: EndpointSummary["status"] = "ready";
  // @ts-expect-error the union is closed
  const bad: EndpointSummary["status"] = "published";
  const incomplete: EndpointSummary["incomplete"] = true as boolean;
  const members: ReliabilityServiceMembers | undefined = undefined;
  const read: FunctionRead | undefined = undefined;
  const opts: FunctionUpsertOptions | undefined = undefined;
  assertEquals(
    [
      publicArchived,
      consoleArchived,
      endpointArchived,
      status,
      ready,
      bad,
      incomplete,
      members,
      read,
      opts,
    ]
      .length,
    10,
  );
});

// Ownership fields are optional (absent = older server) and closed to the two scopes.
pin<Equal<ConnectionSummary["accessScope"], "account" | "user" | undefined>>();
pin<Equal<NonNullable<Me["capabilities"]>["userScopedCredentials"], boolean | undefined>>();

// Keep-alive fields (contract 0.19.0) are optional (absent = older server or the built-in row);
// the timestamps are nullable (`null` = unknown / not failing).
pin<Equal<ConnectionSummary["autoRefresh"], boolean | undefined>>();
pin<Equal<ConnectionSummary["lastRefreshedAt"], string | null | undefined>>();
pin<Equal<ConnectionSummary["refreshFailingSince"], string | null | undefined>>();
