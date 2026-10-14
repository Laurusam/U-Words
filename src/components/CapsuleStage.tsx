import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { OverlayCommand, OverlayResult, OverlayState } from "../types";
import { native } from "../lib/native";
import { diffWords } from "../lib/diff";
import { ImageReveal } from "./ImageReveal";
import { animateSpring, prefersReducedMotion, SPRING_POP, SPRING_SETTLE, type SpringHandle } from "../lib/spring";
import "./capsule.css";

/** 壳几何：胶囊 F1/F2 与卡片 F5/F3/F4；窗口尺寸见 WINDOW_*（壳外留标签行/抗锯齿余量）。
 *  card-x = F3 ⌄ 展开原文对照后的加高卡片；card-img = F4 图片解析窗（图片 + 文本）。 */
const SHELL_CAPSULE = { width: 164, height: 40, radius: 999 };
const SHELL_CARD = { width: 340, height: 220, radius: 16 };
const SHELL_CARD_EXPANDED = { width: 340, height: 320, radius: 16 };
const SHELL_CARD_IMAGE = { width: 360, height: 430, radius: 16 };
const WINDOW_CAPSULE = { width: 166, height: 66 };
const WINDOW_CARD = { width: 342, height: 222 };
const WINDOW_CARD_EXPANDED = { width: 342, height: 322 };
const WINDOW_CARD_IMAGE = { width: 362, height: 432 };

const GEOMETRIES = {
  capsule: { shell: SHELL_CAPSULE, window: WINDOW_CAPSULE },
  card: { shell: SHELL_CARD, window: WINDOW_CARD },
  "card-x": { shell: SHELL_CARD_EXPANDED, window: WINDOW_CARD_EXPANDED },
  "card-img": { shell: SHELL_CARD_IMAGE, window: WINDOW_CARD_IMAGE },
} as const;
type GeomKey = keyof typeof GEOMETRIES;

type StageKind = "record" | "process" | "flash" | "text" | "preview" | "image";

/** 六态路由：idle 归 null；result（F4 图片 / F3 文本/失败态）优先于 preview（F5 复制兜底）；ready/error 归 flash。 */
export function resolveStage(state: OverlayState): StageKind | null {
  if (state.status === "idle") return null;
  if (state.result?.text || state.result?.error) return state.result.image ? "image" : "text";
  if (state.result?.image) return "image";
  if (state.preview && state.text.trim()) return "preview";
  if (state.status === "recording") return "record";
  if (state.status === "transcribing" || state.status === "rendering") return "process";
  return "flash";
}

function hasTauriRuntime() {
  return Boolean((window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
}

function Glyph({ kind }: { kind: "close" | "check" | "warning" | "expand" }) {
  return <svg data-icon={kind} width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {kind === "close" ? <path d="m7 7 10 10M17 7 7 17" />
      : kind === "check" ? <path d="m5 13 4 4L19 7" />
        : kind === "expand" ? <path d="m6 9 6 6 6-6" />
          : <><path d="M12 5v9" /><circle cx="12" cy="19" r="1" fill="currentColor" stroke="none" /></>}
  </svg>;
}

function RecordFace({ level, onCommand }: { level: number; onCommand: (command: OverlayCommand) => void }) {
  const safe = Number.isFinite(level) ? Math.max(0, Math.min(1, level)) : 0;
  return <>
    <button type="button" className="floating-action floating-cancel" onClick={() => onCommand("cancel")} aria-label="取消录音" title="取消（Esc）"><Glyph kind="close" /></button>
    <div className="floating-meter" aria-label="实时音量">
      {Array.from({ length: 13 }, (_, index) => {
        const scale = (3 + Math.max(.05, safe) * (7 + (6 - Math.abs(6 - index)) * 2)) / 22;
        return <i key={index} style={{ height: "22px", transform: `scaleY(${scale.toFixed(3)})`, opacity: safe > .02 ? 1 : .45, "--bar-i": index } as CSSProperties} />;
      })}
    </div>
    <button type="button" className="floating-action floating-confirm" onClick={() => onCommand("finish")} aria-label="完成录音" title="完成"><Glyph kind="check" /></button>
  </>;
}

function ProcessFace({ transcribing, onCommand }: { transcribing: boolean; onCommand: (command: OverlayCommand) => void }) {
  return <>
    <button type="button" className="floating-action floating-cancel" onClick={() => onCommand("cancel")} aria-label="取消处理" title="取消（Esc）"><Glyph kind="close" /></button>
    <div className="capsule-process" role="status"><span className="capsule-pulse" aria-hidden="true" />{transcribing ? "识别中" : "整理中"}</div>
    <span className="floating-progress-slot" aria-hidden="true"><span className="floating-spinner" /></span>
  </>;
}

function FlashFace({ ready, onCommand }: { ready: boolean; onCommand: (command: OverlayCommand) => void }) {
  return <>
    <span className={`floating-result-mark${ready ? "" : " error"}`} aria-hidden="true"><Glyph kind={ready ? "check" : "warning"} /></span>
    <span className="floating-status-text">{ready ? "已完成" : "未完成"}</span>
    <button type="button" className="floating-action floating-dismiss" onClick={() => onCommand("dismiss")} aria-label={ready ? "关闭提示" : "关闭错误提示"} title="关闭"><Glyph kind="close" /></button>
  </>;
}

function TextFace({ text, countdown, copyFeedback, onCommand }: { text: string; countdown?: number; copyFeedback?: string; onCommand: (command: OverlayCommand) => void }) {
  return <>
    <header className="capsule-card-head">
      <small className="floating-countdown" aria-label="自动关闭倒计时">{countdown ? `${countdown}s` : ""}</small>
      <button type="button" className="floating-action floating-dismiss" onClick={() => onCommand("dismiss")} aria-label="关闭文字预览"><Glyph kind="close" /></button>
    </header>
    <div className="floating-preview-text" tabIndex={0}>{text}</div>
    <footer className="capsule-card-foot">
      <button type="button" className="floating-copy" onClick={() => onCommand("copy")} aria-label="复制完整文本">{copyFeedback || "复制文本"}</button>
    </footer>
  </>;
}

/** F3 文本结果窗：默认只显示最终结果；⌄ 展开原文对照（黑白灰 diff）；
 *  writeStatus written = 已写入原选区（无按钮，1.2s 由上层自动收缩淡出），否则仅 [复制]；
 *  result.error = 工具会话失败：role=alert 展示原因，不提供复制与对照。 */
function ResultFace({ result, expanded, copyFeedback, onCommand, onToggleExpand }: {
  result: OverlayResult;
  expanded: boolean;
  copyFeedback?: string;
  onCommand: (command: OverlayCommand) => void;
  onToggleExpand: () => void;
}) {
  const written = result.writeStatus === "written";
  const failed = Boolean(result.error);
  // diff 分词较贵：仅在展开/内容变化时重算
  const segments = useMemo(
    () => (!failed && expanded && result.source ? diffWords(result.source, result.text) : null),
    [failed, expanded, result.source, result.text],
  );
  const meta = [result.action, result.app].filter(Boolean).join(" · ");
  return <>
    {written ? null : <header className="capsule-card-head">
      <span className="capsule-result-meta">{expanded ? meta : ""}</span>
      <span className="capsule-card-tools">
        {/* 失败态没有原文对照可展开：⌄ 按钮随复制/diff 一并隐藏，控件不承诺不存在的功能 */}
        {failed ? null : <button type="button" className="floating-action capsule-expand" onClick={onToggleExpand} aria-expanded={expanded} aria-label={expanded ? "收起原文对照" : "展开原文对照"} title="原文对照"><Glyph kind="expand" /></button>}
        <button type="button" className="floating-action floating-dismiss" onClick={() => onCommand("dismiss")} aria-label="关闭结果" title="关闭（Esc）"><Glyph kind="close" /></button>
      </span>
    </header>}
    {result.error && <p className="capsule-result-error" role="alert">{result.error}</p>}
    {segments && <div className="capsule-result-diff" tabIndex={0} aria-label="原文与结果对照">
      {segments.map((segment, index) => <span key={index} className={`capsule-diff-${segment.type}`}>{segment.text}</span>)}
    </div>}
    {failed ? null : <div className="floating-preview-text" tabIndex={0}>{result.text}</div>}
    {written || failed ? null : <footer className="capsule-card-foot">
      <button type="button" className="floating-copy" onClick={() => onCommand("copy")} aria-label="复制结果">{copyFeedback || "复制"}</button>
    </footer>}
  </>;
}

/** F4 图片解析窗：截图扫描呈现（等待时慢扫循环，文字到达加速点亮全图）；
 *  识别中仅 [×] + 脉冲占位（文本区高度撑住卡片，避免完成时二次形变），完成后追加 [复制文字]。 */
function ImageFace({ result, copyFeedback, onCommand }: {
  result: OverlayResult;
  copyFeedback?: string;
  onCommand: (command: OverlayCommand) => void;
}) {
  const done = Boolean(result.text);
  const meta = [result.action, result.app].filter(Boolean).join(" · ");
  return <>
    <header className="capsule-card-head">
      <span className="capsule-result-meta">{done ? meta : ""}</span>
      <span className="capsule-card-tools">
        <button type="button" className="floating-action floating-dismiss" onClick={() => onCommand("dismiss")} aria-label="关闭结果" title="关闭（Esc）"><Glyph kind="close" /></button>
      </span>
    </header>
    {result.image ? <ImageReveal image={result.image} revealed={done} /> : null}
    {done
      ? <div className="floating-preview-text" tabIndex={0}>{result.text}</div>
      : <div className="capsule-image-process" role="status"><span className="capsule-pulse" aria-hidden="true" />识别中</div>}
    {done ? <footer className="capsule-card-foot">
      <button type="button" className="floating-copy" onClick={() => onCommand("copy")} aria-label="复制识别文字">{copyFeedback || "复制文字"}</button>
    </footer> : null}
  </>;
}

/**
 * 胶囊壳唯一渲染处：所有 face 共用一个壳元素。
 * - idle → 首个 stage：壳几何直接落位，随后出场 spring（scale .6→1 / y 14→0 / opacity 0→1，380ms 轻过冲）
 * - stage 间壳几何变化（capsule ↔ card ↔ card-x，含 F3 展开）：窗口尺寸立即到位（resize_overlay），
 *   壳 w/h/radius spring 跟随；动画期窗口忽略光标事件，完成后恢复
 * - 同壳几何内 stage 切换：crossfade 200ms（旧 face 淡出，录音 bar 逐根沉降）
 * - exiting：退场 spring（scale→.85 + opacity→0，160ms）后回调 onExited，由上层 hide 窗口
 */
export function CapsuleStage({ state, countdown, copyFeedback, exiting, onCommand, onExited }: {
  state: OverlayState;
  countdown?: number;
  copyFeedback?: string;
  exiting: boolean;
  onCommand: (command: OverlayCommand) => void;
  onExited: () => void;
}) {
  const stage = resolveStage(state);
  const card = stage === "text" || stage === "preview" || stage === "image";
  const [expanded, setExpanded] = useState(false);
  const geomKey: GeomKey = card ? (stage === "image" ? "card-img" : expanded ? "card-x" : "card") : "capsule";
  const shellRef = useRef<HTMLElement | null>(null);
  const animsRef = useRef<SpringHandle[]>([]);
  const geomRef = useRef({ ...SHELL_CAPSULE });
  const xfRef = useRef({ scale: 1, y: 0, opacity: 0 });
  const geomKeyRef = useRef<GeomKey | null>(null);
  const stageRef = useRef<StageKind | null>(null);
  const enteredRef = useRef(false);
  const leaveTimerRef = useRef(0);
  const onExitedRef = useRef(onExited);
  onExitedRef.current = onExited;
  // 形变期鼠标穿透的恢复闭包：cancelAnims/卸载统一兜底，避免动画中断后窗口永久穿透
  const restoreCursorRef = useRef<(() => void) | null>(null);
  const [leaving, setLeaving] = useState<{ stage: StageKind; card: boolean } | null>(null);

  // 新结果/内容变化或离开结果窗时收起对照（writeStatus+text 作键，避开跨窗事件的对象身份抖动）
  const resultKey = state.result ? `${state.result.writeStatus ?? ""}|${state.result.text}` : "";
  useEffect(() => {
    setExpanded(false);
  }, [resultKey]);

  const cancelAnims = () => {
    for (const anim of animsRef.current) anim.cancel();
    animsRef.current = [];
    // 弹簧取消不触发 onComplete，形变被中断时由这里恢复鼠标事件
    restoreCursorRef.current?.();
  };

  const applyGeom = () => {
    const shell = shellRef.current;
    if (!shell) return;
    shell.style.width = `${geomRef.current.width}px`;
    shell.style.height = `${geomRef.current.height}px`;
    shell.style.borderRadius = `${geomRef.current.radius}px`;
  };

  const applyXf = () => {
    const shell = shellRef.current;
    if (!shell) return;
    const { scale, y, opacity } = xfRef.current;
    shell.style.transform = `translateY(${y.toFixed(2)}px) scale(${scale.toFixed(4)})`;
    shell.style.opacity = opacity.toFixed(3);
  };

  // stage 切换：出场 / 形态 spring / crossfade
  useEffect(() => {
    const shell = shellRef.current;
    if (!shell) return;
    const prev = stageRef.current;
    stageRef.current = stage;
    window.clearTimeout(leaveTimerRef.current);

    if (stage === null) {
      cancelAnims();
      enteredRef.current = false;
      geomKeyRef.current = null;
      shell.classList.add("capsule-shell--idle");
      setLeaving(null);
      return;
    }

    shell.classList.remove("capsule-shell--idle");
    const target = GEOMETRIES[geomKey];

    if (!enteredRef.current) {
      // 首次出现：几何直接落位目标形态（不播形变），随后播出场动画
      enteredRef.current = true;
      geomKeyRef.current = geomKey;
      geomRef.current = { ...target.shell };
      applyGeom();
      xfRef.current = { scale: .6, y: 14, opacity: 0 };
      applyXf();
      const xf = xfRef.current;
      animsRef.current = [
        animateSpring({ from: .6, to: 1, config: SPRING_POP, onUpdate: v => { xf.scale = v; applyXf(); } }),
        animateSpring({ from: 14, to: 0, config: SPRING_POP, onUpdate: v => { xf.y = v; applyXf(); } }),
        animateSpring({ from: 0, to: 1, config: SPRING_POP, onUpdate: v => { xf.opacity = v; applyXf(); } }),
      ];
      return;
    }

    // 中断未完成的退场/前序动画：清掉残留弹簧（退场/形变同一属性只保留一个动画源），
    // 恢复常态变换再走 crossfade/形变
    cancelAnims();
    xfRef.current = { scale: 1, y: 0, opacity: 1 };
    applyXf();

    // stage → stage：保留旧 face 淡出层（含录音 bar 沉降）
    if (prev !== null && prev !== stage) setLeaving({ stage: prev, card: prev === "text" || prev === "preview" || prev === "image" });
    leaveTimerRef.current = window.setTimeout(() => setLeaving(null), 220);

    // 壳几何变化：窗口尺寸立即到位，壳 w/h/radius spring 跟随；动画期忽略光标事件
    if (geomKeyRef.current !== geomKey) {
      geomKeyRef.current = geomKey;
      const windowSize = target.window;
      const reduced = prefersReducedMotion();
      let restoreCursor: (() => void) | null = null;
      if (hasTauriRuntime()) {
        const currentWindow = getCurrentWindow();
        void currentWindow.setIgnoreCursorEvents(true).catch(() => undefined);
        void native.resizeOverlay(windowSize.width, windowSize.height).catch(() => undefined);
        restoreCursor = () => {
          if (!restoreCursorRef.current) return; // 幂等：完成与中断只恢复一次
          restoreCursorRef.current = null;
          void currentWindow.setIgnoreCursorEvents(false).catch(() => undefined);
        };
        restoreCursorRef.current = restoreCursor;
      }
      if (reduced) {
        geomRef.current = { ...target.shell };
        applyGeom();
        restoreCursor?.();
        return;
      }
      let done = 0;
      const complete = () => {
        done += 1;
        if (done >= 3) restoreCursor?.();
      };
      animsRef.current.push(
        animateSpring({ from: geomRef.current.width, to: target.shell.width, config: SPRING_POP, onUpdate: v => { geomRef.current.width = v; applyGeom(); }, onComplete: complete }),
        animateSpring({ from: geomRef.current.height, to: target.shell.height, config: SPRING_POP, onUpdate: v => { geomRef.current.height = v; applyGeom(); }, onComplete: complete }),
        animateSpring({ from: geomRef.current.radius, to: target.shell.radius, config: SPRING_POP, onUpdate: v => { geomRef.current.radius = v; applyGeom(); }, onComplete: complete }),
      );
    }
  }, [stage, geomKey]);

  // 退场：160ms 收缩淡出后交还上层（hide 窗口）
  useEffect(() => {
    if (!exiting) return;
    const shell = shellRef.current;
    if (!shell) {
      onExitedRef.current();
      return;
    }
    cancelAnims();
    const xf = { ...xfRef.current };
    let done = 0;
    let finished = false;
    const complete = () => {
      done += 1;
      if (done >= 2 && !finished) {
        finished = true;
        // 复位壳状态：下次出现重新走出场动画（窗口此刻已无可见内容）
        enteredRef.current = false;
        stageRef.current = null;
        geomKeyRef.current = null;
        shell.classList.add("capsule-shell--idle");
        setLeaving(null);
        onExitedRef.current();
      }
    };
    const created = [
      animateSpring({ from: xf.scale, to: .85, config: SPRING_SETTLE, onUpdate: v => { xfRef.current.scale = v; applyXf(); }, onComplete: complete }),
      animateSpring({ from: xf.opacity, to: 0, config: SPRING_SETTLE, onUpdate: v => { xfRef.current.opacity = v; applyXf(); }, onComplete: complete }),
    ];
    animsRef.current = created;
    // 退场被中断（160ms 内来了新录音/主窗先置 idle）时由清理函数掐掉弹簧，避免残留 rAF 与新动画叠加
    return () => {
      for (const anim of created) anim.cancel();
    };
  }, [exiting]);

  // 卸载清理
  useEffect(() => () => {
    cancelAnims();
    window.clearTimeout(leaveTimerRef.current);
  }, []);

  const level = Number.isFinite(state.level) ? Math.max(0, Math.min(1, state.level)) : 0;
  const renderFace = (kind: StageKind, isLeaving: boolean) => {
    switch (kind) {
      case "record": return <RecordFace level={isLeaving ? 0 : level} onCommand={onCommand} />;
      case "process": return <ProcessFace transcribing={state.status === "transcribing"} onCommand={onCommand} />;
      case "flash": return <FlashFace ready={state.status === "ready"} onCommand={onCommand} />;
      case "text": return state.result
        ? <ResultFace result={state.result} expanded={expanded} copyFeedback={copyFeedback} onCommand={onCommand} onToggleExpand={() => setExpanded(value => !value)} />
        : null;
      case "image": return state.result
        ? <ImageFace result={state.result} copyFeedback={copyFeedback} onCommand={onCommand} />
        : null;
      case "preview": return <TextFace text={state.text} countdown={countdown} copyFeedback={copyFeedback} onCommand={onCommand} />;
    }
  };

  const statusLabel = stage === "record" ? (state.operation === "edit" ? "选区编辑录音中" : "口述录音中")
    : stage === "process" ? "正在处理"
    : stage === "flash" ? (state.status === "ready" ? "已完成" : "未完成")
    : stage === "text" ? (state.result?.error ? "工具会话失败" : state.result?.writeStatus === "written" ? "已写入原选区" : "结果已生成，可复制")
    : stage === "image" ? (state.result?.text ? "识别完成，可复制" : "正在识别截图文字")
    : stage === "preview" ? "文字已保留，可复制"
    : "";

  return <main className="overlay-root capsule-root">
    {card ? null : <div className="floating-mode-label" aria-hidden={!state.label}>{state.label || ""}</div>}
    <section
      ref={shellRef}
      className={`capsule-shell${stage === null ? " capsule-shell--idle" : ""}`}
      role={stage === "flash" && state.status === "error" ? "alert" : "status"}
      aria-label={statusLabel || undefined}
    >
      <div className="capsule-face-layer">
        {leaving && <div className={`capsule-face capsule-face--leaving${leaving.card ? " capsule-face--card" : ""}`} aria-hidden="true">{renderFace(leaving.stage, true)}</div>}
        {stage !== null && <div key={stage} className={`capsule-face${card ? " capsule-face--card" : ""}`}>{renderFace(stage, false)}</div>}
      </div>
    </section>
  </main>;
}
