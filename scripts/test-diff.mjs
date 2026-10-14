import assert from "node:assert/strict";
import { test } from "node:test";
import { moduleUrl } from "./load-ts.mjs";

const { diffWords } = await import(await moduleUrl(new URL("../src/lib/diff.ts", import.meta.url)));

const types = (segments) => segments.map(segment => segment.type).join(",");
const text = (segments, type) => segments.filter(segment => segment.type === type).map(segment => segment.text).join("");

test("identical text collapses into a single common segment", () => {
  const segments = diffWords("今天天气很好", "今天天气很好");
  assert.equal(segments.length, 1);
  assert.equal(segments[0].type, "common");
  assert.equal(segments[0].text, "今天天气很好");
});

test("word edits surface as del and add segments", () => {
  const segments = diffWords("先插入文字，再检查是否偏移原意。", "先写入文字，再检查是否偏离原意。");
  assert.match(types(segments), /del/);
  assert.match(types(segments), /add/);
  assert.equal(text(segments, "del"), "插移");
  assert.equal(text(segments, "add"), "写离");
  // 分段拼接必须完整还原两侧原文
  const rebuild = (which) => segments.flatMap(s => s.type === "common" || s.type === which ? s.text : "").join("");
  assert.equal(rebuild("del"), "先插入文字，再检查是否偏移原意。");
  assert.equal(rebuild("add"), "先写入文字，再检查是否偏离原意。");
});

test("english diffs work word-wise, not char-wise", () => {
  const segments = diffWords("the quick fox", "the quick brown fox");
  assert.deepEqual(segments, [
    { type: "common", text: "the quick " },
    { type: "add", text: "brown " },
    { type: "common", text: "fox" },
  ]);
});

test("empty source yields one add; empty result yields one del", () => {
  assert.deepEqual(diffWords("", "全新结果"), [{ type: "add", text: "全新结果" }]);
  assert.deepEqual(diffWords("原始文本", ""), [{ type: "del", text: "原始文本" }]);
  assert.deepEqual(diffWords("", ""), []);
});

test("adjacent same-type tokens are merged into one segment", () => {
  const segments = diffWords("一二三四", "一五七");
  for (let index = 1; index < segments.length; index += 1) {
    assert.notEqual(segments[index].type, segments[index - 1].type);
  }
});

test("oversized inputs fall back to a single common segment instead of O(n²)", () => {
  const source = Array.from({ length: 1600 }, (_, index) => `w${index}`).join(" ");
  const segments = diffWords(source, `${source} tail`);
  assert.deepEqual(segments, [{ type: "common", text: `${source} tail` }]);
});
