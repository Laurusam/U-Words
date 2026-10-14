import { useState } from "react";
import { CapsuleStage } from "./CapsuleStage";
import { PlanReviewView } from "./PlanReviewView";
import type { AppStatus, AppTheme } from "../types";

// 合成截图样本：canvas 现场生成 dataURL，预览页离线可用
const PREVIEW_IMAGE = (() => {
  const canvas = document.createElement("canvas");
  canvas.width = 480;
  canvas.height = 300;
  const context = canvas.getContext("2d");
  if (!context) return "";
  context.fillStyle = "#20242c";
  context.fillRect(0, 0, 480, 300);
  context.fillStyle = "#2c313c";
  for (let y = 0; y < 300; y += 24) context.fillRect(0, y, 480, 12);
  context.fillStyle = "#e8eaf0";
  context.font = "600 28px system-ui, sans-serif";
  context.fillText("U-Words 截图识字", 32, 64);
  context.fillStyle = "#aab2c2";
  context.font = "16px system-ui, sans-serif";
  context.fillText("扫描线呈现 · 识别结果显示在下方文本区", 32, 104);
  context.fillText('if (state.result?.image) return "image";', 32, 152);
  context.fillText('return state.result?.text ? "text" : "preview";', 32, 180);
  return canvas.toDataURL("image/png");
})();

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
    <div className="overlay-preview-grid">{statuses.map((status) => <div key={status}><p>{status}</p><div className="overlay-preview-cell"><CapsuleStage state={{ status, theme, operation: "dictate", level: .7, message: status === "error" ? "识别未完成，请检查网络和模型权限" : status, text: "" }} exiting={false} onCommand={(action) => setCommand(`${status}: ${action}`)} onExited={() => undefined} /></div></div>)}</div>
    <p role="status">最近操作：{command}</p>
    <h2>模式名称与居中对齐</h2>
    <div className="overlay-preview-grid">{["", "翻译", "编辑选区", "提问"].map(label => <div key={label}><p>{label || "转录 · 不显示名称"}</p><div className="overlay-preview-cell"><CapsuleStage state={{ status: "recording", theme, operation: label === "编辑选区" ? "edit" : "dictate", label, level: .7, message: "录音中", text: "" }} exiting={false} onCommand={action => setCommand(`${label || "转录"}: ${action}`)} onExited={() => undefined} /></div></div>)}</div>
    <h2>无光标复制预览</h2><div style={{ width: 342, height: 222 }}><CapsuleStage state={{ status: "ready", theme, operation: "dictate", level: 0, preview: true, message: "未检测到可编辑光标，请复制文字", text: "模型返回后，先交付文字，再异步处理统计和历史保存。\n\n如果自动插入失败，应保留结果，避免内容丢失。" }} countdown={15} copyFeedback={command === "preview: copy" ? "已复制" : ""} exiting={false} onCommand={(action) => setCommand(`preview: ${action}`)} onExited={() => undefined} /></div>
    <h2>文本结果窗（写入成功无按钮 1.2s 自动收缩；点 ⌄ 展开黑白灰对照）</h2>
    <div className="overlay-preview-grid">
      {([
        { name: "已写入原选区", writeStatus: "written", copied: false },
        { name: "复制兜底", writeStatus: "copy", copied: command === "result: copy" },
      ] as const).map(row => <div key={row.name}><p>{row.name}</p><div className="overlay-preview-cell" style={{ width: 342, height: 322 }}><CapsuleStage state={{ status: "ready", theme, operation: "edit", label: "", level: 0, message: "", text: "", result: { action: "编辑选区", app: "Visual Studio Code", source: "先插入文字，再检查是否偏移原意，避免误改。", text: "先写入文字，再检查是否偏离原意，避免误改。", writeStatus: row.writeStatus } }} copyFeedback={row.copied ? "已复制" : ""} exiting={false} onCommand={(action) => setCommand(`result: ${action}`)} onExited={() => undefined} /></div></div>)}
    </div>
    <h2>图片解析窗（识别中慢速扫描；文字到达加速点亮全图）</h2>
    <div className="overlay-preview-grid">
      {([
        { name: "识别中", text: "", copied: false },
        { name: "识别完成", text: "U-Words 0.8.0\n胶囊交互系统 · 六态路由\n截图识字直达结果窗", copied: command === "image: copy" },
      ] as const).map(row => <div key={row.name}><p>{row.name}</p><div className="overlay-preview-cell" style={{ width: 362, height: 432 }}><CapsuleStage state={{ status: "ready", theme, operation: "dictate", label: "", level: 0, message: "", text: "", result: { action: "截图识字", app: "Preview", image: PREVIEW_IMAGE, text: row.text } }} copyFeedback={row.copied ? "已复制" : ""} exiting={false} onCommand={(action) => setCommand(`image: ${action}`)} onExited={() => undefined} /></div></div>)}
    </div>
    <button onClick={() => { setReview(true); setReviewResult(false); }}>预览方案检查（合成数据，不调用模型）</button>
    {review && <PlanReviewView theme={theme} session={{ source: "先插入文字，再检查是否偏移原意。", provider: "本地样式预览 · 不请求服务商", busy: false, ...(reviewResult ? { result: { organizedPlan: "先插入文字，再检查是否偏移原意。", issues: [{ title: "检查时机需确认", evidence: "先插入文字", detail: "如果用于阻止错误交付，应在插入之前检查。" }], suggestions: [{ title: "前置轻量检查", detail: "可将关键内容差异检查放在插入之前。", condition: "仅在该检查用于阻止错误交付时采用。" }] } } : {}) }} onClose={() => setReview(false)} onCheck={() => setReviewResult(true)} onCopy={() => setCommand("review: copy")} onInsert={() => { setCommand("review: prepare"); setReview(false); }} />}
  </div>;
}
