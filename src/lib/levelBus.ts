type Listener = (level: number) => void;

// 录音电平高频通道：采集回调每 tick 写入，波形组件 rAF 直读；
// React state 只通过 App.tsx 的节流桥低频同步（仅喂 overlayState 序列化）。
let current = 0;
const listeners = new Set<Listener>();

export const levelBus = {
  set(v: number) {
    current = Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0;
    for (const fn of listeners) fn(current);
  },
  get: () => current,
  subscribe(fn: Listener) {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  },
};
