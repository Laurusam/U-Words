import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { test } from "node:test";
import { moduleUrl } from "./load-ts.mjs";

const { SCENES, normalizeScenes, DEFAULT_SCENES } = await import(await moduleUrl(new URL("../src/lib/scenes.ts", import.meta.url)));

test("scene catalog matches the Rust mapping table and has unique ids", async () => {
  const rust = await readFile(new URL("../src-tauri/src/scenes.rs", import.meta.url), "utf8");
  const ids = SCENES.map((scene) => scene.id);
  assert.equal(new Set(ids).size, ids.length, "scene ids 必须唯一");
  assert.ok(ids.includes("general"), "general 必须存在（引导默认选中）");
  for (const id of ids) {
    assert.match(rust, new RegExp(`id: "${id}"`), `Rust scenes.rs 必须定义场景 ${id}`);
  }
});

test("normalizeScenes filters unknown ids, dedupes and falls back on invalid input", () => {
  assert.deepEqual(normalizeScenes(["code", "nope", "code"]), ["code"]);
  assert.deepEqual(normalizeScenes([]), []);
  assert.deepEqual(normalizeScenes("bad"), DEFAULT_SCENES);
  assert.deepEqual(normalizeScenes(null), DEFAULT_SCENES);
});

test("scenes flow into transcribe and render requests; dead app-profile UI removed", async () => {
  const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
  // 场景随录音开始冻结，随识别与整理请求下发（render + 两处 transcribe）
  assert.match(app, /scenesRef\.current = await toolsApi/);
  assert.ok((app.match(/scenes: scenesRef\.current/g) || []).length >= 3, "render 与两处 transcribe 都必须携带 scenes");
  // 死配置清理：按应用配置风格的 UI 与假 appName 形参移除
  assert.doesNotMatch(app, /profile-form|profile-list|onAddProfile/);
  assert.match(app, /const resolvePreset = \(\) => config\.defaultPreset;/);
  // llm.rs：应用名不再进入模型请求，场景提示进入 system prompt
  const llm = await readFile(new URL("../src-tauri/src/llm.rs", import.meta.url), "utf8");
  assert.doesNotMatch(llm, /app_hint|app_name/);
  assert.match(llm, /crate::scenes::prompt\(&request\.scenes\)/);
  assert.match(llm, /pub scenes: Vec<String>/);
  // ASR：场景术语并入 whisper initial_prompt 与云端词表消息
  const asr = await readFile(new URL("../src-tauri/src/asr.rs", import.meta.url), "utf8");
  assert.match(asr, /fn context_prompt\(dictionary: &\[String\], scenes: &\[String\]\)/);
  assert.match(asr, /crate::scenes::terms\(&request\.scenes\)/);
  // ScenePicker：读回最新全量配置再 patch（不重置 onboardingDone），保存后广播
  const picker = await readFile(new URL("../src/components/ScenePicker.tsx", import.meta.url), "utf8");
  assert.match(picker, /await toolsApi\.config\(\);/);
  assert.match(picker, /normalizeTools\(\{ \.\.\.config, scenes: next \}\)/);
  assert.match(picker, /await emit\("tools-config"\)/);
});
