import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { moduleUrl } from "./load-ts.mjs";

const require = createRequire(import.meta.url);
const source = await readFile(new URL("../src/components/OverlayView.tsx", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022, jsx: ts.JsxEmit.ReactJSX } });
const moduleText = outputText.replace('"react/jsx-runtime"', JSON.stringify(pathToFileURL(require.resolve("react/jsx-runtime")).href));
const { OverlayView } = await import(await moduleUrl(new URL("../src/components/OverlayView.tsx", import.meta.url)));
const state = { operation: "dictate", theme: "dark", level: .7, text: "", message: "识别失败" };

test("dictation label is blank; other mode names appear above the capsule", () => {
  for (const label of ["", "翻译", "编辑选区", "提问"]) {
    const html = renderToStaticMarkup(OverlayView({ state: { ...state, status: "recording", label }, onCommand() {} }));
    assert.match(html, new RegExp(`class="floating-mode-label"[^>]*>${label}</div>`));
    assert.ok(html.indexOf("floating-mode-label") < html.indexOf("floating-overlay"));
    assert.equal((html.match(/data-icon="close"/g) || []).length, 1);
    assert.equal((html.match(/data-icon="check"/g) || []).length, 1);
    assert.doesNotMatch(html, />转录</);
  }
});

for (const status of ["recording", "transcribing", "rendering", "ready", "error"]) {
  test(`${status}: exactly one close/cancel symbol`, () => {
    const html = renderToStaticMarkup(OverlayView({ state: { ...state, status }, onCommand() {} }));
    assert.equal((html.match(/data-icon="close"/g) || []).length, 1);
    assert.equal((html.match(/<button/g) || []).length, status === "recording" ? 2 : 1);
    if (status === "error") {
      assert.match(html, /data-icon="warning"/);
      assert.match(html, /未完成/);
      assert.match(html, /role="alert"/);
    }
  });
}

test("idle has no buttons; invalid volume does not produce NaN CSS", () => {
  assert.doesNotMatch(renderToStaticMarkup(OverlayView({ state: { ...state, status: "idle" }, onCommand() {} })), /button/);
  const html = renderToStaticMarkup(OverlayView({ state: { ...state, status: "recording", level: NaN }, onCommand() {} }));
  assert.doesNotMatch(html, /NaN/);
});

test("buttons send the correct commands and processing keeps cancel on the left", () => {
  function buttons(node) {
    if (!node || typeof node !== "object") return [];
    if (node.type === "button") return [node];
    return [node.props?.children].flat(Infinity).flatMap(buttons);
  }
  const commands = [];
  const onCommand = (command) => commands.push(command);
  for (const status of ["recording", "transcribing", "rendering", "ready", "error"]) {
    const found = buttons(OverlayView({ state: { ...state, status }, onCommand }));
    if (["transcribing", "rendering"].includes(status)) assert.equal(found[0].props["aria-label"], "取消处理");
    found.forEach((button) => button.props.onClick());
  }
  assert.deepEqual(commands, ["cancel", "finish", "cancel", "cancel", "dismiss", "dismiss"]);
});

test("copy preview shows escaped full text, one close and a copy action", () => {
  const text = '<script>不执行</script>\n最终正文' + '长文本'.repeat(300);
  const html = renderToStaticMarkup(OverlayView({ state: { ...state, status: "ready", preview: true, text }, onCommand() {} }));
  assert.equal((html.match(/data-icon="close"/g) || []).length, 1);
  assert.equal((html.match(/<button/g) || []).length, 2);
  assert.match(html, /复制完整文本/);
  assert.match(html, /不会自动消失/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /长文本/);
});

test("preview copy and dismiss commands are distinct", () => {
  const commands = [];
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    if (node.type === "button") node.props.onClick();
    else [node.props?.children].flat(Infinity).forEach(walk);
  };
  walk(OverlayView({ state: { ...state, status: "ready", preview: true, text: "最终文本" }, onCommand: (command) => commands.push(command) }));
  assert.deepEqual(commands, ["dismiss", "copy"]);
  assert.match(renderToStaticMarkup(OverlayView({ state: { ...state, status: "ready", preview: true, text: "最终文本", copyFeedback: "已复制" }, onCommand() {} })), /已复制/);
});
