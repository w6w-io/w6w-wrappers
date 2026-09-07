/**
 * `w6w team …` — the caller's account team at the command line.
 *
 * Six commands, **one SDK call each**. Nothing here composes two requests,
 * filters a list or resolves an id by scanning: a wrapper that has to compose
 * two calls is describing an operation that belongs in the API
 * (`README.md`, "What a wrapper is"), and the CLI is a wrapper like the other
 * two.
 *
 * Every handler does the same four steps, in order: read its own arguments,
 * call one method on `client.team`, render, return. Errors are not caught here
 * — `main()` reports a throw once, on stderr, and maps it to an exit code
 * through `src/exit.ts`, so an `ApiError` exits 2 and a usage error exits 1
 * without any command deciding that for itself.
 *
 * **No `--project` anywhere in this group.** Team membership is account-wide,
 * not project-scoped — unlike `w6w documents`, which takes the flag on every
 * command.
 *
 * @module
 */

import type { CommandHandler, CommandRegistry } from "../../mod.ts";
import type { TeamInviteInput, TeamMember } from "@w6w/sdk";
import type { Styles } from "../output.ts";
import { argument, noExtraArguments, requiredFlag, table, textFlag } from "./shared.ts";

/** One team member, as a table row. */
function memberRow(member: TeamMember): string[] {
  return [member.userId, member.email ?? "—", member.displayName ?? "—", member.role];
}

/** The roster: one line per member. There is always at least one — the owner. */
function renderMembers(members: TeamMember[], styles: Styles): string {
  return table(["USER ID", "EMAIL", "NAME", "ROLE"], members.map(memberRow), styles);
}

const members: CommandHandler = async (context) => {
  noExtraArguments(context, 0);
  const roster = await context.client().team.members();
  context.out.emit(roster, (styles) => renderMembers(roster, styles));
};

/**
 * `w6w team invite [--email <email>] [--role <role>]` — both flags optional.
 *
 * Omitting `--email` mints an OPEN invite: a shareable link with no target
 * address. Omitting `--role` leaves it to the server's own default
 * (`"member"`). The one-time `token`/`redemptionLink` this prints are never
 * fetchable again — a caller that loses this output has to revoke and
 * re-invite.
 */
const invite: CommandHandler = async (context) => {
  noExtraArguments(context, 0);
  const input: TeamInviteInput = {};
  const email = textFlag(context, "email");
  if (email !== undefined) input.email = email;
  const role = textFlag(context, "role");
  if (role !== undefined) input.role = role;

  const created = await context.client().team.invite(input);
  context.out.emit(created, (styles) => {
    const target = created.email ?? styles.dim("(open invite — no target email)");
    const heading = `Invited ${styles.bold(target)} ${styles.dim(`(${created.id})`)}`;
    return [heading, `Redemption link: ${created.redemptionLink}`].join("\n");
  });
};

/** `w6w team invites` — the open (pending, unrevoked, unexpired) ones only. */
const invites: CommandHandler = async (context) => {
  noExtraArguments(context, 0);
  const pending = await context.client().team.invites();
  context.out.emit(pending, (styles) => {
    if (pending.length === 0) return styles.dim("No open invites.");
    return table(
      ["ID", "EMAIL", "ROLE", "EXPIRES"],
      pending.map((inv) => [
        inv.id,
        inv.email ?? styles.dim("(open)"),
        inv.role ?? "—",
        inv.expiresAt ?? "—",
      ]),
      styles,
    );
  });
};

/**
 * `w6w team revoke-invite <id>` — and **nothing on stdout**.
 *
 * The server answers `{ok:true}`; the wrapper contract unwraps that to
 * nothing at all, so the only machine-readable part of the answer is the exit
 * code. `--json` suppresses the human confirmation, printing an empty stdout
 * rather than a payload the contract says does not exist.
 */
const revokeInvite: CommandHandler = async (context) => {
  const id = argument(context, 0, "an invite id (see: `w6w team invites`)");
  noExtraArguments(context, 1);
  await context.client().team.revokeInvite(id);
  context.out.note(`Revoked ${id}.`);
};

/**
 * `w6w team set-role <userId> --role <role>` — the userId is positional, the
 * new role is a required flag.
 */
const setRole: CommandHandler = async (context) => {
  const userId = argument(context, 0, "a member's user id (see: `w6w team members`)");
  noExtraArguments(context, 1);
  const role = requiredFlag(context, "role", "--role <role>");
  const member = await context.client().team.setRole(userId, role);
  context.out.emit(
    member,
    (styles) => `Set ${styles.bold(member.userId)} to ${styles.bold(member.role)}.`,
  );
};

/** `w6w team remove-member <userId>` — and **nothing on stdout**, same shape as `revoke-invite`. */
const removeMember: CommandHandler = async (context) => {
  const userId = argument(context, 0, "a member's user id (see: `w6w team members`)");
  noExtraArguments(context, 1);
  await context.client().team.removeMember(userId);
  context.out.note(`Removed ${userId}.`);
};

/**
 * The six `w6w team` commands, keyed by the canonical command path.
 *
 * The keys are the generated help tree's `path` values joined by a space,
 * which are `endpoints.json`'s `naming.cli` spellings —
 * `tests/cmd_team_test.ts` asserts the two sets are the same, so a command
 * cannot be registered under a name the help does not document, or
 * documented under a name nothing runs.
 */
export const TEAM_COMMANDS: CommandRegistry = {
  "team members": members,
  "team invite": invite,
  "team invites": invites,
  "team revoke-invite": revokeInvite,
  "team set-role": setRole,
  "team remove-member": removeMember,
};
