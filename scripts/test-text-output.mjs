import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("../src/lib/textOutput.ts", import.meta.url), "utf8");
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { finalizeDictationText: finish } = await import(`data:text/javascript;base64,${Buffer.from(js).toString("base64")}`);

test("remove final prose periods only, preserve internal punctuation", () => {
  assert.equal(finish("第一句。\n第二句。  "), "第一句。\n第二句");
  assert.equal(finish("This is the final output."), "This is the final output");
  assert.equal(finish("输出正文."), "输出正文");
  for (const text of ["", "可以吗？", "完成！", "继续……"]) assert.equal(finish(text), text);
});

test("protect technical dots, abbreviations, quoted originals and code", () => {
  for (const text of ["v1.2.3.", "3.14.", "/Users/sam/.", "https://example.com.", "app.rs.", "Dr.", "etc.", "...", "1.", "`hello.`", "“结束。”", "    value."]) assert.equal(finish(text), text);
});

test("raw and canonical evidence remain unchanged", () => {
  const result = { text: "整理后的正文。", canonicalText: "原始裁决。" };
  const raw = "录音原文。";
  const delivered = { ...result, text: finish(result.text) };
  assert.equal(result.text, "整理后的正文。");
  assert.equal(raw, "录音原文。");
  assert.equal(delivered.canonicalText, result.canonicalText);
  assert.equal(delivered.text, "整理后的正文");
});
