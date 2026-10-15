import { memo, useEffect, useRef } from "react";
import type { CSSProperties } from "react";
import { levelBus } from "../lib/levelBus";

const BAR_BASE = 22; // 与 CapsuleStage 录音胶囊波形同一基准：scaleY = (3 + level * amp) / 22
const MIN_SCALE = 3 / BAR_BASE;

function barScale(level: number, index: number, barCount: number) {
  const center = (barCount - 1) / 2;
  const amp = 3 + Math.max(.05, level) * (7 + (center - Math.abs(index - center)) * 2);
  return amp / BAR_BASE;
}

// 录音电平波形：React 只渲染固定高度的 <i>，挂载后 style 不再经 React 更新；
// 电平经 levelBus 在 rAF 中直写 scaleY（纯合成，无 layout），静音数帧后暂停循环、
// 电平恢复时重启。StrictMode 双挂载仅多一个订阅，cleanup 正确即无害。
export const Waveform = memo(function Waveform({ barCount, className, initialLevel = 0, label }: { barCount: number; className?: string; initialLevel?: number; label?: string }) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const bars = Array.from(root.children) as HTMLElement[];
    let raf = 0;
    let idleFrames = 0;
    let running = false;
    const frame = () => {
      const level = levelBus.get();
      for (let index = 0; index < bars.length; index += 1) bars[index].style.transform = `scaleY(${barScale(level, index, barCount)})`;
      if (level < .02 && idleFrames > 12) {
        running = false;
        return;
      }
      idleFrames = level < .02 ? idleFrames + 1 : 0;
      raf = requestAnimationFrame(frame);
    };
    const start = () => {
      if (running) return;
      running = true;
      idleFrames = 0;
      raf = requestAnimationFrame(frame);
    };
    const unsubscribe = levelBus.subscribe((level) => {
      if (level >= .02) start();
    });
    start();
    return () => {
      unsubscribe();
      cancelAnimationFrame(raf);
    };
  }, [barCount]);
  return <div ref={rootRef} className={className} aria-label={label}>
    {Array.from({ length: barCount }, (_, index) => {
      const safe = Number.isFinite(initialLevel) ? Math.max(0, Math.min(1, initialLevel)) : 0;
      return <i key={index} style={{ height: BAR_BASE + "px", transform: `scaleY(${barScale(safe, index, barCount).toFixed(3)})`, "--bar-i": index } as CSSProperties} />;
    })}
  </div>;
});
