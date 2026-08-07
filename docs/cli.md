# CLI — the help surface

`--help` is the CLI's documentation. Not a pointer to documentation — the thing
itself. Someone evaluating w6w will type `w6w --help` before they open a browser,
and whatever they see there is the first real impression the platform makes.

This document specifies what help must produce. Everything else about the CLI
(operations, naming) lives in [endpoints.md](./endpoints.md).

## Three levels

Help resolves at every depth, and `-h` is an alias for `--help` at all of them:

```
w6w --help                      # root: what w6w is, global flags, command groups
w6w workflows --help            # group: the commands in that group
w6w documents --help            # group: the document CRUD commands
w6w vars --help                 # group: the variable CRUD commands
w6w workflows run --help        # command: arguments, flags, examples
w6w documents create --help     # command: arguments, flags, examples
```

Two commands sit at the root rather than inside a group, because they have no
siblings: `w6w me` (identity + component versions) and `w6w run` (run anything
addressable by a URN). They still resolve help at the command level —
`w6w run --help` — and `w6w --help` lists them alongside the groups.

`w6w help <command>` is accepted as an alias for `w6w <command> --help`, because
people type both.

Rules that make this actually work:

- **`--help` wins over everything.** It never authenticates, never reads config,
  never makes a network call, and exits `0`. `w6w workflows run --help` must work
  with no token set and no server reachable — the moment help needs credentials,
  it stops being usable at the exact time people need it most.
- **Bare `w6w` prints root help and exits `0`.** Not an error, not a usage stub.
- **An unknown or incomplete command prints the relevant help to stderr and exits
  `1`.** Wrong invocations are the other main way people read help; send them
  somewhere useful rather than printing "unknown command" alone.

## Root help

```
w6w — command-line client for the w6w workflow platform

USAGE
  w6w <command> [options]

COMMANDS
  me                     Show the current user and w6w component versions
  run                    Run anything addressable by a URN
  connections            Inspect connections
  workflows              List and run workflows
  documents              Create, read, update and delete documents
  vars                   Create, read, update and delete variables

GLOBAL OPTIONS
  --base-url <url>       API base URL (env: W6W_BASE_URL)
  --token <token>        API token (env: W6W_TOKEN)
  --json                 Output raw JSON instead of a table
  --no-color             Disable colored output
  -v, --version          Print the CLI version
  -h, --help             Show help for any command

EXAMPLES
  w6w me
  w6w workflows list
  w6w workflows run wf_01H… --wait
  w6w documents list
  w6w vars create greeting --type string --value hello
  w6w run conn_01H… --action send_email --payload '{"to":"a@b.com"}'

  Docs: https://w6w.dev/docs/cli
```

`w6w info` is an accepted **alias of `w6w me`** (D8) — same operation, second
spelling, because "info" is what people reach for when they want to know what
they are talking to. The operation is named `me` everywhere else (`endpoints.json`
`naming.cli`, the SDK method); the alias exists only at the CLI, is declared as
`cliAlias` in `endpoints.json`, and `w6w info --help` prints `w6w me`'s help.
Aliases are not listed as separate `COMMANDS` entries — one command, one line.

## Group help

A group's help lists its commands and nothing else; the group itself is never
runnable, so `w6w documents` with no subcommand prints this to stderr and exits
`1` (per the incomplete-command rule above).

```
w6w documents — create, read, update and delete documents

USAGE
  w6w documents <command> [options]

COMMANDS
  list                   List documents
  get                    Fetch a document by id
  get-by-key             Fetch a document by its key
  create                 Create a document
  update                 Patch a document
  delete                 Delete a document

OPTIONS
  --project <id>         Project to scope to (default: the account's default project)

EXAMPLES
  w6w documents list
  w6w documents get doc_01HQ8N
```

`w6w vars` is the same shape — `list`, `get`, `get-by-name`, `create`, `update`,
`delete` — with **one deliberate difference: there is no `--project` flag.**
Variables are scoped by tenant/subject only; the server ignores `?project=` on
every `vars` route. The asymmetry with `documents` is real and the help says so
rather than papering over it with a flag that does nothing.

```
w6w vars — create, read, update and delete variables

USAGE
  w6w vars <command> [options]

COMMANDS
  list                   List variables
  get                    Fetch a variable by id
  get-by-name            Fetch a variable by its name
  create                 Create a variable
  update                 Patch a variable
  delete                 Delete a variable

EXAMPLES
  w6w vars list
  w6w vars create greeting --type string --value hello
```

## Command help

Every command's help shows, in this order: a one-line summary, usage, positional
arguments, flags, and **at least one runnable example**. The example is the part
people actually copy, so it must be complete and correct — not `<workflow-id>` in
a position where a real id is required, without saying where to get one.

```
w6w workflows run — trigger a workflow run

USAGE
  w6w workflows run <id> [options]

ARGUMENTS
  <id>                   Workflow id (see: w6w workflows list)

OPTIONS
  --var <key=value>      Set a run variable (repeatable)
  --wait                 Wait for the run to reach a terminal state
  --input <json>         Run input, as a JSON string
  --json                 Output raw JSON

EXAMPLES
  w6w workflows run wf_01HQ8N --var email=a@b.com
  w6w workflows run wf_01HQ8N --wait --json
  w6w workflows run wf_01HQ --input '{"email":"a@b.com"}'

NOTES
  Without --wait the run is queued and the command returns immediately with a
  run id and status "queued". With --wait the CLI returns when the run finishes
  or the server's wait window expires — a run still in progress is reported as
  "running", which is not an error.
```

That `NOTES` block is not optional decoration. The queued/waiting/failed
distinction ([endpoints.md §4](./endpoints.md#4-workflowsrun--trigger-a-workflow))
is the single most confusing thing in this surface, and help is where it gets
explained.

`w6w run` earns a `NOTES` block for the same reason — it is the one command whose
output shape changes with its argument:

```
w6w run — run anything addressable by a URN

USAGE
  w6w run <urn> [options]

ARGUMENTS
  <urn>                  conn_… | wf_… | fn_… | ep_…
                         (see: w6w connections list, w6w workflows list)

OPTIONS
  --action <name>        Action to invoke (connection URNs only)
  --payload <json>       Input object, as a JSON string
  --json                 Output raw JSON

EXAMPLES
  w6w run conn_01HQ8N --action send_email --payload '{"to":"a@b.com"}'
  w6w run wf_01HQ8N --payload '{"email":"a@b.com"}'

NOTES
  The result is tagged by kind. A connection action and a function return their
  value directly; a workflow returns a run id and status "queued" and is not
  waited on — use "w6w workflows run <id> --wait" when you need to wait, set
  variables, or pass a trigger. Documents and variables are not URNs: address
  them with "w6w documents" and "w6w vars".
```

## Exit codes

Help text is a promise about behavior, so the codes are part of the contract:

| Code | Meaning |
|------|---------|
| `0` | Success — including help, and including a *queued* or *running* workflow |
| `1` | Usage error — unknown command, missing argument, bad flag |
| `2` | API error — 4xx/5xx from the server, including auth failure |
| `3` | Run failure — `--wait` returned a run with status `failed` |

Code `3` exists so `w6w workflows run --wait` is usable in CI without parsing
stdout. Keeping it distinct from `2` matters: a failed workflow and an
unreachable API demand opposite responses, and a script that can't tell them
apart will retry the wrong one.

## Help is generated, not written

Command and flag help derive from [`../endpoints.json`](../endpoints.json) — the
same contract the conformance test reads. Summaries come from each operation's
`summary`, flags from its `params`, and the caveats from its `notes`.

This is the point. Hand-written help is drift waiting to happen: an operation
changes, three wrappers get updated, and the help text keeps describing last
version's behavior with total confidence. Generating it means the CLI cannot
document an operation it does not have, or omit one it does.

Prose that has nowhere to live in `endpoints.json` — the root description,
examples — stays hand-written, but it is deliberately the part that changes
least.

## Conformance

The CLI's conformance test additionally asserts:

- `w6w --help`, `w6w <group> --help`, and `w6w <group> <cmd> --help` each exit `0`
  and produce non-empty output, **with no token in the environment**;
- **every** operation in `endpoints.json` — `required` and `planned` alike, since
  `status` records server readiness rather than wrapper obligation
  ([parity.md](./parity.md#conformance)) — appears in the help of its group, or in
  root help for the two root-level commands;
- `w6w --version` prints the version from `VERSION`.

The no-token condition is the one that regresses. It breaks the first time
someone moves auth setup into a shared startup path, and it breaks silently for
anyone who already has a token configured — which is everyone on the team.
