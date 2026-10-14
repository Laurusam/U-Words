import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import ts from "typescript";
const require = createRequire(import.meta.url);
export async function loadTs(url) {
  let text = ts.transpileModule(await readFile(url, "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  // 样式副作用导入与 node 测试无关，直接剥离（如 import "./capsule.css"）
  text = text.replace(/^[ \t]*import "[^"]+\.css";[ \t]*$/gm, "");
  for (const [, spec] of [...text.matchAll(/from "([^"]+)"/g)]) {
    let resolved;
    if (spec.startsWith(".")) {
      let child = new URL(spec + ".tsx", url);
      try { await readFile(child); } catch { child = new URL(spec + ".ts", url); }
      resolved = await moduleUrl(child);
    } else resolved = pathToFileURL(require.resolve(spec)).href;
    text = text.replaceAll(`from "${spec}"`, `from ${JSON.stringify(resolved)}`);
  }
  return text;
}
export async function moduleUrl(url) { return `data:text/javascript;base64,${Buffer.from(await loadTs(url)).toString("base64")}`; }
