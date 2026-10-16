//! 弹簧/缓动纯函数：src/lib/spring.ts 的逐字平移（半隐式欧拉、dt 钳制、收敛判定、
//! cancel = 移除且不触发完成回调的语义由引擎层保证）。全平台编译，独立于 macOS 绑定可单测。

/// 对齐 spring.ts 的 SPRING_POP（轻过冲，出场/展开）
pub const SPRING_POP: SpringConfig = SpringConfig {
    stiffness: 260.0,
    damping: 22.0,
    precision: 0.001,
};

/// 对齐 spring.ts 的 SPRING_SETTLE（无过冲，收缩/退场）
pub const SPRING_SETTLE: SpringConfig = SpringConfig {
    stiffness: 320.0,
    damping: 32.0,
    precision: 0.001,
};

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SpringConfig {
    pub stiffness: f64,
    pub damping: f64,
    pub precision: f64,
}

#[derive(Clone, Copy, Debug)]
pub struct Spring {
    pub value: f64,
    pub velocity: f64,
    pub target: f64,
    pub config: SpringConfig,
}

impl Spring {
    pub fn new(from: f64, to: f64, config: SpringConfig) -> Self {
        Self {
            value: from,
            velocity: 0.0,
            target: to,
            config,
        }
    }

    /// 半隐式欧拉一步（先速度后位置，同 spring.ts:43-46）。
    /// 收敛（|位移| 与 |速度| 均小于 precision）时吸附到目标值并返回 true。
    pub fn step(&mut self, dt: f64) -> bool {
        let displacement = self.value - self.target;
        let acceleration = -self.config.stiffness * displacement - self.config.damping * self.velocity;
        self.velocity += acceleration * dt;
        self.value += self.velocity * dt;
        let displacement = self.value - self.target;
        if displacement.abs() < self.config.precision && self.velocity.abs() < self.config.precision {
            self.value = self.target;
            self.velocity = 0.0;
            true
        } else {
            false
        }
    }
}

/// 对齐 spring.ts:41：窗口隐藏/后台回来时防一帧巨步。
pub fn clamp_dt(raw: f64) -> f64 {
    raw.clamp(0.0, 0.032)
}

/// CSS `ease` = cubic-bezier(.25, .1, .25, 1)，供 bar 逐根沉降 tween 用（二分逼近足够精确）。
pub fn css_ease(t: f64) -> f64 {
    if t <= 0.0 {
        return 0.0;
    }
    if t >= 1.0 {
        return 1.0;
    }
    // x(t) = 3(1-t)²t·x1 + 3(1-t)t²·x2 + t³，x1=.25 x2=.25；对给定 x 反解 t 后代入 y（y1=.1 y2=1）
    let (x1, y1, x2, y2) = (0.25_f64, 0.1_f64, 0.25_f64, 1.0_f64);
    let bezier = |t: f64, p1: f64, p2: f64| 3.0 * (1.0 - t).powi(2) * t * p1 + 3.0 * (1.0 - t) * t.powi(2) * p2 + t.powi(3);
    // x(t) 单调递增：二分 32 次达 ~1e-10 精度
    let mut low = 0.0_f64;
    let mut high = 1.0_f64;
    for _ in 0..32 {
        let mid = (low + high) / 2.0;
        if bezier(mid, x1, x2) < t {
            low = mid;
        } else {
            high = mid;
        }
    }
    let time = (low + high) / 2.0;
    bezier(time, y1, y2)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn simulate(from: f64, to: f64, config: SpringConfig) -> (Vec<f64>, bool) {
        let mut spring = Spring::new(from, to, config);
        let mut values = vec![spring.value];
        let dt = 1.0 / 60.0;
        let mut settled = false;
        for _ in 0..600 {
            if spring.step(dt) {
                settled = true;
                break;
            }
            values.push(spring.value);
        }
        (values, settled)
    }

    #[test]
    fn spring_overshoots_once_before_converging_with_pop_config() {
        let (values, settled) = simulate(0.0, 1.0, SPRING_POP);
        assert!(settled, "POP 弹簧必须在有限帧内收敛");
        let peak = values.iter().cloned().fold(f64::MIN, f64::max);
        assert!(peak > 1.0, "POP 弹簧应有轻过冲（峰值 {peak}）");
        assert!(peak < 1.1, "过冲应轻微（峰值 {peak}）");
        // 过冲后回落到目标：末段不偏离目标
        assert!((values[values.len() - 1] - 1.0).abs() < 0.01);
    }

    #[test]
    fn spring_settle_config_never_overshoots() {
        let (values, settled) = simulate(1.0, 0.0, SPRING_SETTLE);
        assert!(settled, "SETTLE 弹簧必须在有限帧内收敛");
        // 从 1 到 0 单调不越过 0
        assert!(
            values.iter().all(|value| *value >= 0.0),
            "SETTLE 弹簧不得过冲到负值"
        );
    }

    #[test]
    fn spring_converges_within_precision_and_snaps_to_target() {
        let mut spring = Spring::new(0.0, 1.0, SPRING_POP);
        let mut converged = false;
        for _ in 0..600 {
            if spring.step(1.0 / 60.0) {
                converged = true;
                break;
            }
        }
        assert!(converged);
        assert_eq!(spring.value, 1.0, "收敛时必须吸附到目标值");
        assert_eq!(spring.velocity, 0.0);
    }

    #[test]
    fn spring_step_clamps_dt_above_32ms() {
        // 传入 1s 的巨步：单步位移必须等于按 32ms 钳制后的解析结果
        let mut clamped = Spring::new(0.0, 1.0, SPRING_POP);
        clamped.step(clamp_dt(1.0));
        let mut manual = Spring::new(0.0, 1.0, SPRING_POP);
        manual.step(0.032);
        assert_eq!(clamped.value, manual.value);
        assert_eq!(clamped.velocity, manual.velocity);
    }

    #[test]
    fn spring_restart_from_current_value_matches_interrupted_retarget_semantics() {
        // 中断重定向语义：从当前值、velocity=0 重新起弹簧（引擎用 Spring::new(current, target) 实现）
        let mut spring = Spring::new(0.0, 1.0, SPRING_POP);
        for _ in 0..10 {
            spring.step(1.0 / 60.0);
        }
        let current = spring.value;
        let restarted = Spring::new(current, 0.5, SPRING_POP);
        assert_eq!(restarted.value, current, "从中断点的当前值继续");
        assert_eq!(restarted.velocity, 0.0, "重定向清零速度（对齐前端语义）");
        assert_eq!(restarted.target, 0.5);
    }

    #[test]
    fn css_ease_matches_endpoints_and_midpoint() {
        assert_eq!(css_ease(0.0), 0.0);
        assert_eq!(css_ease(1.0), 1.0);
        assert_eq!(css_ease(-1.0), 0.0);
        assert_eq!(css_ease(2.0), 1.0);
        let mid = css_ease(0.5);
        assert!(mid > 0.5, "ease 前半程更快（0.5 处进度 {mid}）");
        assert!(mid < 0.85);
    }
}
