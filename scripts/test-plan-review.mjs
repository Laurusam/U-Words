import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

const require = createRequire(import.meta.url);
const source = await readFile(new URL("../src/components/PlanReviewView.tsx", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022, jsx: ts.JsxEmit.ReactJSX } });
const moduleText = outputText.replace('"react/jsx-runtime"', JSON.stringify(pathToFileURL(require.resolve("react/jsx-runtime")).href));
const { PlanReviewView } = await import(`data:text/javascript;base64,${Buffer.from(moduleText).toString("base64")}`);
const result = { organizedPlan: "原方案整理", issues: [{ title: "待验证项", evidence: "原文证据", detail: "检查边界" }], suggestions: [{ title: "建议", detail: "新增内容", condition: "采用条件" }] };
const base = { source: "<script>原方案</script>", provider: "测试服务商", busy: false };

test("opening review does not call a model or modify source", () => {
  let calls = 0;
  const html = renderToStaticMarkup(PlanReviewView({ session: base, theme: "dark", onClose() {}, onCheck() { calls++; }, onCopy() { calls++; }, onInsert() { calls++; } }));
  assert.equal(calls, 0);
  assert.match(html, /额外调用一次/);
  assert.match(html, /测试服务商/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /发送并检查方案/);
});

test("busy and failure states preserve source and expose retry", () => {
  const props = { theme: "light", onClose() {}, onCheck() {}, onCopy() {}, onInsert() {} };
  assert.match(renderToStaticMarkup(PlanReviewView({ ...props, session: { ...base, busy: true } })), /disabled=""/);
  const html = renderToStaticMarkup(PlanReviewView({ ...props, session: { ...base, error: "调用失败，原文未改" } }));
  assert.match(html, /role="alert"/);
  assert.match(html, /调用失败，原文未改/);
  assert.match(html, /发送并检查方案/);
});

test("review organization and optional advice use separate explicit actions", () => {
  const calls = [];
  const tree = PlanReviewView({ session: { ...base, result }, theme: "dark", onClose() {}, onCheck() { calls.push("check"); }, onCopy(text) { calls.push(["copy", text]); }, onInsert(text) { calls.push(["prepare", text]); } });
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    if (node.type === "button") node.props.onClick();
    else [node.props?.children].flat(Infinity).forEach(walk);
  };
  walk(tree);
  assert.deepEqual(calls, [["copy", "原方案整理"], ["prepare", "原方案整理"], ["copy", "建议\n新增内容\n采用条件：采用条件"]]);
  const html = renderToStaticMarkup(tree);
  assert.match(html, /可选新增建议 · 未应用/);
  assert.match(html, /原文证据/);
});
