// `bin/w6w.ts` carries a Deno shebang (`#!/usr/bin/env -S deno run -A`) so it runs
// directly under Deno. `tsc` copies that line into `dist/bin/w6w.js` verbatim, but
// that file is what `package.json`'s npm `bin` entry execs — under Node, not Deno.
// This rewrites the compiled binary's shebang to Node's and restores the exec bit,
// which `tsc` does not preserve.
import { chmodSync, readFileSync, writeFileSync } from "node:fs";

const path = new URL("../dist/bin/w6w.js", import.meta.url);
const source = readFileSync(path, "utf8");
const fixed = source.replace(/^#!.*\n/, "#!/usr/bin/env node\n");
writeFileSync(path, fixed);
chmodSync(path, 0o755);
