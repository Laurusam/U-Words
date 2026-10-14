import { useEffect, useRef } from "react";
import { prefersReducedMotion } from "../lib/spring";

const PIECES = 10;
const IDLE_PERIOD_MS = 2600; // idle 慢扫一圈时长
const REVEAL_MS = 650; // 结果到达后的加速显现时长

/** F4 图片扫描呈现：10 条水平切片。等待结果时扫描线慢速循环（线前深暗、
 *  经过点亮、线后保持半亮）；文字到达后快速掠过点亮全图并停帧；
 *  减弱动态时直接完整显示。 */
export function ImageReveal({ image, revealed }: { image: string; revealed: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const revealedRef = useRef(revealed);
  const revealAtRef = useRef(0);
  revealedRef.current = revealed;
  useEffect(() => {
    if (revealed) {
      if (!revealAtRef.current) revealAtRef.current = performance.now();
    } else {
      revealAtRef.current = 0;
    }
  }, [revealed]);
  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    const reduced = prefersReducedMotion();
    const bitmap = new Image();
    let disposed = false;
    let raf = 0;
    const draw = (time: number) => {
      if (disposed) return;
      const { width, height } = canvas;
      context.clearRect(0, 0, width, height);
      if (!bitmap.complete || !bitmap.naturalWidth) {
        context.fillStyle = "rgba(128, 128, 128, 0.12)";
        context.fillRect(0, 0, width, height);
      } else {
        const scale = Math.min(width / bitmap.naturalWidth, height / bitmap.naturalHeight);
        const drawWidth = bitmap.naturalWidth * scale;
        const drawHeight = bitmap.naturalHeight * scale;
        const x = (width - drawWidth) / 2;
        const y = (height - drawHeight) / 2;
        context.drawImage(bitmap, x, y, drawWidth, drawHeight);
        const revealAt = revealAtRef.current;
        if (reduced || (revealAt && time - revealAt >= REVEAL_MS)) {
          return; // 显现完成：静态全图，停帧省电
        }
        const slice = drawHeight / PIECES;
        const drawVeil = (alphaOf: (distance: number) => number, head: number) => {
          for (let index = 0; index < PIECES; index += 1) {
            const top = y + index * slice;
            const alpha = alphaOf(head - (top + slice / 2));
            if (alpha > 0.004) {
              context.fillStyle = `rgba(10, 12, 16, ${alpha.toFixed(3)})`;
              context.fillRect(x, top, drawWidth, slice + 0.5);
            }
          }
          const glow = context.createLinearGradient(0, head - 14, 0, head + 14);
          glow.addColorStop(0, "rgba(140, 205, 255, 0)");
          glow.addColorStop(0.5, "rgba(140, 205, 255, 0.5)");
          glow.addColorStop(1, "rgba(140, 205, 255, 0)");
          context.fillStyle = glow;
          context.fillRect(x, head - 14, drawWidth, 28);
        };
        if (revealAt) {
          // 加速显现：暗幕随扫描线掠过褪去，线后完全清晰
          const progress = Math.min(1, (time - revealAt) / REVEAL_MS);
          const head = y + progress * (drawHeight + 60) - 30;
          drawVeil(distance => (distance >= 0 ? 0 : 0.82 * Math.min(1, -distance / 60)), head);
        } else {
          // idle 慢扫：线前深暗、经过点亮、线后保持半亮（已扫描的暗示）
          const head = y + ((time % IDLE_PERIOD_MS) / IDLE_PERIOD_MS) * (drawHeight + 120) - 60;
          drawVeil(distance => (distance < -24 ? 0.82 : distance < 8 ? 0.82 - ((distance + 24) / 32) * 0.5 : 0.32), head);
        }
      }
      raf = requestAnimationFrame(draw);
    };
    const start = () => {
      if (disposed || raf) return;
      raf = requestAnimationFrame(draw);
    };
    bitmap.onload = start;
    bitmap.src = image;
    // dataURL 命中同步解码路径时 onload 不再触发，这里兜底起帧
    if (bitmap.complete) start();
    return () => {
      disposed = true;
      if (raf) cancelAnimationFrame(raf);
    };
  }, [image]);
  return (
    <canvas
      ref={canvasRef}
      className="capsule-image-canvas"
      width={656}
      height={380}
      role="img"
      aria-label={revealed ? "截图与识别结果" : "正在扫描截图"}
    />
  );
}
