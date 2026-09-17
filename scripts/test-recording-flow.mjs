import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { moduleUrl } from "./load-ts.mjs";
const { RecordingTrigger, replaceShortcuts } = await import(await moduleUrl(new URL("../src/lib/recordingTrigger.ts", import.meta.url)));
const { previousContext } = await import(await moduleUrl(new URL("../src/lib/continuity.ts", import.meta.url)));
const { estimatedProgress, ProcessingProgress } = await import(await moduleUrl(new URL("../src/components/ProcessingProgress.tsx", import.meta.url)));

test("toggle deduplicates repeat events and a second physical press finishes", () => {
  const trigger = new RecordingTrigger();
  assert.equal(trigger.handle("dictate", "Pressed", "toggle", false, false), "start");
  assert.equal(trigger.handle("dictate", "Pressed", "toggle", true, true), undefined);
  trigger.handle("dictate", "Released", "toggle", true, true);
  assert.equal(trigger.handle("dictate", "Pressed", "toggle", true, true), "finish");
});
test("hold release finishes only its own recording and release during startup aborts ownership", () => {
  const trigger = new RecordingTrigger();
  assert.equal(trigger.handle("edit", "Pressed", "hold", false, false), "start");
  assert.equal(trigger.isHolding("edit"), true);
  assert.equal(trigger.handle("dictate", "Released", "hold", true, true), undefined);
  assert.equal(trigger.handle("edit", "Released", "hold", true, true), "finish");
  trigger.handle("edit", "Pressed", "hold", false, false);
  assert.equal(trigger.handle("edit", "Released", "hold", false, true), undefined);
  assert.equal(trigger.isHolding("edit"), false);
});
test("Esc cancellation stays latched until release, busy/mouse sessions cannot be stolen", () => {
  const trigger = new RecordingTrigger();
  trigger.handle("dictate", "Pressed", "hold", false, false);
  trigger.cancel();
  assert.equal(trigger.handle("dictate", "Pressed", "hold", false, false), undefined);
  assert.equal(trigger.handle("dictate", "Released", "hold", true, true), undefined);
  assert.equal(trigger.handle("dictate", "Pressed", "hold", true, true), undefined);
  trigger.handle("dictate", "Released", "hold", true, true);
  assert.equal(trigger.handle("dictate", "Pressed", "hold", false, true), undefined);
});
test("shortcut additions are committed before removing old bindings", async () => {
  const trace = [];
  await replaceShortcuts(["old", "same"], ["new", "same"], async (key) => trace.push("add:" + key), async (key) => trace.push("remove:" + key));
  assert.deepEqual(trace, ["add:new", "remove:old"]);
});
test("shortcut conflict rolls back additions and keeps old bindings", async () => {
  const keys = new Set(["old"]);
  await assert.rejects(replaceShortcuts(["old"], ["new", "conflict"], async (key) => { if (key === "conflict") throw new Error("taken"); keys.add(key); }, async (key) => keys.delete(key)), /taken/);
  assert.deepEqual([...keys], ["old"]);
});
test("shortcut removal failure attempts restoring old bindings", async () => {
  const keys = new Set(["a", "b"]);
  await assert.rejects(replaceShortcuts(["a", "b"], ["new"], async (key) => keys.add(key), async (key) => { if (key === "b") throw new Error("remove failed"); keys.delete(key); }), /remove failed/);
  assert.deepEqual([...keys].sort(), ["a", "b"]);
});
test("progress is monotonic within each stage, never claims completion, absent in terminal states", () => {
  for (const stage of ["transcribing", "rendering"]) {
    const values = [0, 16, 1000, 5000, 30000, 90000, 1000000].map((time) => estimatedProgress(stage, time));
    assert.deepEqual([...values].sort((a, b) => a - b), values);
    assert.ok(values.at(-1) < 1);
    const html = renderToStaticMarkup(createElement(ProcessingProgress, { stage, compact: true }));
    assert.match(html, /等待动画/);
    assert.doesNotMatch(html, /aria-valuenow/);
  }
  for (const stage of ["idle", "recording", "ready", "error"]) assert.equal(renderToStaticMarkup(createElement(ProcessingProgress, { stage })), "");
  assert.ok(estimatedProgress("rendering", 0) > estimatedProgress("transcribing", 1000000));
});
test("context requires consent, target match and recent time, excludes explicit topic changes", () => {
  const entry = { text: "上一段".repeat(200), targetKey: "field-a", at: 1000 };
  assert.equal(previousContext(entry, "field-a", "以及", 2000, false), undefined);
  assert.equal(previousContext(entry, "field-b", "以及", 2000, true), undefined);
  assert.equal(previousContext(entry, undefined, "以及", 2000, true), undefined);
  assert.equal(previousContext(entry, "field-a", "以及", 31001, true), undefined);
  assert.equal(previousContext(entry, "field-a", "以及", 999, true), undefined);
  assert.equal(previousContext(entry, "field-a", "换个话题，", 2000, true), undefined);
  assert.equal(Array.from(previousContext(entry, "field-a", "以及", 2000, true)).length, 400);
});
