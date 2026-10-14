import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { moduleUrl } from './load-ts.mjs';

const { radialIndex, normalizeTools, DEFAULT_TOOLS, ACTIONS } = await import(
  await moduleUrl(new URL('../src/lib/contextTools.ts', import.meta.url))
);

test('radial centers, dead zone, exterior and every supported slot count', () => {
  for (let count = 3; count <= 8; count++) {
    assert.equal(radialIndex(150, 150, count), null);
    assert.equal(radialIndex(500, 500, count), null);
    for (let index = 0; index < count; index++) {
      const angle = (index * 2 * Math.PI) / count - Math.PI / 2;
      assert.equal(radialIndex(150 + 100 * Math.cos(angle), 150 + 100 * Math.sin(angle), count), index);
    }
  }
  assert.equal(radialIndex(150, 50, 2), null);
});

test('OCR is a distinct action and thresholds are bounded', () => {
  assert.equal(ACTIONS.ocr, '截图识字');
  const config = normalizeTools({ ...DEFAULT_TOOLS, holdMs: 1, selectionDelayMs: 9000 });
  assert.equal(config.holdMs, 200);
  assert.equal(config.selectionDelayMs, 1500);
});

test('voice question runs the tool session, translation previews, snapshot is preserved', async () => {
  const app = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8');
  // 契约正则对空白容忍，只约束控制流，不约束排版。
  // C4：工具语音链转写后统一走 runToolSession（tools_run），不再调用已退役的 tools_question。
  const voiceStart = app.search(/if \(voiceQuestionRef\.current\) \{/);
  assert.ok(voiceStart >= 0, 'voice question branch not found');
  const voice = app.slice(voiceStart, app.indexOf('if (!transcript.trim())'));
  assert.match(voice, /await runToolSession\(id, toolAction, transcript\.trim\(\)\)/);
  assert.doesNotMatch(voice, /tools_question/);
  assert.doesNotMatch(app, /tools_question/);
  // ask/image 语音为空时没有可执行问题：关会话并提示；polish/translate 不依赖语音内容
  assert.match(voice, /toolAction !== "polish" && toolAction !== "translate"/);
  assert.match(voice, /void toolsApi\.close\(\)/);
  // 工具链入口：选区语音（tools_open）与截图语音（screenshot）共用 F1，录音未真正开始即回收会话
  assert.match(app, /const startToolVoice = async \(action: "ask" \| "polish" \| "translate"\) => \{[\s\S]*?toolsApi\.open\(action\)[\s\S]*?await startToolRecording\(session\.id, action\)/);
  assert.match(app, /const startToolRecording = async \(id: string, action: string\) => \{[\s\S]*?await startRecording\("dictate"\)[\s\S]*?if \(!recordingRef\.current\) \{[\s\S]*?void toolsApi\.close\(\)/);
  // 选区编辑：携带快照走自动写入（失败由 F3 落入复制兜底）
  assert.match(app, /native\.applySelection\(currentSelectedText, result\.text, selectedSnapshotRef\.current\)/);
  // 翻译：无选区锚点，只报 F3 复制兜底结果，绝不直接插入
  assert.match(app, /else if \(config\.mode === "translate"\)[\s\S]*?setOverlayResult\(\{ action: "翻译"[\s\S]*?writeStatus: "copy"/);
});

test('capture hides all own windows and has no upload call', async () => {
  const capture = await readFile(new URL('../src-tauri/src/capture.rs', import.meta.url), 'utf8');
  assert.match(capture, /\[\s*"main"\s*,\s*"radial"\s*,\s*"selectionbar"\s*,\s*"result"\s*,\s*"overlay"\s*,?\s*\]/);
  assert.doesNotMatch(capture, /\.post\(|\.bearer_auth\(/);
  assert.match(capture, /s\.id\s*==\s*session\.id/);
});
test('radial release keeps palette open; center or outside click cancels; theme injects without flash', async () => {
  const ui = await readFile(new URL('../src/components/ContextTools.tsx', import.meta.url), 'utf8');
  const hook = await readFile(new URL('../src/lib/useContextTools.ts', import.meta.url), 'utf8');
  const rust = await readFile(new URL('../src-tauri/src/context_tools.rs', import.meta.url), 'utf8');
  assert.doesNotMatch(ui, /tools-radial-release/);
  assert.doesNotMatch(hook, /tools-radial-release/);
  // 拖动手柄已按交互变更移除：转盘固定显示，点击中心或外部取消
  assert.doesNotMatch(ui, /radial-drag/);
  assert.match(ui, /aria-label="取消转盘" onClick=\{cancelRadial\}/);
  // 唤出后转盘接管焦点，失焦（点击外部/切换应用）即关闭
  assert.match(ui, /setFocus\(\)/);
  assert.match(ui, /onFocusChanged/);
  // 主题：Rust 注入首帧值 + tools-theme 推送，前端不再异步拉取
  assert.match(rust, /__UWORDS_THEME__/);
  assert.match(ui, /__UWORDS_THEME__/);
  assert.match(ui, /tools-theme/);
  assert.match(ui, /useLayoutEffect/);
  assert.doesNotMatch(ui, /native\.getConfig/);
});

test('C4 menu exit animates in the menu window; main only emits tools-menu-dismiss', async () => {
  const hook = await readFile(new URL('../src/lib/useContextTools.ts', import.meta.url), 'utf8');
  const ui = await readFile(new URL('../src/components/ContextTools.tsx', import.meta.url), 'utf8');
  const css = await readFile(new URL('../src/components/context-tools.css', import.meta.url), 'utf8');
  // 主窗口侧：退场统一发事件，菜单窗口播完动画后自己 hide；卸载清理保留强制 hide
  assert.match(hook, /const dismissMenu = \(kind: "radial" \| "selectionbar"\) => \{\s*void emitTo\(kind, "tools-menu-dismiss"\)/);
  const forcedHides = (hook.match(/void toolsApi\.hide\(/g) || []).length;
  assert.equal(forcedHides, 2, 'only the cleanup forced hides remain');
  // 菜单窗口侧：dismiss 绑定 → leaving class → 延时 tools_hide_menu；幂等由 leavingRef 保证
  assert.match(ui, /bind\("tools-menu-dismiss", \(\) => dismiss\(\)\)/);
  assert.match(ui, /if \(leavingRef\.current\) return;/);
  assert.match(ui, /invoke\("tools_hide_menu", \{ kind \}\)/);
  assert.match(ui, /radial-shell radial-shell--play\$\{leaving \? " radial-shell--leaving" : ""\}/);
  assert.match(ui, /selection-toolbar selection-toolbar--play\$\{leaving \? " selection-toolbar--leaving" : ""\}/);
  // 转盘入场 spring 直写 transform（替代旧 animation 重播）
  assert.match(ui, /animateSpring\(\{\s*from: \.7,\s*to: 1,\s*config: SPRING_POP,/);
  assert.doesNotMatch(ui, /shell\.style\.animation = "none"/);
  // CSS：stagger 18ms/片、中心 120ms pop、退场 forwards + pointer-events:none
  assert.match(css, /animation-delay:calc\(var\(--piece-i,0\)\*18ms\)/);
  assert.match(css, /@keyframes radial-pop\{from\{opacity:0;transform:scale\(\.8\)\}\}/);
  assert.match(css, /\.radial-shell--leaving\{animation:radial-leave 160ms ease forwards;pointer-events:none\}/);
  assert.match(css, /\.selection-toolbar--leaving\{animation:bar-leave 140ms ease forwards;pointer-events:none\}/);
});
