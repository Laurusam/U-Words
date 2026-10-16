import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { moduleUrl } from "./load-ts.mjs";

const { CapsuleStage, resolveStage } = await import(await moduleUrl(new URL("../src/components/CapsuleStage.tsx", import.meta.url)));

function render(state, extra = {}) {
  return renderToStaticMarkup(createElement(CapsuleStage, { state, exiting: false, onCommand() {}, onExited() {}, ...extra }));
}
const state = { operation: "dictate", theme: "dark", level: .7, text: "", message: "识别失败" };

test("dictation label is blank; other mode names appear above the capsule", () => {
  for (const label of ["", "翻译", "编辑选区", "提问"]) {
    const html = render({ ...state, status: "recording", label });
    assert.match(html, new RegExp(`class="floating-mode-label"[^>]*>${label}</div>`));
    assert.ok(html.indexOf("floating-mode-label") < html.indexOf("capsule-shell"));
    assert.equal((html.match(/data-icon="close"/g) || []).length, 1);
    assert.equal((html.match(/data-icon="check"/g) || []).length, 1);
    assert.doesNotMatch(html, />转录</);
  }
});

for (const status of ["recording", "transcribing", "rendering", "ready", "error"]) {
  test(`${status}: exactly one close/cancel symbol`, () => {
    const html = render({ ...state, status });
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
  assert.doesNotMatch(render({ ...state, status: "idle" }), /button/);
  const html = render({ ...state, status: "recording", level: NaN });
  assert.doesNotMatch(html, /NaN/);
});

test("buttons wire the correct commands; processing keeps cancel on the left", async () => {
  // CapsuleStage 使用 hooks，无法在渲染器外展开元素树：命令接线用源码契约断言（同 test-context-tools 模式）
  const source = await readFile(new URL("../src/components/CapsuleStage.tsx", import.meta.url), "utf8");
  assert.match(source, /onClick=\{\(\) => onCommand\("cancel"\)\} aria-label="取消录音"/);
  assert.match(source, /onClick=\{\(\) => onCommand\("finish"\)\} aria-label="完成录音"/);
  assert.match(source, /onClick=\{\(\) => onCommand\("cancel"\)\} aria-label="取消处理"/);
  assert.match(source, /onClick=\{\(\) => onCommand\("dismiss"\)\} aria-label=\{ready \? "关闭提示" : "关闭错误提示"\}/);
  for (const status of ["recording", "transcribing", "rendering", "ready", "error"]) {
    const html = render({ ...state, status });
    assert.equal((html.match(/data-icon="close"/g) || []).length, 1);
    if (["transcribing", "rendering"].includes(status)) {
      assert.match(html, /aria-label="取消处理"/);
      assert.doesNotMatch(html, /完成录音/);
    }
    if (["ready", "error"].includes(status)) assert.match(html, /aria-label="关闭提示"|aria-label="关闭错误提示"/);
  }
});

test("copy preview shows escaped full text, one close and a copy action", () => {
  const text = '<script>不执行</script>\n最终正文' + '长文本'.repeat(300);
  const html = render({ ...state, status: "ready", preview: true, text });
  assert.equal((html.match(/data-icon="close"/g) || []).length, 1);
  assert.equal((html.match(/<button/g) || []).length, 2);
  assert.match(html, /复制完整文本/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /长文本/);
});

test("copy preview shows only countdown, text and copy; no title or reason", () => {
  const base = { ...state, status: "ready", preview: true, text: "最终文本", message: "未检测到可编辑光标，请复制文字" };
  const html = render(base);
  assert.doesNotMatch(html, /文字已生成|已保留转写/);
  assert.doesNotMatch(html, /未检测到可编辑光标/);
  assert.match(html, /class="floating-countdown"[^>]*><\/small>/);
  assert.match(html, /复制文本/);
  assert.match(render(base, { countdown: 15 }), /floating-countdown[^>]*>15s<\/small>/);
});

test("preview copy and dismiss commands are distinct; copy feedback renders", async () => {
  const source = await readFile(new URL("../src/components/CapsuleStage.tsx", import.meta.url), "utf8");
  assert.match(source, /onClick=\{\(\) => onCommand\("dismiss"\)\} aria-label="关闭文字预览"/);
  assert.match(source, /onClick=\{\(\) => onCommand\("copy"\)\} aria-label="复制完整文本"/);
  const html = render({ ...state, status: "ready", preview: true, text: "最终文本" });
  assert.match(html, /aria-label="关闭文字预览"/);
  assert.match(html, /aria-label="复制完整文本"/);
  assert.doesNotMatch(html, /已复制/);
  assert.match(render({ ...state, status: "ready", preview: true, text: "最终文本" }, { copyFeedback: "已复制" }), /已复制/);
});

test("text stage renders a card face; capsule stages render without it", () => {
  const text = render({ ...state, status: "ready", preview: true, text: "最终文本" });
  assert.match(text, /capsule-face--card/);
  assert.match(text, /capsule-card-foot/);
  for (const status of ["recording", "transcribing", "rendering", "ready", "error"]) {
    assert.doesNotMatch(render({ ...state, status }), /capsule-face--card/);
  }
});

test("resolveStage routes result before preview and derives flash/idle", () => {
  const result = { text: "结果", writeStatus: "copy" };
  assert.equal(resolveStage({ ...state, status: "idle" }), null);
  assert.equal(resolveStage({ ...state, status: "ready", result }), "text");
  assert.equal(resolveStage({ ...state, status: "ready", preview: true, text: "x", result }), "text");
  assert.equal(resolveStage({ ...state, status: "ready", preview: true, text: "x" }), "preview");
  assert.equal(resolveStage({ ...state, status: "ready", preview: true, text: "" }), "flash");
  assert.equal(resolveStage({ ...state, status: "recording" }), "record");
  assert.equal(resolveStage({ ...state, status: "transcribing" }), "process");
  assert.equal(resolveStage({ ...state, status: "rendering" }), "process");
  assert.equal(resolveStage({ ...state, status: "error" }), "flash");
});

test("resolveStage routes image results (with or without text) to the image stage", () => {
  const image = "data:image/png;base64,AAAA";
  assert.equal(resolveStage({ ...state, status: "ready", result: { action: "截图识字", image, text: "" } }), "image");
  assert.equal(resolveStage({ ...state, status: "ready", result: { action: "截图识字", image, text: "文字" } }), "image");
  assert.equal(resolveStage({ ...state, status: "ready", result: { text: "文字" } }), "text");
});

const resultState = (writeStatus) => ({
  ...state, status: "ready", text: "", message: "",
  result: { action: "编辑选区", app: "Visual Studio Code", source: "先插入文字。", text: "先写入文字。", writeStatus },
});

test("written result shows no buttons at all (1.2s auto shrink handles closing)", () => {
  const html = render(resultState("written"));
  assert.match(html, /capsule-face--card/);
  assert.match(html, /先写入文字。/);
  assert.doesNotMatch(html, /<button/);
  assert.doesNotMatch(html, /aria-label="关闭结果"/);
});

test("copy fallback result offers expand and close in the head plus one copy action", () => {
  const html = render(resultState("copy"));
  assert.equal((html.match(/<button/g) || []).length, 3);
  assert.match(html, /aria-label="展开原文对照"/);
  assert.match(html, /aria-label="关闭结果"/);
  assert.match(html, /aria-label="复制结果"/);
  assert.match(html, />复制</);
  assert.match(html, /aria-expanded="false"/);
  // 默认只显示最终结果；原文藏展开后
  assert.doesNotMatch(html, /先插入文字。/);
  assert.doesNotMatch(html, /编辑选区 · Visual Studio Code/);
});

test("F3 wiring: expand toggle, diff segments and written exit timer are contract-bound", async () => {
  const face = await readFile(new URL("../src/components/CapsuleStage.tsx", import.meta.url), "utf8");
  assert.match(face, /onToggleExpand=\{\(\) => setExpanded\(value => !value\)\}/);
  assert.match(face, /diffWords\(result\.source, result\.text\)/);
  assert.match(face, /capsule-diff-\$\{segment\.type\}/);
  const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
  assert.match(app, /setTimeout\(\(\) => exitAndHide\(\), 1200\)/);
  assert.match(app, /native\.applySelection\(currentSelectedText, result\.text, selectedSnapshotRef\.current\)/);
  assert.match(app, /stageKind === "text" \|\| stageKind === "image" \|\| \(state\.status !== "ready" && state\.status !== "error"\)/);
});

const imageState = (text) => ({
  ...state, status: "ready", text: "", message: "",
  result: { action: "截图识字", app: "Preview", image: "data:image/png;base64,AAAA", text },
});

test("image stage renders scanner card; copy appears only with recognized text", () => {
  const pending = render(imageState(""));
  assert.match(pending, /capsule-image-canvas/);
  assert.match(pending, /aria-label="正在扫描截图"/);
  assert.match(pending, /识别中/);
  assert.equal((html => (html.match(/<button/g) || []).length)(pending), 1); // 仅 × 关闭
  assert.doesNotMatch(pending, /复制文字/);
  const done = render(imageState("识别出的文字"));
  assert.match(done, /aria-label="截图与识别结果"/);
  assert.match(done, /识别出的文字/);
  assert.match(done, /aria-label="复制识别文字"/);
  assert.match(done, /截图识字 · Preview/);
  assert.equal((done.match(/<button/g) || []).length, 2); // × 关闭 + 复制文字
});

test("F4 wiring: OCR chain runs screenshot → scanner card → runToolSession with esc cancel", async () => {
  const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
  // 识别中占位态先上报（image + 空 text），文字到达后由 runToolSession 填充完整结果
  assert.match(app, /setOverlayResult\(\{ action: "截图识字", app, image: session\.image \?\? undefined, text: "" \}\)/);
  assert.match(app, /await runToolSession\(session\.id, "ocr", ""\)/);
  // F4 出场用自定义窗口尺寸（card-img 362×432）
  assert.match(app, /showFloatingOverlay\(false, \{ width: 362, height: 432 \}\)/);
  // 识别中 ESC：tools-close 的 cancel token 中断模型请求
  assert.match(app, /if \(toolActive\) \{[\s\S]*?void toolsApi\.close\(\)/);
  const capture = await readFile(new URL("../src-tauri/src/capture.rs", import.meta.url), "utf8");
  // C4 result 窗退役：截图完成后不再弹出 result 窗（OCR 走 F4，提问走 F1 语音链）
  assert.match(capture, /C4 result 窗退役/);
  assert.doesNotMatch(capture, /get_webview_window\("result"\)[\s\S]{0,80}show\(\)/);
});

test("P0 cancellation and lifecycle guards: tool ASR cancel, SQLite-first history, cursor restore, esc coverage", async () => {
  const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
  // P0-1 工具语音 ASR 窗口取消：早退分支必须置取消标记并中断后端任务，防止落入普通口述链
  const earlyExit = app.slice(app.indexOf("if (toolActive && !recordingRef.current)"), app.indexOf("if (isTauriRuntime) void invoke(\"cancel_processing\");\n    recordingTriggerRef"));
  assert.ok(earlyExit.includes('cancelRequestedRef.current = true;'), "early-exit branch must set cancelRequestedRef");
  assert.ok(earlyExit.includes('invoke("cancel_processing")'), "early-exit branch must interrupt backend tasks");
  assert.ok(earlyExit.includes('pipelineBusyRef.current = false;'), "early-exit branch must clear busy flag");
  // P0-2 SQLite 权威存储：persist 独立于 localStorage 的 try；镜像失败不阻断
  const store = app.slice(app.indexOf("const storeHistory = ("), app.indexOf("const recordUsage = ("));
  const persistAt = store.indexOf('void persist("history"');
  const tryAt = store.indexOf("try {");
  const localAt = store.indexOf("localStorage.setItem(HISTORY_KEY");
  assert.ok(persistAt >= 0 && tryAt > persistAt && localAt > tryAt, "persist must run before (outside) the localStorage try block");
  assert.match(store, /if \(!isTauriRuntime && notifyOnError\)/);
  // P0-4 overlayResultRef 同步包装 + Esc 守卫覆盖结果浮窗
  assert.match(app, /const overlayResultRef = useRef<OverlayResult \| null>\(null\);/);
  assert.match(app, /overlayResultRef\.current = value;/);
  assert.match(app, /!resultPreviewRef\.current && !overlayResultRef\.current && !toolsEscapeRef\.current/);
  assert.match(app, /if \(!resultPreviewRef\.current && !overlayResultRef\.current\) void unregisterEscapeShortcut\(\);/);
  assert.match(app, /\(resultPreviewRef\.current \|\| overlayResultRef\.current\)/);
  // P0-3 形变期鼠标穿透：恢复闭包挂 ref，cancelAnims 兜底，幂等恢复
  const capsule = await readFile(new URL("../src/components/CapsuleStage.tsx", import.meta.url), "utf8");
  assert.match(capsule, /const restoreCursorRef = useRef<\(\(\) => void\) \| null>\(null\);/);
  assert.match(capsule, /restoreCursorRef\.current = restoreCursor;/);
  assert.match(capsule, /if \(!restoreCursorRef\.current\) return; \/\/ 幂等：完成与中断只恢复一次/);
  assert.match(capsule, /restoreCursorRef\.current\?\.\(\);/);
});

test("A/B robustness contracts: usage SQLite-first, session generation guard, overlay local level bus", async () => {
  const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
  // A1 用量统计与 history 同模式：persist("usage") 独立落盘，先于 localStorage try
  for (const marker of ["const recordUsage = (", "const resetUsageStats = () => {"]) {
    const segment = app.slice(app.indexOf(marker), app.indexOf(marker) + 1200);
    const persistAt = segment.indexOf('void persist("usage"');
    const tryAt = segment.indexOf("try {");
    assert.ok(persistAt >= 0 && tryAt > persistAt, `${marker} 的 persist("usage") 必须先于 localStorage try 执行`);
  }
  // A2 会话代数守卫：取消后新录音启动时，旧会话迟到回包静默丢弃、finally 不踩新会话状态
  assert.match(app, /const pipelineGenerationRef = useRef\(0\);/);
  assert.match(app, /pipelineGenerationRef\.current \+= 1;/);
  assert.match(app, /const generation = pipelineGenerationRef\.current;/);
  assert.match(app, /const stale = \(\) => generation !== pipelineGenerationRef\.current;/);
  const finishStart = app.indexOf("const finishRecording = async () => {");
  const finish = app.slice(finishStart, app.indexOf("finishRecordingRef.current", finishStart));
  assert.equal(
    (finish.match(/cancelRequestedRef\.current \|\| stale\(\)/g) || []).length,
    4,
    "finishRecording 的四个检查点必须全部包含 stale 守卫",
  );
  assert.match(finish, /if \(!cancelRequestedRef\.current && !stale\(\)\) \{/);
  assert.match(finish, /if \(generation === pipelineGenerationRef\.current\) \{/);
  // B 浮窗波形：overlay webview 本地订阅 native-audio-level 直喂 levelBus，~60Hz rAF 直写
  assert.match(app, /listen<number>\("native-audio-level", \(\{ payload \}\) => levelBus\.set\(payload\)\)/);
  const capsule = await readFile(new URL("../src/components/CapsuleStage.tsx", import.meta.url), "utf8");
  assert.match(capsule, /<Waveform barCount=\{13\}/);
  assert.doesNotMatch(capsule, /Array\.from\(\{ length: 13 \}/);
});

test("native-effects contracts: capsule defers shell/bar/exit to the Rust layer", async () => {
  const capsule = await readFile(new URL("../src/components/CapsuleStage.tsx", import.meta.url), "utf8");
  const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
  const nativeLib = await readFile(new URL("../src/lib/native.ts", import.meta.url), "utf8");
  // CapsuleStage：native 分支壳透明化 class + 三处弹簧/穿透退役守卫 + RecordFace 条件波形
  assert.match(capsule, /const nativeFx = Boolean\(state\.nativeEffects\);/);
  assert.match(capsule, /capsule-shell--native/);
  assert.match(capsule, /原生模式：壳 div 直接全尺寸全亮/);
  assert.match(capsule, /\/\/ 原生模式：webview 壳 div 立即落位目标几何/);
  assert.match(capsule, /\/\/ 原生退场由 Rust effects_exit_overlay 驱动/);
  assert.match(capsule, /nativeFx\n\s+\? <div className="floating-meter"/);
  // 原生分支不再调用穿透 API（Rust 侧管理）；webview 分支保留
  assert.match(capsule, /setIgnoreCursorEvents\(true\)/);
  // App.tsx：阶段同步 + 原生退场 + 完成事件收尾 + 状态帧携带开关
  assert.match(app, /effectsSetStage\(stageKind \?\? "idle"\)/);
  assert.match(app, /native\.effectsExitOverlay\(\)/);
  assert.match(app, /listen\("u-words-overlay-exited"/);
  assert.match(app, /nativeEffects: config\.nativeEffects/);
  assert.match(app, /nativeEffects: false,/);
  // native.ts：两个命令包装
  assert.match(nativeLib, /effectsSetStage: \(stage: string\) => invoke<void>\("effects_set_stage"/);
  assert.match(nativeLib, /effectsExitOverlay: \(\) => invoke<void>\("effects_exit_overlay"\)/);
});
