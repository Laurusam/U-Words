import type { OverlayCommand, OverlayState } from "../types";
import { ProcessingProgress } from "./ProcessingProgress";

function Glyph({ kind }: { kind: "close" | "check" | "warning" }) {
  return <svg data-icon={kind} width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {kind === "close" ? <path d="m7 7 10 10M17 7 7 17" /> : kind === "check" ? <path d="m5 13 4 4L19 7" /> : <><path d="M12 5v9" /><circle cx="12" cy="19" r="1" fill="currentColor" stroke="none" /></>}
  </svg>;
}

export function OverlayView({ state, onCommand }: { state: OverlayState; onCommand: (command: OverlayCommand) => void }) {
  const level = Number.isFinite(state.level) ? Math.max(0, Math.min(1, state.level)) : 0;
  if (state.status === "idle") return <div className="overlay-root" aria-hidden="true" />;
  if (state.preview && state.text.trim()) return <main className="overlay-root">
    <section className="floating-preview" role="status" aria-label="文字已保留，可复制">
      <header><strong>{state.status === "error" ? "已保留转写" : "文字已生成"}</strong><button className="floating-action floating-dismiss" onClick={() => onCommand("dismiss")} aria-label="关闭文字预览"><Glyph kind="close" /></button></header>
      <p className="floating-preview-reason">{state.message}</p>
      <div className="floating-preview-text" tabIndex={0}>{state.text}</div>
      <footer><small>{state.copyFeedback || "不会自动消失"}</small><button className="floating-copy" onClick={() => onCommand("copy")} aria-label="复制完整文本">{state.copyFeedback === "已复制" ? "已复制" : "复制文本"}</button></footer>
    </section>
  </main>;
  const recording = state.status === "recording";
  const processing = state.status === "transcribing" || state.status === "rendering";
  const ready = state.status === "ready";
  const statusLabel = recording ? `${state.operation === "edit" ? "选区编辑" : "口述"}录音中` : state.message;
  const variant = recording ? "recording" : processing ? "processing" : ready ? "result" : "error";
  return <main className="overlay-root capsule-root" title={state.message}>
    <div className="floating-mode-label" aria-hidden={!state.label}>{state.label || ""}</div>
    <section className={`floating-overlay floating-${variant}`} role={variant === "error" ? "alert" : "status"} aria-label={statusLabel}>
      {recording || processing ? <button className="floating-action floating-cancel" onClick={() => onCommand("cancel")} aria-label={recording ? "取消录音" : "取消处理"} title="取消（Esc）"><Glyph kind="close" /></button>
        : <span className={`floating-result-mark${ready ? "" : " error"}`} aria-hidden="true"><Glyph kind={ready ? "check" : "warning"} /></span>}
      {recording ? <div className="floating-meter" aria-label="实时音量">{Array.from({ length: 13 }, (_, index) => <i key={index} style={{ height: "22px", transform: `scaleY(${(3 + Math.max(.05, level) * (7 + (6 - Math.abs(6 - index)) * 2))/22})`, opacity: level > .02 ? 1 : .45 }} />)}</div>
        : processing ? <ProcessingProgress stage={state.status} compact />
        : <span className="floating-status-text">{ready ? "已完成" : "未完成"}</span>}
      {recording ? <button className="floating-action floating-confirm" onClick={() => onCommand("finish")} aria-label="完成录音" title="完成"><Glyph kind="check" /></button>
        : processing ? <span className="floating-progress-slot" aria-hidden="true"><span className="floating-spinner" /></span>
        : <button className="floating-action floating-dismiss" onClick={() => onCommand("dismiss")} aria-label={ready ? "关闭提示" : "关闭错误提示"} title="关闭"><Glyph kind="close" /></button>}
    </section>
  </main>;
}
