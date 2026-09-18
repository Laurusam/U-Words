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

test('voice question is a draft, translation previews, snapshot is preserved', async () => {
  const app = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8');
  // 契约正则对空白容忍，只约束控制流，不约束排版。
  const voiceStart = app.search(/if \(voiceQuestionRef\.current\) \{/);
  assert.ok(voiceStart >= 0, 'voice question branch not found');
  const voice = app.slice(voiceStart, app.indexOf('if (!transcript.trim())'));
  assert.match(voice, /tools_question/);
  assert.doesNotMatch(voice, /toolsApi\.run/);
  assert.match(app, /selection:\s*selectedSnapshotRef\.current/);
  assert.match(app, /else if \(config\.mode === "translate"\)[\s\S]*?tools_preview/);
});

test('capture hides all own windows and has no upload call', async () => {
  const capture = await readFile(new URL('../src-tauri/src/capture.rs', import.meta.url), 'utf8');
  assert.match(capture, /\[\s*"main"\s*,\s*"radial"\s*,\s*"selectionbar"\s*,\s*"result"\s*,\s*"overlay"\s*,?\s*\]/);
  assert.doesNotMatch(capture, /\.post\(|\.bearer_auth\(/);
  assert.match(capture, /s\.id\s*==\s*session\.id/);
});
