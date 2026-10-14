export type DiffSegmentType = "common" | "del" | "add";
export type DiffSegment = { type: DiffSegmentType; text: string };

// 分词：CJK 逐字、拉丁字母/数字连串成词、空白整段、其余标点逐个 —— 中文按字对比、英文按词对比
const TOKEN_PATTERN = /\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}|[\p{L}\p{N}]+|\s+|[\p{P}\p{S}]|./gu;

function tokenize(text: string): string[] {
  return text.match(TOKEN_PATTERN) ?? [];
}

// LCS 为 O(n²)：超长文本不做逐词对照，整体视为相同，避免结果窗展开卡顿
const TOKEN_CAP = 1500;

/**
 * 词级 LCS diff（无依赖）：供 F3 结果窗 ⌄ 展开后的"原文 ⇄ 结果"对照。
 * common = 两者共有；del = 仅原文（删除线淡化）；add = 仅结果（强调）。
 * 回溯时相邻同类型分段立即合并，保证渲染节点数最小。
 */
export function diffWords(source: string, result: string): DiffSegment[] {
  const a = tokenize(source);
  const b = tokenize(result);
  if (a.length === 0) return b.length === 0 ? [] : [{ type: "add", text: result }];
  if (b.length === 0) return [{ type: "del", text: source }];
  if (a.length > TOKEN_CAP || b.length > TOKEN_CAP) return [{ type: "common", text: result }];

  const cols = a.length;
  const width = cols + 1;
  // dp[i * width + j] = b[i..] 与 a[j..] 的 LCS 长度；整表便于回溯（1.5k² × 2B ≈ 4.5MB 上限）
  const dp = new Uint16Array((b.length + 1) * width);
  for (let i = b.length - 1; i >= 0; i -= 1) {
    for (let j = cols - 1; j >= 0; j -= 1) {
      dp[i * width + j] = a[j] === b[i]
        ? dp[(i + 1) * width + j + 1] + 1
        : Math.max(dp[(i + 1) * width + j], dp[i * width + j + 1]);
    }
  }

  const segments: DiffSegment[] = [];
  const push = (type: DiffSegmentType, text: string) => {
    const last = segments[segments.length - 1];
    if (last && last.type === type) last.text += text;
    else segments.push({ type, text });
  };
  let i = 0;
  let j = 0;
  while (i < b.length && j < cols) {
    if (a[j] === b[i]) {
      push("common", b[i]);
      i += 1;
      j += 1;
    } else if (dp[i * width + j + 1] >= dp[(i + 1) * width + j]) {
      // 删除路径的后续 LCS 更长（或等值）时先删；等值时先删后加，保持"原文→结果"阅读顺序
      push("del", a[j]);
      j += 1;
    } else {
      push("add", b[i]);
      i += 1;
    }
  }
  while (j < cols) {
    push("del", a[j]);
    j += 1;
  }
  while (i < b.length) {
    push("add", b[i]);
    i += 1;
  }
  return segments;
}
