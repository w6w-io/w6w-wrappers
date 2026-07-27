/**
 * The help renderer.
 *
 * `--help` is the CLI's documentation — not a pointer to documentation, the thing
 * itself. So it resolves at all three levels (root, group, command), it never
 * authenticates, it never reads configuration, it never makes a network call, and
 * nothing in this file does any I/O at all: every function here takes a tree and
 * returns a string. The caller decides whether that string goes to stdout with
 * exit 0 (help was asked for) or to stderr with exit 1 (the invocation was
 * unknown or incomplete).
 *
 * The tree itself is generated from the shared wrapper surface contract — see
 * `scripts/gen-help.ts`. This file only lays it out.
 *
 * @module
 */

import { HELP_TREE } from "./help.generated.ts";
import type { HelpCommand, HelpGroup, HelpParam, HelpTree } from "./help.generated.ts";

/** Where a command path landed in the tree. */
export type Resolution =
  | { kind: "root" }
  | { kind: "group"; group: HelpGroup }
  | { kind: "command"; command: HelpCommand; group: HelpGroup | null }
  | { kind: "unknown"; token: string; group: HelpGroup | null };

/** The column descriptions start in, matching `docs/cli.md`. */
const LABEL_WIDTH = 22;
/** Where prose wraps. Narrower than the 100-column source limit, on purpose. */
const PROSE_WIDTH = 76;

function row(label: string, description: string): string {
  return `  ${label.padEnd(LABEL_WIDTH)} ${description}`.trimEnd();
}

function wrap(text: string, width: number = PROSE_WIDTH): string[] {
  const lines: string[] = [];
  let current = "";
  for (const word of text.split(/\s+/)) {
    if (current === "") {
      current = word;
    } else if (`${current} ${word}`.length <= width) {
      current = `${current} ${word}`;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current !== "") lines.push(current);
  return lines;
}

function section(title: string, lines: string[], into: string[]): void {
  if (lines.length === 0) return;
  into.push("", title, ...lines);
}

/**
 * Resolves a command path against the tree.
 *
 * Handles the `w6w info` style aliases declared by the contract, so an alias
 * prints the help of the command it stands for rather than a second copy.
 */
export function resolve(path: string[], tree: HelpTree = HELP_TREE): Resolution {
  if (path.length === 0) return { kind: "root" };

  const matches = (candidate: string[], against: string[]) =>
    candidate.length === against.length && candidate.every((token, i) => token === against[i]);
  const pathsOf = (command: HelpCommand) => [command.path, ...command.aliases];

  for (const command of tree.commands) {
    if (pathsOf(command).some((candidate) => matches(candidate, path))) {
      return { kind: "command", command, group: null };
    }
  }

  const group = tree.groups.find((candidate) => candidate.name === path[0]) ?? null;
  if (!group) return { kind: "unknown", token: path[0], group: null };
  if (path.length === 1) return { kind: "group", group };

  for (const command of group.commands) {
    if (pathsOf(command).some((candidate) => matches(candidate, path))) {
      return { kind: "command", command, group };
    }
  }
  return { kind: "unknown", token: path[1], group };
}

/** Root help: what w6w is, its command groups, and the global flags. */
export function renderRootHelp(tree: HelpTree = HELP_TREE): string {
  const lines: string[] = [`${tree.binary} — ${tree.tagline}`];
  section("USAGE", [`  ${tree.usage}`], lines);
  section("COMMANDS", [
    ...tree.commands.map((command) => row(command.name, command.short)),
    ...tree.groups.map((group) => row(group.name, group.summary)),
  ], lines);
  section(
    "GLOBAL OPTIONS",
    tree.globalFlags.map((flag) => row(flag.display, flag.description)),
    lines,
  );
  section("EXAMPLES", tree.examples.map((example) => `  ${example}`), lines);
  lines.push("", `  Docs: ${tree.docsUrl}`);
  return lines.join("\n");
}

/** Group help: the commands in that group, and nothing else. */
export function renderGroupHelp(group: HelpGroup, tree: HelpTree = HELP_TREE): string {
  const lines: string[] = [`${tree.binary} ${group.name} — ${group.headline}`];
  section("USAGE", [`  ${group.usage}`], lines);
  section(
    "COMMANDS",
    group.commands.map((command) => row(command.name, command.short)),
    lines,
  );
  section("OPTIONS", group.options.map((param) => row(param.display, param.description)), lines);
  section("EXAMPLES", group.examples.map((example) => `  ${example}`), lines);
  return lines.join("\n");
}

/** Command help: summary, usage, arguments, flags, and a runnable example. */
export function renderCommandHelp(command: HelpCommand, tree: HelpTree = HELP_TREE): string {
  const args = command.params.filter((param: HelpParam) => param.kind === "argument");
  const flags = command.params.filter((param: HelpParam) => param.kind === "flag");
  const lines: string[] = [`${tree.binary} ${command.path.join(" ")} — ${command.headline}`];
  section("USAGE", [`  ${command.usage}`], lines);
  section("ARGUMENTS", args.map((param) => row(param.display, param.description)), lines);
  section("OPTIONS", flags.map((param) => row(param.display, param.description)), lines);
  section(
    "ALIASES",
    command.aliases.map((alias) => `  ${tree.binary} ${alias.join(" ")}`),
    lines,
  );
  section("EXAMPLES", command.examples.map((example) => `  ${example}`), lines);
  section(
    "NOTES",
    command.notes.flatMap((note, index) => {
      const body = wrap(note).map((line) => `  ${line}`);
      return index === 0 ? body : ["", ...body];
    }),
    lines,
  );
  return lines.join("\n");
}

/** Renders whichever level a resolution landed on. */
export function renderHelp(resolution: Resolution, tree: HelpTree = HELP_TREE): string {
  switch (resolution.kind) {
    case "command":
      return renderCommandHelp(resolution.command, tree);
    case "group":
      return renderGroupHelp(resolution.group, tree);
    case "unknown":
      return resolution.group ? renderGroupHelp(resolution.group, tree) : renderRootHelp(tree);
    default:
      return renderRootHelp(tree);
  }
}
