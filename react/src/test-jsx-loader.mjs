import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { register } from "node:module";
import ts from "typescript";

register(import.meta.url, import.meta.url);

export async function load(url, context, nextLoad) {
  // `@xyflow/react` imports its own `dist/style.css`; Node's ESM loader has no
  // handler for `.css` and throws `ERR_UNKNOWN_FILE_EXTENSION` under
  // `node --test`. A stub empty module is enough — the test harness doesn't
  // render CSS, it only needs the import to resolve.
  if (url.endsWith(".css")) {
    return { format: "module", source: "export default {};", shortCircuit: true };
  }
  if (url.endsWith(".tsx")) {
    const path = fileURLToPath(url);
    const source = readFileSync(path, "utf8");
    const { outputText } = ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.ReactJSX,
        jsxImportSource: "react",
        esModuleInterop: true,
      },
      fileName: path,
    });
    return { format: "module", source: outputText, shortCircuit: true };
  }
  return nextLoad(url, context);
}
