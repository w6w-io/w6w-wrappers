/**
 * `w6w documents …` — the document store at the command line.
 *
 * Six commands, **one SDK call each**. Nothing here composes two requests,
 * filters a list, sorts a result or resolves a key by scanning: a wrapper that
 * has to compose two calls is describing an operation that belongs in the API
 * (`README.md`, "What a wrapper is"), and the CLI is a wrapper like the other
 * two. Addressing mirrors the server exactly — **create by `key`, read by id or
 * by key, update and delete by id** (`docs/implementation.md` §7).
 *
 * Everything a handler does falls into four steps, in this order: read its own
 * arguments, call one method on `client.documents`, render, return. Errors are
 * not caught here — `main()` reports a throw once, on stderr, and maps it to an
 * exit code through `src/exit.ts`, so an `ApiError` exits 2 and a usage error
 * exits 1 without any command deciding that for itself.
 *
 * **`--project` belongs to this group and not to `w6w vars`.** Documents are
 * project-scoped and every route below takes an optional `?project=`; variables
 * are not, and `src/commands/vars.ts` refuses the flag rather than accepting one
 * the server would ignore.
 *
 * @module
 */

import type { CommandContext, CommandHandler, CommandRegistry } from "../../mod.ts";
import type { Doc, DocFormat, DocumentOptions, DocumentPatch } from "@w6w/sdk";
import type { Styles } from "../output.ts";
import { argument, noExtraArguments, requiredFlag, table, textFlag } from "./shared.ts";

/**
 * The project scope for one call: the `--project` flag, or nothing at all.
 *
 * Nothing is the important case — an omitted `?project=` is how the caller asks
 * the server for the account's default project, so an absent flag must not
 * become an empty string or a guess.
 */
function scope(context: CommandContext): DocumentOptions {
  const project = textFlag(context, "project");
  return project === undefined ? {} : { project };
}

/**
 * The `--format` flag, as the SDK's format hint.
 *
 * Cast rather than checked: the set of formats is the **server's** rule
 * (`400 invalid_format` when it is broken), and a copy of that enum in the CLI
 * would go stale the day a sixth format is added, rejecting locally a value the
 * server had just started accepting.
 */
function format(context: CommandContext): DocFormat | undefined {
  return textFlag(context, "format") as DocFormat | undefined;
}

/** One document, as a table row. */
function row(doc: Doc): string[] {
  return [doc.id, doc.key, doc.format, doc.updatedAt];
}

/** The listing: one line per document, or a line saying there are none. */
function renderList(docs: Doc[], styles: Styles): string {
  if (docs.length === 0) return styles.dim("No documents.");
  return table(["ID", "KEY", "FORMAT", "UPDATED"], docs.map(row), styles);
}

/** One document in full — the content is what the reader came for, so it is shown. */
function renderDoc(doc: Doc, styles: Styles): string {
  const heading = `${styles.bold(doc.key)} ${styles.dim(`(${doc.id})`)}`;
  const meta = styles.dim(`${doc.format} · updated ${doc.updatedAt}`);
  const description = doc.description.length > 0 ? [doc.description] : [];
  return [heading, meta, ...description, "", doc.content].join("\n");
}

/** The confirmation for a write: what changed, and how to address it next time. */
function renderWrite(verb: string, doc: Doc, styles: Styles): string {
  return `${verb} ${styles.bold(doc.key)} ${styles.dim(`(${doc.id})`)}`;
}

const list: CommandHandler = async (context) => {
  noExtraArguments(context, 0);
  const docs = await context.client().documents.list(scope(context));
  context.out.emit(docs, (styles) => renderList(docs, styles));
};

const get: CommandHandler = async (context) => {
  const id = argument(context, 0, "a document id (see: `w6w documents list`)");
  noExtraArguments(context, 1);
  const doc = await context.client().documents.get(id, scope(context));
  context.out.emit(doc, (styles) => renderDoc(doc, styles));
};

/**
 * `w6w documents get-by-key <key>` — the key-addressed read.
 *
 * The key is handed to the SDK untouched, which percent-encodes it at
 * interpolation. **No key is rejected here**, and that is deliberate: the server
 * accepts any non-empty key up to 128 characters, so refusing one locally would
 * make a document that a user legitimately created permanently unreadable
 * through this CLI.
 *
 * **This lane's `".."` behaviour, stated rather than papered over (D1).** A key
 * of `"."` or `".."` is creatable, and it is *not* addressable from this
 * runtime. Percent-encoding cannot help — `.` is unreserved in RFC 3986, so
 * `encodeURIComponent("..")` is still `".."` — and the WHATWG URL parser behind
 * `fetch`, which this lane and the node SDK share, removes dot segments while
 * building the request: `…/api/documents/by-key/..` is normalised to
 * `…/api/documents/`, the **list** route. The list route answers `200` with a
 * `documents` array, the SDK finds no `document` key in it, and the caller gets
 * an `ApiError` with code `bad_response` (D3) and exit code 2 — a loud failure,
 * not a silent wrong answer.
 *
 * The Python wrapper's `urllib` sends the same path **literally** and does not
 * normalise it, so the two lanes reach different routes for the same key. That
 * divergence is measured, not theoretical, and it is resolved server-side by the
 * `by-key` route landing in T4.4.1; neither wrapper works around it.
 */
const getByKey: CommandHandler = async (context) => {
  const key = argument(context, 0, "a document key (the name it was created under)");
  noExtraArguments(context, 1);
  const doc = await context.client().documents.getByKey(key, scope(context));
  context.out.emit(doc, (styles) => renderDoc(doc, styles));
};

const create: CommandHandler = async (context) => {
  const key = argument(context, 0, "a document key to create (unique per project)");
  noExtraArguments(context, 1);
  const doc = await context.client().documents.create(
    {
      key,
      content: requiredFlag(context, "content", "--content <text>"),
      format: format(context),
      description: textFlag(context, "description"),
    },
    scope(context),
  );
  context.out.emit(doc, (styles) => renderWrite("Created", doc, styles));
};

/**
 * `w6w documents update <id>` — a patch, addressed by the server-issued id.
 *
 * **Only flags the user typed reach the wire (D2).** The patch is assembled
 * field by field, and a field whose flag was absent is never added — so
 * `w6w documents update doc_1 --format markdown` sends `{"format":"markdown"}`
 * and leaves the content alone, while `w6w documents update doc_1` alone sends
 * `{}` and changes nothing. Assigning `undefined` (or worse, `null`) to the
 * missing fields would turn "don't touch this" into "blank this out", which is
 * the kind of bug that is only ever found after it has run.
 */
const update: CommandHandler = async (context) => {
  const id = argument(context, 0, "the document id to update (see: `w6w documents list`)");
  noExtraArguments(context, 1);

  const patch: DocumentPatch = {};
  const content = textFlag(context, "content");
  if (content !== undefined) patch.content = content;
  const hint = format(context);
  if (hint !== undefined) patch.format = hint;
  const description = textFlag(context, "description");
  if (description !== undefined) patch.description = description;

  const doc = await context.client().documents.update(id, patch, scope(context));
  context.out.emit(doc, (styles) => renderWrite("Updated", doc, styles));
};

/**
 * `w6w documents delete <id>` — and **nothing on stdout**.
 *
 * The server answers `{ok:true}`; the wrapper contract unwraps that to nothing
 * at all (`docs/implementation.md` §6), so the only machine-readable part of the
 * answer is the exit code. The human gets a confirmation through `note()`, which
 * `--json` suppresses — `w6w documents delete doc_1 --json` prints an empty
 * stdout rather than a payload the contract says does not exist.
 */
const remove: CommandHandler = async (context) => {
  const id = argument(context, 0, "the document id to delete (see: `w6w documents list`)");
  noExtraArguments(context, 1);
  await context.client().documents.delete(id, scope(context));
  context.out.note(`Deleted ${id}.`);
};

/**
 * The six `w6w documents` commands, keyed by the canonical command path.
 *
 * The keys are the generated help tree's `path` values joined by a space, which
 * are `endpoints.json`'s `naming.cli` spellings — `tests/cmd_documents_test.ts`
 * asserts the two sets are the same, so a command cannot be registered under a
 * name the help does not document, or documented under a name nothing runs.
 */
export const DOCUMENT_COMMANDS: CommandRegistry = {
  "documents list": list,
  "documents get": get,
  "documents get-by-key": getByKey,
  "documents create": create,
  "documents update": update,
  "documents delete": remove,
};
