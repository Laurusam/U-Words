import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

const require = createRequire(import.meta.url);
const transpile = (source) => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const url = (text) => `data:text/javascript;base64,${Buffer.from(text).toString("base64")}`;
const typesUrl = url(transpile(await readFile(new URL("../src/types.ts", import.meta.url), "utf8")));
const { ASR_LANGUAGES } = await import(typesUrl);
const component = transpile(await readFile(new URL("../src/components/AsrLanguageSelect.tsx", import.meta.url), "utf8"))
  .replace('"react/jsx-runtime"', JSON.stringify(pathToFileURL(require.resolve("react/jsx-runtime")).href))
  .replace('"../types"', JSON.stringify(typesUrl));
const { AsrLanguageSelect } = await import(url(component));

test("Qwen language codes match the Rust request allowlist", async () => {
  const rust = await readFile(new URL("../src-tauri/src/cloud_asr.rs", import.meta.url), "utf8");
  const declaration = rust.match(/pub const LANGUAGES[^=]*=\s*&\[([\s\S]*?)\];/)[1];
  const codes = [...declaration.matchAll(/"([a-z]+)"/g)].map((match) => match[1]);
  assert.equal(codes.length, 27);
  assert.deepEqual(ASR_LANGUAGES.slice(1).map(([code]) => code), codes);
  assert.equal(new Set(ASR_LANGUAGES.map(([code]) => code)).size, 28);
});

test("language picker includes automatic mixing, Cantonese and all documented values", () => {
  const html = renderToStaticMarkup(AsrLanguageSelect({ value: "ja", local: false, onChange() {} }));
  assert.equal((html.match(/<option /g) || []).length, 28);
  assert.match(html, /value="ja" selected=""/);
  assert.match(html, /自动（多语言混说）/);
  assert.match(html, /粤语/);
  assert.match(html, /菲律宾语/);
  assert.doesNotMatch(html, /编辑选区/);
});

test("local language picker discloses dialect and code-mapping limitations", () => {
  const html = renderToStaticMarkup(AsrLanguageSelect({ value: "yue", local: true, onChange() {} }));
  assert.match(html, /粤语按中文识别/);
  assert.match(html, /Tagalog/);
  const actions = [];
  const node = AsrLanguageSelect({ value: "auto", local: false, onChange: (value) => actions.push(value) });
  node.props.children[1].props.onChange({ target: { value: "fil" } });
  assert.deepEqual(actions, ["fil"]);
});
