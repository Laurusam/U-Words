import { useState } from "react";
import { OverlayView } from "./OverlayView";
import { PlanReviewView } from "./PlanReviewView";
import type { AppStatus, AppTheme } from "../types";

// Development-only visual QA: never starts recording or invokes native APIs.
export function OverlayPreview() {
  const [theme, setTheme] = useState<AppTheme>("dark");
  const [command, setCommand] = useState("未操作");
  const [review, setReview] = useState(false);
  const [reviewResult, setReviewResult] = useState(false);
  const statuses: AppStatus[] = ["recording", "transcribing", "rendering", "ready", "error"];
  return <div className="overlay-preview" data-theme={theme}>
    <h1>浮窗状态预览</h1><p>仅样式与按钮测试，不录音、不请求模型。</p>
    <button onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>切换{theme === "dark" ? "浅色" : "深色"}</button>
    <div className="overlay-preview-grid">{statuses.map((status) => <div key={status}><p>{status}</p><div className="overlay-preview-cell"><OverlayView state={{ status, theme, operation: "dictate", level: .7, message: status === "error" ? "识别未完成，请检查网络和模型权限" : status, text: "" }} onCommand={(action) => setCommand(`${status}: ${action}`)} /></div></div>)}</div>
    <p role="status">最近操作：{command}</p>
    <h2>模式名称与居中对齐</h2>
    <div className="overlay-preview-grid">{["", "翻译", "编辑选区", "提问"].map(label => <div key={label}><p>{label || "转录 · 不显示名称"}</p><div className="overlay-preview-cell"><OverlayView state={{ status: "recording", theme, operation: label === "编辑选区" ? "edit" : "dictate", label, level: .7, message: "录音中", text: "" }} onCommand={action => setCommand(`${label || "转录"}: ${action}`)} /></div></div>)}</div>
    <h2>无光标复制预览</h2><div style={{ width: 342, height: 222 }}><OverlayView state={{ status: "ready", theme, operation: "dictate", level: 0, preview: true, message: "未检测到可编辑光标，请复制文字", text: "模型返回后，先交付文字，再异步处理统计和历史保存。\n\n如果自动插入失败，应保留结果，避免内容丢失。", copyFeedback: command === "preview: copy" ? "已复制" : "" }} onCommand={(action) => setCommand(`preview: ${action}`)} /></div>
    <button onClick={() => { setReview(true); setReviewResult(false); }}>预览方案检查（合成数据，不调用模型）</button>
    {review && <PlanReviewView theme={theme} session={{ source: "先插入文字，再检查是否偏移原意。", provider: "本地样式预览 · 不请求服务商", busy: false, ...(reviewResult ? { result: { organizedPlan: "先插入文字，再检查是否偏移原意。", issues: [{ title: "检查时机需确认", evidence: "先插入文字", detail: "如果用于阻止错误交付，应在插入之前检查。" }], suggestions: [{ title: "前置轻量检查", detail: "可将关键内容差异检查放在插入之前。", condition: "仅在该检查用于阻止错误交付时采用。" }] } } : {}) }} onClose={() => setReview(false)} onCheck={() => setReviewResult(true)} onCopy={() => setCommand("review: copy")} onInsert={() => { setCommand("review: prepare"); setReview(false); }} />}
  </div>;
}
