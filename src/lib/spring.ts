export type SpringConfig = { stiffness: number; damping: number; precision: number };

/** 轻过冲：出场/展开（380ms 级） */
export const SPRING_POP: SpringConfig = { stiffness: 260, damping: 22, precision: .001 };
/** 无过冲：收缩/退场（160-300ms 级） */
export const SPRING_SETTLE: SpringConfig = { stiffness: 320, damping: 32, precision: .001 };

export function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export type SpringHandle = { cancel: () => void };

/**
 * rAF 半隐式欧拉弹簧；中断后可从当前值/速度接续（重新调用并传入 value()/velocity 即可）。
 * prefers-reduced-motion 时不积分，直接置终值并触发完成回调。
 */
export function animateSpring(opts: {
  from: number;
  to: number;
  velocity?: number;
  config?: SpringConfig;
  onUpdate: (value: number) => void;
  onComplete?: () => void;
}): SpringHandle {
  const { from, to, onUpdate, onComplete } = opts;
  const { stiffness, damping, precision } = opts.config ?? SPRING_SETTLE;
  if (prefersReducedMotion()) {
    onUpdate(to);
    onComplete?.();
    return { cancel: () => undefined };
  }
  let value = from;
  let velocity = opts.velocity ?? 0;
  let raf = 0;
  let last = performance.now();
  let cancelled = false;
  const step = (now: number) => {
    if (cancelled) return;
    // dt 钳制：避免窗口隐藏/后台回来后的一帧巨步把弹簧打出数值噪音
    const dt = Math.min(.032, (now - last) / 1000);
    last = now;
    const displacement = value - to;
    const acceleration = -stiffness * displacement - damping * velocity;
    velocity += acceleration * dt;
    value += velocity * dt;
    if (Math.abs(displacement) < precision && Math.abs(velocity) < precision) {
      onUpdate(to);
      onComplete?.();
      return;
    }
    onUpdate(value);
    raf = requestAnimationFrame(step);
  };
  raf = requestAnimationFrame(step);
  return {
    cancel: () => {
      cancelled = true;
      cancelAnimationFrame(raf);
    },
  };
}
