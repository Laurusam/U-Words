import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('self focus classified in rust; cross-app paste never targets own app', async () => {
  const rust = await readFile(new URL('../src-tauri/src/input_target.rs', import.meta.url), 'utf8');
  assert.match(rust, /rename = "self"/);
  assert.match(rust, /fn self_target\(\)/);
  assert.match(rust, /fn focus_is_self\(\)/);
  // self_target() 构造体 editable 恒为 false：粘贴链路对自家必然拒绝
  const selfFn = rust.slice(rust.indexOf('fn self_target()'), rust.indexOf('fn self_target()') + 400);
  assert.match(selfFn, /editable: false/);
  // Windows 自排除落实（前案 G4 判定表）
  assert.match(rust, /pid == std::process::id\(\)/);
});

test('selected-text sentinel never simulates Cmd+C inside own app', async () => {
  const platform = await readFile(new URL('../src-tauri/src/platform.rs', import.meta.url), 'utf8');
  const start = platform.indexOf('pub fn get_selected_text');
  const guard = platform.slice(start, start + 400);
  assert.match(guard, /focus_is_self\(\)/);
});

test('self dictation inserts via DOM first, broadcasts to result window as fallback', async () => {
  const app = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8');
  assert.match(app, /insertIntoSelf\(result\.text\)/);
  assert.match(app, /insertTextAtFocusedEditable\(text\)/);
  assert.match(app, /tools-self-insert/);
  assert.match(app, /tools-self-inserted/);
  const ui = await readFile(new URL('../src/components/ContextTools.tsx', import.meta.url), 'utf8');
  assert.match(ui, /tools-self-insert/);
  const lib = await readFile(new URL('../src/lib/selfInsert.ts', import.meta.url), 'utf8');
  assert.match(lib, /setRangeText/);
  assert.match(lib, /new Event\("input", \{ bubbles: true \}\)/);
});
