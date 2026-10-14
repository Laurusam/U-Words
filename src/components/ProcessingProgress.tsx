import { useEffect, useRef } from "react";
import type { AppStatus } from "../types";
import { prefersReducedMotion } from "../lib/spring";

export function estimatedProgress(stage: AppStatus, elapsed: number): number {
  const seconds = Math.max(0, Number.isFinite(elapsed) ? elapsed : 0) / 1000;
  return stage === "transcribing" ? 0.08 + 0.54 * (1 - Math.exp(-seconds / 8))
    : stage === "rendering" ? 0.65 + 0.32 * (1 - Math.exp(-seconds / 6)) : 0;
}

export function ProcessingProgress({ stage }: { stage: AppStatus }) {
  const bar = useRef<HTMLSpanElement>(null);
  const active = stage === "transcribing" || stage === "rendering";
  useEffect(() => {
    if (!active) return;
    const start = performance.now();
    const draw = () => {
      if (bar.current) bar.current.style.transform = `scaleX(${estimatedProgress(stage, performance.now() - start)})`;
    };
    // prefers-reduced-motion：不做逐帧动画，改 1s 低频推进（完全静止会像卡死）
    if (prefersReducedMotion()) {
      draw();
      const tick = window.setInterval(draw, 1000);
      return () => window.clearInterval(tick);
    }
    let frame = 0;
    const loop = () => {
      draw();
      frame = requestAnimationFrame(loop);
    };
    loop();
    return () => cancelAnimationFrame(frame);
  }, [stage, active]);
  if (!active) return null;
  return <div className="processing-progress" role="status" aria-label={stage === "transcribing" ? "正在识别，进度为等待动画" : "正在整理，进度为等待动画"}>
    <span className="processing-stage">{stage === "transcribing" ? "识别中" : "整理中"}</span>
    <div className="processing-track" aria-hidden="true"><span ref={bar} style={{ transform: `scaleX(${estimatedProgress(stage, 0)})` }} /></div>
  </div>;
}
