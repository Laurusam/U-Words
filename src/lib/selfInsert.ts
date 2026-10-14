// 焦点在 U-Words 自身时的原生插入通道：不经剪贴板、不模拟键盘、零权限依赖。
// 返回 false 表示当前文档没有可编辑焦点，调用方自行降级（如复制卡片）。
export function insertTextAtFocusedEditable(text: string): boolean {
  // 窗口失焦后 activeElement 保留旧焦点元素，插入会写进用户未注视的位置：失焦一律交由上层降级链
  if (typeof document.hasFocus === "function" && !document.hasFocus()) return false;
  const el = document.activeElement;
  if (!el || el === document.body) return false;
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
    if (el.disabled || el.readOnly) return false;
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? start;
    // setRangeText 绕过 React 的 value 追踪器，随后的 input 事件会被 React 正常识别并同步状态
    el.setRangeText(text, start, end, "end");
    el.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  }
  if (el instanceof HTMLElement && el.isContentEditable) {
    el.focus();
    return document.execCommand("insertText", false, text);
  }
  return false;
}
