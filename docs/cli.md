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
w6w workflows run --help        # command: arguments, flags, examples
```

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
  connections            Inspect connections
  workflows              List and run workflows

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

  Docs: https://w6w.dev/docs/cli
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
  --json                 Output raw JSON

EXAMPLES
  w6w workflows run wf_01HQ8N --var email=a@b.com
  w6w workflows run wf_01HQ8N --wait --json

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
- every `required` operation in `endpoints.json` appears in the help of its group;
- `w6w --version` prints the version from `VERSION`.

The no-token condition is the one that regresses. It breaks the first time
someone moves auth setup into a shared startup path, and it breaks silently for
anyone who already has a token configured — which is everyone on the team.
