/**
 * The help generator.
 *
 * `w6w --help` is the CLI's documentation, and hand-written help is drift waiting
 * to happen: an operation changes, three wrappers get updated, and the help text
 * keeps describing last version's behaviour with total confidence. So the command
 * tree is **generated** from the shared wrapper surface contract that all three
 * wrappers implement — the sibling `../../endpoints.json`, resolved from this
 * module's own location and never from the process working directory.
 *
 * ── MECHANISM PIN — generation happens at DEVELOPMENT time, never at runtime ──
 *
 * The contract file sits beside this repo, among its two sibling wrapper repos —
 * it is not part of the published package. A `@w6w/cli` installed from npm on
 * someone else's machine has no `../../endpoints.json` at all, so a CLI that read
 * it at runtime would work here in development and break for every installed
 * user. That is unsound by construction, not merely inconvenient.
 *
 * The mechanism instead:
 *
 *   1. `deno task gen:help` runs this script, which reads the contract and writes
 *      the checked-in module `src/help.generated.ts`.
 *   2. The runtime imports **only** that generated module. Nothing under `src/`
 *      opens a JSON file, and nothing under `src/` needs a `--allow-read` grant
 *      for the contract.
 *   3. `tests/help_test.ts` re-runs `renderHelpModule()` and compares its output
 *      to the checked-in file **byte for byte**, so a contract change that was not
 *      regenerated fails the suite rather than shipping stale help.
 *
 * ── What is generated and what is hand-written ──
 *
 * Generated from the contract: the command tree (group and command names derived
 * from each operation's `naming.cli`), each command's `summary`, its parameters,
 * the `me` operation's `cliAlias`, the global flags with their env vars and
 * aliases, and the exit codes.
 *
 * Hand-written here, because it has nowhere to live in the contract (and, per
 * `docs/cli.md`, is deliberately the part that changes least): the root tagline,
 * group summaries, per-parameter descriptions, and the runnable examples. Adding
 * an operation to the contract without adding its prose here makes this script
 * **throw**, naming what is missing — the prose cannot silently fall behind.
 *
 * Deliberately NOT copied: each operation's `notes`. Those are written for wrapper
 * implementers, not for users, and they cite file paths inside private
 * repositories — which must never reach a published help string. The two `NOTES`
 * blocks the CLI help specification requires — for `workflows run` and `run` — are
 * transcribed by hand below, in user-facing language.
 *
 * @module
 */

// ---------------------------------------------------------------------------
// The shape of the contract this script reads.
// ---------------------------------------------------------------------------

/** One parameter of an operation, as declared in the contract. */
export interface ContractParam {
  name: string;
  in: string;
  type: string;
  required: boolean;
}

/** One operation of the shared surface contract. */
export interface ContractOperation {
  name: string;
  summary: string;
  method: string;
  path: string;
  status: string;
  cliAlias?: string;
  params: ContractParam[];
  naming: { ts: string; python: string; cli: string };
}

/** The CLI-only block of the contract. */
export interface ContractCli {
  binary: string;
  globalFlags: { name: string; alias?: string; type: string; env?: string; source?: string }[];
  exitCodes: Record<string, string>;
}

/** The parts of the contract this generator reads. */
export interface Contract {
  contractVersion: string;
  operations: ContractOperation[];
  cli: ContractCli;
}

// ---------------------------------------------------------------------------
// Hand-written prose. Everything else comes from the contract.
// ---------------------------------------------------------------------------

const TAGLINE = "command-line client for the w6w workflow platform";
const DOCS_URL = "https://w6w.dev/docs/cli";

const ROOT_EXAMPLES = [
  "w6w me",
  "w6w workflows list",
  "w6w workflows run wf_01H… --wait",
  "w6w documents list",
  "w6w vars create greeting --type string --value hello",
  `w6w run conn_01H… --action send_email --payload '{"to":"a@b.com"}'`,
];

/** Summary shown for each group, in root help and in that group's own headline. */
const GROUP_SUMMARIES: Record<string, string> = {
  connections: "Inspect connections",
  workflows: "List and run workflows",
  documents: "Create, read, update and delete documents",
  vars: "Create, read, update and delete variables",
};

const GROUP_EXAMPLES: Record<string, string[]> = {
  connections: ["w6w connections list"],
  workflows: ["w6w workflows list", "w6w workflows run wf_01HQ8N --wait"],
  documents: ["w6w documents list", "w6w documents get doc_01HQ8N"],
  vars: ["w6w vars list", "w6w vars create greeting --type string --value hello"],
};

/** At least one runnable example per command — the part people actually copy. */
const COMMAND_EXAMPLES: Record<string, string[]> = {
  "me": ["w6w me", "w6w info"],
  "connections.list": ["w6w connections list", "w6w connections list --json"],
  "workflows.list": ["w6w workflows list", "w6w workflows list --project prj_01HQ8N"],
  "workflows.run": [
    "w6w workflows run wf_01HQ8N --var email=a@b.com",
    "w6w workflows run wf_01HQ8N --wait --json",
    `w6w workflows run wf_01HQ8N --input '{"email":"a@b.com"}'`,
  ],
  "documents.list": ["w6w documents list", "w6w documents list --project prj_01HQ8N"],
  "documents.get": ["w6w documents get doc_01HQ8N"],
  "documents.getByKey": ["w6w documents get-by-key onboarding-email"],
  "documents.create": [
    `w6w documents create onboarding-email --content "Welcome aboard!" --format markdown`,
  ],
  "documents.update": [`w6w documents update doc_01HQ8N --content "Welcome aboard!"`],
  "documents.delete": ["w6w documents delete doc_01HQ8N"],
  "vars.list": ["w6w vars list"],
  "vars.get": ["w6w vars get var_01HQ8N"],
  "vars.getByName": ["w6w vars get-by-name greeting"],
  "vars.create": ["w6w vars create greeting --type string --value hello"],
  "vars.update": ["w6w vars update var_01HQ8N --value goodbye"],
  "vars.delete": ["w6w vars delete var_01HQ8N"],
  "run": [
    `w6w run conn_01HQ8N --action send_email --payload '{"to":"a@b.com"}'`,
    `w6w run wf_01HQ8N --payload '{"email":"a@b.com"}'`,
  ],
};

/**
 * The two `NOTES` blocks `docs/cli.md` calls non-optional: the queued/waiting/
 * failed distinction, and the kind-tagged result of `run`. Written for users —
 * the contract's own `notes` fields cite private repository paths and are not
 * copied (see the module docstring).
 */
const COMMAND_NOTES: Record<string, string[]> = {
  "workflows.run": [
    "Without --wait the run is queued and the command returns immediately with a run id and " +
    'status "queued". With --wait the CLI returns when the run finishes or the server\'s wait ' +
    'window expires — a run still in progress is reported as "running", which is not an error.',
    'A run that finished with status "failed" exits 3, so --wait is usable in CI without ' +
    "parsing stdout.",
  ],
  "run": [
    "The result is tagged by kind. A connection action and a function return their value " +
    'directly; a workflow returns a run id and status "queued" and is not waited on — use ' +
    '"w6w workflows run <id> --wait" when you need to wait, set variables, or pass a trigger. ' +
    'Documents and variables are not URNs: address them with "w6w documents" and "w6w vars".',
  ],
};

/**
 * Parameter descriptions, keyed `<operation>.<param>` first and by bare parameter
 * name second. A parameter matching neither is a generator error, so a parameter
 * added to the contract cannot reach help undescribed.
 */
const PARAM_HELP: Record<string, string> = {
  // Shared fallbacks, by bare parameter name.
  "project": "Project to scope to (default: the account's default project)",
  "description": "Human-readable description",
  "format": "Content format hint: text|markdown|yaml|html|json (default: text)",
  "content": "Document content, as raw text",
  "type": "Value type: string|number|boolean|json",
  "value": "Value, validated against the variable's type",

  // Per-operation, where the bare name is ambiguous or the wording matters.
  "workflows.run.id": "Workflow id (see: w6w workflows list)",
  "workflows.run.wait": "Wait for the run to reach a terminal state",
  "workflows.run.variables": "Set a run variable (repeatable)",
  "workflows.run.trigger": "Trigger payload, as a JSON string",
  "workflows.run.input": "Run input, as a JSON string",
  "documents.get.id": "Document id (see: w6w documents list)",
  "documents.update.id": "Document id (see: w6w documents list)",
  "documents.delete.id": "Document id (see: w6w documents list)",
  "documents.getByKey.key": "Document key, as chosen at creation",
  "documents.create.key": "Document key to create (unique per project)",
  "vars.get.id": "Variable id (see: w6w vars list)",
  "vars.update.id": "Variable id (see: w6w vars list)",
  "vars.delete.id": "Variable id (see: w6w vars list)",
  "vars.getByName.name": "Variable name, as chosen at creation",
  "vars.create.name": "Variable name to create (must match ^[a-z_][a-z0-9_]*$)",
  "run.urn": "conn_… | wf_… | fn_… | ep_… (see: w6w connections list, w6w workflows list)",
  "run.action": "Action to invoke (connection URNs only)",
  "run.payload": "Input object, as a JSON string",
};

/**
 * CLI spellings that differ from the contract's parameter name. `variables` is
 * the only real one: the API takes an object, the CLI takes repeatable
 * `--var key=value` pairs (`docs/cli.md`).
 */
const FLAG_OVERRIDES: Record<string, { flag: string; placeholder: string | null }> = {
  "workflows.run.variables": { flag: "--var", placeholder: "<key=value>" },
  "workflows.run.trigger": { flag: "--trigger", placeholder: "<json>" },
};

/** Descriptions and value placeholders for the contract's global flags. */
const GLOBAL_FLAG_HELP: Record<string, { placeholder: string | null; description: string }> = {
  "--base-url": { placeholder: "<url>", description: "API base URL" },
  "--token": { placeholder: "<token>", description: "API token" },
  "--json": { placeholder: null, description: "Output raw JSON instead of a table" },
  "--no-color": { placeholder: null, description: "Disable colored output" },
  "--version": { placeholder: null, description: "Print the CLI version" },
  "--help": { placeholder: null, description: "Show help for any command" },
};

/** Names for the contract's numeric exit codes, so the runtime can refer to them. */
const EXIT_CODE_NAMES: Record<string, string> = {
  "0": "SUCCESS",
  "1": "USAGE",
  "2": "API_ERROR",
  "3": "RUN_FAILURE",
};

/** `--json` is a global flag, but `docs/cli.md` lists it in every command's OPTIONS. */
const JSON_FLAG_NAME = "--json";

// ---------------------------------------------------------------------------
// The tree the runtime consumes. These interfaces are emitted into the generated
// module verbatim, so `src/help.ts` can import them from there.
// ---------------------------------------------------------------------------

const TREE_TYPES = `/** One argument or flag of a command, ready to render. */
export interface HelpParam {
  /** The contract's parameter name. */
  name: string;
  /** \`argument\` renders under ARGUMENTS, \`flag\` under OPTIONS. */
  kind: "argument" | "flag";
  /** What the help line shows, e.g. \`<id>\` or \`--format <f>\`. */
  display: string;
  description: string;
  required: boolean;
}

/** One of the CLI's global flags. */
export interface HelpGlobalFlag {
  name: string;
  alias: string | null;
  type: string;
  env: string | null;
  /** What the help line shows, e.g. \`-v, --version\`. */
  display: string;
  description: string;
}

/** One runnable command — a leaf of the tree. */
export interface HelpCommand {
  /** The contract operation this command implements, e.g. \`documents.create\`. */
  operation: string;
  /** The command path below the binary, e.g. \`["documents", "create"]\`. */
  path: string[];
  name: string;
  /** Alternative paths that resolve to this same command. */
  aliases: string[][];
  /** The contract's summary, verbatim. */
  summary: string;
  /** The summary as it appears in a one-line COMMANDS listing. */
  short: string;
  /** The summary as it appears after the em dash in the command's own help. */
  headline: string;
  usage: string;
  /** The contract's \`naming.cli\` spelling, verbatim. */
  naming: string;
  /** The contract's \`status\` — server readiness, not wrapper completeness. */
  status: string;
  params: HelpParam[];
  examples: string[];
  notes: string[];
}

/** A group of commands, e.g. \`w6w documents\`. Groups are never runnable. */
export interface HelpGroup {
  name: string;
  summary: string;
  headline: string;
  usage: string;
  commands: HelpCommand[];
  /** Flags every command in the group accepts. */
  options: HelpParam[];
  examples: string[];
}

/** The whole command tree. */
export interface HelpTree {
  binary: string;
  contractVersion: string;
  tagline: string;
  usage: string;
  docsUrl: string;
  /** Commands that sit at the root because they have no siblings. */
  commands: HelpCommand[];
  groups: HelpGroup[];
  globalFlags: HelpGlobalFlag[];
  examples: string[];
}

/** One entry of the exit-code contract. */
export interface HelpExitCode {
  code: number;
  name: string;
  meaning: string;
}`;

// ---------------------------------------------------------------------------
// Contract → tree.
// ---------------------------------------------------------------------------

/** Where the shared contract lives, relative to THIS module — never to the cwd. */
export const CONTRACT_URL: URL = new URL("../../endpoints.json", import.meta.url);

/** Where the generated module is written, relative to THIS module. */
export const GENERATED_URL: URL = new URL("../src/help.generated.ts", import.meta.url);

/** This repo's formatter configuration, so the render is formatted cwd-independently. */
export const CONFIG_URL: URL = new URL("../deno.json", import.meta.url);

/** Reads and parses the shared contract, failing loudly with the path it tried. */
export async function loadContract(url: URL = CONTRACT_URL): Promise<Contract> {
  let text: string;
  try {
    text = await Deno.readTextFile(url);
  } catch (err) {
    throw new Error(
      `gen-help: the shared wrapper contract was not found at ${url.pathname}. ` +
        "It is expected beside this repo — `../endpoints.json` from the repo root, where the " +
        "three wrapper repos sit as siblings — and is read as `../../endpoints.json` from " +
        "scripts/gen-help.ts. There is deliberately no vendored copy to fall back to: a stale " +
        "pinned copy would defeat the whole mechanism. " +
        `(${err instanceof Error ? err.message : String(err)})`,
    );
  }
  return JSON.parse(text) as Contract;
}

/**
 * The command path a `naming.cli` string declares.
 *
 * Pinned by `docs/implementation.md` §10: drop the leading binary, then take
 * tokens up to (not including) the first token starting with `<`, `[` or `--`.
 * `w6w documents get-by-key <key> [--project <id>]` → `["documents", "get-by-key"]`.
 */
export function commandPathOf(naming: string): string[] {
  const tokens = naming.trim().split(/\s+/).slice(1);
  const path: string[] = [];
  for (const token of tokens) {
    if (token.startsWith("<") || token.startsWith("[") || token.startsWith("--")) break;
    path.push(token);
  }
  return path;
}

interface NamingSurface {
  positionals: Set<string>;
  flags: Map<string, string | null>;
}

/**
 * What the contract's own CLI spelling says about a command's tail: which
 * parameters are positional arguments, and what placeholder each flag shows.
 * This is why `documents create <key> --content <text>` renders `key` as an
 * argument even though the contract carries it `in: "body"`.
 */
function namingSurface(naming: string, pathLength: number): NamingSurface {
  const tokens = naming.trim().split(/\s+/).slice(1 + pathLength);
  const bare = (t: string) => t.replace(/^\[+/, "").replace(/\]+$/, "");
  const positionals = new Set<string>();
  const flags = new Map<string, string | null>();
  for (let i = 0; i < tokens.length; i++) {
    const token = bare(tokens[i]);
    if (token.startsWith("--")) {
      const next = i + 1 < tokens.length ? bare(tokens[i + 1]) : "";
      if (/^<.+>$/.test(next)) {
        flags.set(token.slice(2), next);
        i++;
      } else {
        flags.set(token.slice(2), null);
      }
    } else {
      const match = /^<(.+)>$/.exec(token);
      if (match) positionals.add(match[1]);
    }
  }
  return { positionals, flags };
}

function describeParam(operation: string, param: string): string {
  const description = PARAM_HELP[`${operation}.${param}`] ?? PARAM_HELP[param];
  if (!description) {
    throw new Error(
      `gen-help: no help text for parameter \`${param}\` of operation \`${operation}\`. ` +
        "Add an entry to PARAM_HELP in scripts/gen-help.ts (keyed " +
        `\`${operation}.${param}\` or \`${param}\`) and re-run \`deno task gen:help\`.`,
    );
  }
  return description;
}

function kebab(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}

/** A summary as it reads after the em dash: no capital, no trailing period. */
function headlineOf(summary: string): string {
  const trimmed = summary.trim().replace(/\.$/, "");
  return trimmed.charAt(0).toLowerCase() + trimmed.slice(1);
}

/**
 * A summary as it reads in a one-line COMMANDS listing: no trailing period, and
 * cut at the em dash where the contract's summary elaborates after one
 * (`run` — "Run anything addressable by URN — a connection action, …"). The full
 * text still leads that command's own help.
 */
function shortSummaryOf(summary: string): string {
  return summary.trim().replace(/\.$/, "").split(" — ")[0];
}

interface BuiltParams {
  params: unknown[];
  usageTail: string;
}

function buildParams(
  operation: ContractOperation,
  path: string[],
  jsonFlag: { display: string; description: string },
): BuiltParams {
  const surface = namingSurface(operation.naming.cli, path.length);
  const params: {
    name: string;
    kind: "argument" | "flag";
    display: string;
    description: string;
    required: boolean;
  }[] = [];
  const usageParts: string[] = [];

  for (const param of operation.params) {
    const override = FLAG_OVERRIDES[`${operation.name}.${param.name}`];
    const description = describeParam(operation.name, param.name);
    if (!override && surface.positionals.has(param.name)) {
      params.push({
        name: param.name,
        kind: "argument",
        display: `<${param.name}>`,
        description,
        required: param.required,
      });
      usageParts.push(param.required ? `<${param.name}>` : `[<${param.name}>]`);
      continue;
    }
    const flag = override?.flag ?? `--${kebab(param.name)}`;
    const placeholder = override
      ? override.placeholder
      : surface.flags.get(param.name) ?? (param.type === "boolean" ? null : "<value>");
    params.push({
      name: param.name,
      kind: "flag",
      display: placeholder ? `${flag} ${placeholder}` : flag,
      description,
      required: param.required,
    });
    if (param.required) usageParts.push(placeholder ? `${flag} ${placeholder}` : flag);
  }

  // `--json` is global, but every command's OPTIONS lists it (docs/cli.md).
  params.push({
    name: "json",
    kind: "flag",
    display: jsonFlag.display,
    description: jsonFlag.description,
    required: false,
  });
  usageParts.push("[options]");

  return { params, usageTail: usageParts.join(" ") };
}

/** Builds the whole command tree from the contract. */
export function buildHelpTree(contract: Contract): Record<string, unknown> {
  const binary = contract.cli.binary;

  const globalFlags = contract.cli.globalFlags.map((flag) => {
    const prose = GLOBAL_FLAG_HELP[flag.name];
    if (!prose) {
      throw new Error(
        `gen-help: no help text for global flag \`${flag.name}\`. Add an entry to ` +
          "GLOBAL_FLAG_HELP in scripts/gen-help.ts and re-run `deno task gen:help`.",
      );
    }
    const label = flag.alias ? `${flag.alias}, ${flag.name}` : flag.name;
    return {
      name: flag.name,
      alias: flag.alias ?? null,
      type: flag.type,
      env: flag.env ?? null,
      display: prose.placeholder ? `${label} ${prose.placeholder}` : label,
      description: flag.env ? `${prose.description} (env: ${flag.env})` : prose.description,
    };
  });

  const jsonGlobal = globalFlags.find((f) => f.name === JSON_FLAG_NAME);
  if (!jsonGlobal) {
    throw new Error(`gen-help: the contract's global flags no longer include ${JSON_FLAG_NAME}.`);
  }
  const jsonFlag = { display: jsonGlobal.display, description: jsonGlobal.description };

  const rootCommands: Record<string, unknown>[] = [];
  const groups = new Map<string, Record<string, unknown>>();

  for (const operation of contract.operations) {
    const path = commandPathOf(operation.naming.cli);
    if (path.length === 0 || path.length > 2) {
      throw new Error(
        `gen-help: operation \`${operation.name}\` has a CLI naming this generator cannot ` +
          `place: \`${operation.naming.cli}\` (expected one or two command tokens).`,
      );
    }
    const { params, usageTail } = buildParams(operation, path, jsonFlag);
    const aliases = operation.cliAlias ? [commandPathOf(operation.cliAlias)] : [];
    const notes = [...(COMMAND_NOTES[operation.name] ?? [])];
    if (operation.status === "planned") {
      notes.push(
        `This operation is "planned": it is implemented here, but the server route is not live ` +
          "yet, so calling it against a server today returns 404.",
      );
    }
    const examples = COMMAND_EXAMPLES[operation.name];
    if (!examples || examples.length === 0) {
      throw new Error(
        `gen-help: no example for operation \`${operation.name}\`. Every command's help shows at ` +
          "least one runnable example — add one to COMMAND_EXAMPLES in scripts/gen-help.ts.",
      );
    }
    const command = {
      operation: operation.name,
      path,
      name: path[path.length - 1],
      aliases,
      summary: operation.summary,
      short: shortSummaryOf(operation.summary),
      headline: headlineOf(operation.summary),
      usage: `${binary} ${path.join(" ")} ${usageTail}`.trim(),
      naming: operation.naming.cli,
      status: operation.status,
      params,
      examples,
      notes,
    };

    if (path.length === 1) {
      rootCommands.push(command);
      continue;
    }
    const groupName = path[0];
    let group = groups.get(groupName);
    if (!group) {
      const summary = GROUP_SUMMARIES[groupName];
      if (!summary) {
        throw new Error(
          `gen-help: no summary for command group \`${groupName}\`. Add an entry to ` +
            "GROUP_SUMMARIES in scripts/gen-help.ts and re-run `deno task gen:help`.",
        );
      }
      group = {
        name: groupName,
        summary,
        headline: headlineOf(summary),
        usage: `${binary} ${groupName} <command> [options]`,
        commands: [],
        options: [],
        examples: GROUP_EXAMPLES[groupName] ?? [],
      };
      groups.set(groupName, group);
    }
    (group.commands as unknown[]).push(command);
  }

  // A group's OPTIONS block lists only what EVERY command in it accepts — which
  // is how `documents` gets `--project` and `vars` deliberately gets nothing.
  for (const group of groups.values()) {
    const commands = group.commands as { params: { name: string; kind: string }[] }[];
    const first = commands[0];
    const shared = first.params.filter((param) =>
      param.kind === "flag" && param.name !== "json" &&
      commands.every((c) => c.params.some((p) => p.name === param.name && p.kind === "flag"))
    );
    group.options = shared;
  }

  return {
    binary,
    contractVersion: contract.contractVersion,
    tagline: TAGLINE,
    usage: `${binary} <command> [options]`,
    docsUrl: DOCS_URL,
    commands: rootCommands,
    groups: [...groups.values()],
    globalFlags,
    examples: ROOT_EXAMPLES,
  };
}

/** Every command path the parser may match, aliases included. */
export function buildCommandPaths(tree: Record<string, unknown>): string[][] {
  const paths: string[][] = [];
  for (const command of tree.commands as { path: string[]; aliases: string[][] }[]) {
    paths.push(command.path, ...command.aliases);
  }
  for (const group of tree.groups as { commands: { path: string[]; aliases: string[][] }[] }[]) {
    for (const command of group.commands) paths.push(command.path, ...command.aliases);
  }
  return paths;
}

/** The exit-code contract, as named constants the runtime can refer to. */
export function buildExitCodes(
  contract: Contract,
): { code: number; name: string; meaning: string }[] {
  return Object.entries(contract.cli.exitCodes).map(([code, meaning]) => {
    const name = EXIT_CODE_NAMES[code];
    if (!name) {
      throw new Error(
        `gen-help: exit code ${code} has no name. Add one to EXIT_CODE_NAMES in ` +
          "scripts/gen-help.ts and re-run `deno task gen:help`.",
      );
    }
    return { code: Number(code), name, meaning };
  });
}

// ---------------------------------------------------------------------------
// Tree → module text. Pure: this is what the freshness test re-runs.
// ---------------------------------------------------------------------------

const HEADER = `// AUTOGENERATED — DO NOT EDIT BY HAND.
//
// Written by \`scripts/gen-help.ts\` from the shared wrapper surface contract, the
// same machine-readable file all three w6w wrappers implement. Regenerate with:
//
//     deno task gen:help
//
// Edits made here are lost on the next run, and \`tests/help_test.ts\` compares this
// file byte-for-byte against a fresh render — so a contract change that was not
// regenerated fails the suite instead of shipping stale help. The render is passed
// through \`deno fmt\` with this repo's own configuration, which is why the file
// satisfies \`deno task fmt:check\` like any hand-written module.
//
// Generation happens at development time on purpose: an installed \`@w6w/cli\` has
// no contract file beside it to read, so a runtime read would work in development
// and break for every user. Nothing under \`src/\` opens a JSON file.`;

/** Renders the whole generated module. Pure — no I/O, same input, same bytes. */
export function renderHelpModule(contract: Contract): string {
  const tree = buildHelpTree(contract);
  const exitCodes = buildExitCodes(contract);
  const json = (value: unknown) => JSON.stringify(value, null, 2);

  const exitConstants = exitCodes
    .map((entry) => `export const EXIT_${entry.name}: number = ${entry.code};`)
    .join("\n");

  return [
    HEADER,
    TREE_TYPES,
    `/** The command tree, generated from the shared wrapper surface contract. */
export const HELP_TREE: HelpTree = ${json(tree)};`,
    `/** Every command path the parser may match, aliases included. */
export const COMMAND_PATHS: string[][] = ${json(buildCommandPaths(tree))};`,
    `/** The exit-code contract, verbatim from the shared contract's \`cli.exitCodes\`. */
export const EXIT_CODES: HelpExitCode[] = ${json(exitCodes)};`,
    exitConstants,
    `/** The global flags, lifted out of the tree for the argument parser. */
export const GLOBAL_FLAGS: HelpGlobalFlag[] = HELP_TREE.globalFlags;`,
  ].join("\n\n") + "\n";
}

/**
 * Runs a rendered module through `deno fmt`, with this repo's own configuration.
 *
 * The generated file is a normal source file: it is typechecked, linted and
 * format-checked with everything else, so the generator formats rather than
 * carving the file out of the `fmt` gate. `deno fmt` is idempotent, so
 * `format(render(contract))` is as deterministic as `render` itself — which is
 * what lets the freshness test compare bytes.
 */
export async function formatModule(source: string): Promise<string> {
  const command = new Deno.Command(Deno.execPath(), {
    args: ["fmt", "-", "--ext", "ts", "--config", decodeURIComponent(CONFIG_URL.pathname)],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  });
  const child = command.spawn();
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(source));
  await writer.close();
  const { code, stdout, stderr } = await child.output();
  if (code !== 0) {
    throw new Error(`gen-help: deno fmt failed (${code}): ${new TextDecoder().decode(stderr)}`);
  }
  return new TextDecoder().decode(stdout);
}

// ---------------------------------------------------------------------------
// Entry point.
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const contract = await loadContract();
  const rendered = await formatModule(renderHelpModule(contract));
  await Deno.writeTextFile(GENERATED_URL, rendered);
  console.log(`gen-help: wrote ${GENERATED_URL.pathname} (${rendered.length} bytes)`);
}

if (import.meta.main) {
  await main();
}
