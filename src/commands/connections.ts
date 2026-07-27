/**
 * `w6w connections list` — discovery, and nothing more (D4).
 *
 * One command, one SDK call, no filters and no pagination: the operation
 * exists so a caller can find a `conn_…` id to pass to `w6w run`, and nothing
 * about creating, testing or reconnecting an app lives here — that is
 * `outOfScope` in `endpoints.json` for this version.
 *
 * @module
 */

import type { CommandHandler, CommandRegistry } from "../../mod.ts";
import type { ConnectionSummary } from "@w6w/sdk";
import type { Styles } from "../output.ts";
import { noExtraArguments, table } from "./shared.ts";

/** One connection, as a table row. */
function row(connection: ConnectionSummary): string[] {
  return [connection.id, connection.appId, connection.state, connection.displayName];
}

/** The listing: one line per connection, or a line saying there are none. */
function renderList(connections: ConnectionSummary[], styles: Styles): string {
  if (connections.length === 0) return styles.dim("No connections.");
  return table(["ID", "APP", "STATE", "NAME"], connections.map(row), styles);
}

const list: CommandHandler = async (context) => {
  noExtraArguments(context, 0);
  const connections = await context.client().connections.list();
  context.out.emit(connections, (styles) => renderList(connections, styles));
};

export const CONNECTION_COMMANDS: CommandRegistry = {
  "connections list": list,
};
