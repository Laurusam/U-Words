import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import ts from "typescript";
import { moduleUrl } from "./load-ts.mjs";

const require = createRequire(import.meta.url);
const file = new URL("../src/components/Waveform.tsx", import.meta.url);
const source = await readFile(file, "utf8");
const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022, jsx: ts.JsxEmit.ReactJSX } });
const moduleText = outputText.replace('"react/jsx-runtime"', JSON.stringify(pathToFileURL(require.resolve("react/jsx-runtime")).href));
const { Waveform } = await import(await moduleUrl(file));

test("waveform renders fixed-height bars with a static initial transform", () => {
  const html = renderToStaticMarkup(createElement(Waveform, { barCount: 25, className: "waveform" }));
  assert.equal((html.match(/<i /g) || []).length, 25);
  assert.match(html, /height:22px/);
  assert.match(html, /scaleY\(0\.15/); // initialLevel 0 时边缘 bar：3 + 0.05*7 = 3.35/22
  assert.equal((html.match(/style=/g) || []).length, 25, "每根 bar 的 style 必须内联固定，挂载后 React 不再触碰");
});

test("waveform accepts barCount 8 for the mini variant", () => {
  const html = renderToStaticMarkup(createElement(Waveform, { barCount: 8, className: "mini-wave" }));
  assert.equal((html.match(/<i /g) || []).length, 8);
  assert.match(html, /class="mini-wave"/);
});

test("waveform renders the capsule meter with an initial level and per-bar index", () => {
  const html = renderToStaticMarkup(createElement(Waveform, { barCount: 13, className: "floating-meter live", initialLevel: 0.7, label: "实时音量" }));
  assert.equal((html.match(/<i /g) || []).length, 13);
  assert.match(html, /--bar-i/);
  assert.match(html, /aria-label="实时音量"/);
  assert.match(html, /scaleY\(0\.359/); // 边缘 bar：3 + 0.7*7 = 7.9/22
  assert.match(html, /scaleY\(0\.741/); // 中心 bar：3 + 0.7*19 = 16.3/22
});
