/**
 * The command registry — every command this build can run, in one map.
 *
 * `main()` dispatches by canonical command path (`"documents list"`,
 * `"vars get-by-name"`), so this file is a union of the per-group registries and
 * nothing else: no logic, no ordering, no conditionals. A command group owns its
 * handlers, its arguments and its help; joining them is all that happens here.
 *
 * **This is the merge point.** Each command-group node adds one import and one
 * spread, and nothing else in the file moves — which is what keeps two groups
 * landing in the same release from conflicting over it. A group that is not
 * spread in below is not runnable: `main()` answers a command with no handler
 * with a usage error saying it is not available in this build, which is a better
 * answer than a silent success.
 *
 * @module
 */

import type { CommandRegistry } from "../../mod.ts";
import { DOCUMENT_COMMANDS } from "./documents.ts";
import { VAR_COMMANDS } from "./vars.ts";
import { ME_COMMANDS } from "./me.ts";
import { CONNECTION_COMMANDS } from "./connections.ts";
import { FUNCTION_COMMANDS } from "./functions.ts";
import { NAMED_RUN_COMMANDS } from "./named-run.ts";
import { WORKFLOW_COMMANDS } from "./workflows.ts";
import { RUN_COMMANDS } from "./run.ts";

export { DOCUMENT_COMMANDS } from "./documents.ts";
export { VAR_COMMANDS } from "./vars.ts";
export { ME_COMMANDS } from "./me.ts";
export { CONNECTION_COMMANDS } from "./connections.ts";
export { FUNCTION_COMMANDS } from "./functions.ts";
export { NAMED_RUN_COMMANDS } from "./named-run.ts";
export { WORKFLOW_COMMANDS } from "./workflows.ts";
export { RUN_COMMANDS } from "./run.ts";

/** Every wired command, keyed by canonical command path. */
export const COMMANDS: CommandRegistry = {
  ...DOCUMENT_COMMANDS,
  ...VAR_COMMANDS,
  ...ME_COMMANDS,
  ...CONNECTION_COMMANDS,
  ...WORKFLOW_COMMANDS,
  ...FUNCTION_COMMANDS,
  ...NAMED_RUN_COMMANDS,
  ...RUN_COMMANDS,
};
