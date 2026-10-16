//! 浮窗壳几何与波形 bar 布局纯函数。数值来源 CapsuleStage.tsx:13-27（GEOMETRIES）、
//! Waveform.tsx:5-12（barScale）与 styles.css 浮窗段，与前端契约一一对应（scripts/test-scenes.mjs
//! 之外的几何契约由本模块测试锁定）。全平台编译，独立于 macOS 绑定可单测。

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ShellGeom {
    pub width: f64,
    pub height: f64,
    pub radius: f64,
}

/// 对齐 CapsuleStage SHELL_CAPSULE：录音胶囊 F1/F2
pub const GEOM_CAPSULE: ShellGeom = ShellGeom { width: 164.0, height: 40.0, radius: 999.0 };
/// 对齐 SHELL_CARD：F3/F5 卡片
pub const GEOM_CARD: ShellGeom = ShellGeom { width: 340.0, height: 220.0, radius: 16.0 };
/// 对齐 SHELL_CARD_EXPANDED：F3 ⌄ 展开原文对照
pub const GEOM_CARD_EXPANDED: ShellGeom = ShellGeom { width: 340.0, height: 320.0, radius: 16.0 };
/// 对齐 SHELL_CARD_IMAGE：F4 图片解析窗
pub const GEOM_CARD_IMAGE: ShellGeom = ShellGeom { width: 360.0, height: 430.0, radius: 16.0 };

/// 窗口尺寸 → 壳几何。四档按窗口尺寸直接识别（卡片窗口 = 壳 + 2px 抗锯齿余量；
/// 胶囊窗口高度还含底部标签带：166×66 = 壳 164×40 + 标签带 + 余量）。
/// 未知尺寸退化为“壳 = 窗 - 2px、卡片圆角”，与前端 applyGeom 的宽容行为对齐。
pub fn shell_for_window(window_width: f64, window_height: f64) -> ShellGeom {
    match (window_width.round(), window_height.round()) {
        (166.0, 66.0) => GEOM_CAPSULE,
        (342.0, 222.0) => GEOM_CARD,
        (342.0, 322.0) => GEOM_CARD_EXPANDED,
        (362.0, 432.0) => GEOM_CARD_IMAGE,
        _ => ShellGeom {
            width: window_width - 2.0,
            height: window_height - 2.0,
            radius: GEOM_CARD.radius,
        },
    }
}

pub const BAR_COUNT: usize = 13;
/// 对齐 Waveform.tsx BAR_BASE：scaleY = amp / 22
pub const BAR_BASE: f64 = 22.0;
/// 对齐 styles.css：bar 宽 2px、间距 2px → 相邻中心距 4pt
pub const BAR_WIDTH: f64 = 2.0;
pub const BAR_PITCH: f64 = 4.0;

/// 对齐 Waveform.tsx:8-12：amp = 3 + max(.05, level) * (7 + (center-|i-center|)*2)，scaleY = amp/22
pub fn bar_scale(level: f64, index: usize, bar_count: usize) -> f64 {
    let center = (bar_count - 1) as f64 / 2.0;
    let amp = 3.0 + level.max(0.05) * (7.0 + (center - (index as f64 - center).abs()) * 2.0);
    amp / BAR_BASE
}

/// 第 index 根 bar 的中心 x（相对壳左缘，点坐标）；13 根总宽 50，横向居中
pub fn bar_center_x(index: usize, bar_count: usize, shell_width: f64) -> f64 {
    let center = (bar_count - 1) as f64 / 2.0;
    shell_width / 2.0 + (index as f64 - center) * BAR_PITCH
}

/// bar 中心 y（相对壳左缘下角，点坐标）：录音 face 的波形槽在壳内垂直居中
pub fn bar_center_y(shell_height: f64) -> f64 {
    shell_height / 2.0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn geometry_table_maps_window_sizes_to_shell_geoms() {
        assert_eq!(shell_for_window(166.0, 66.0), GEOM_CAPSULE);
        assert_eq!(shell_for_window(342.0, 222.0), GEOM_CARD);
        assert_eq!(shell_for_window(342.0, 322.0), GEOM_CARD_EXPANDED);
        assert_eq!(shell_for_window(362.0, 432.0), GEOM_CARD_IMAGE);
        // 未知尺寸：壳 = 窗 - 2px、卡片圆角
        assert_eq!(
            shell_for_window(400.0, 300.0),
            ShellGeom { width: 398.0, height: 298.0, radius: 16.0 }
        );
    }

    #[test]
    fn bar_scale_matches_waveform_reference_values() {
        // scripts/test-waveform.mjs 同源参考值：level .7 → 边缘 7.9/22、中心 16.3/22
        assert!((bar_scale(0.7, 0, 13) - 7.9 / 22.0).abs() < 1e-12);
        assert!((bar_scale(0.7, 6, 13) - 16.3 / 22.0).abs() < 1e-12);
        // 静音下限：max(.05, 0) → 边缘 3.35/22
        assert!((bar_scale(0.0, 0, 13) - 3.35 / 22.0).abs() < 1e-12);
    }

    #[test]
    fn bar_layout_centers_thirteen_bars_with_two_point_pitch() {
        // 13 根 × 2px + 12 间隙 × 2px = 50，居中于 164 宽的壳
        assert!((bar_center_x(0, 13, 164.0) - 58.0).abs() < 1e-12);
        assert!((bar_center_x(6, 13, 164.0) - 82.0).abs() < 1e-12);
        assert!((bar_center_x(12, 13, 164.0) - 106.0).abs() < 1e-12);
        assert!((bar_center_y(40.0) - 20.0).abs() < 1e-12);
    }
}
