//! Pure geometry: screen-centred horizontally, above the usable desktop bottom.
#[derive(Clone, Copy)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

pub fn bottom_center(screen: Rect, work: Rect, width: u32, height: u32, gap: u32) -> (i32, i32) {
    let left = i64::from(work.x);
    let top = i64::from(work.y);
    let max_x = left + i64::from(work.width.saturating_sub(width));
    let max_y = top + i64::from(work.height.saturating_sub(height));
    let x =
        (i64::from(screen.x) + (i64::from(screen.width) - i64::from(width)) / 2).clamp(left, max_x);
    let y = (max_y - i64::from(gap)).clamp(top, max_y);
    (
        x.clamp(i32::MIN as i64, i32::MAX as i64) as i32,
        y.clamp(i32::MIN as i64, i32::MAX as i64) as i32,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn copy_card_is_centred_with_gap_above_taskbar() {
        let screen = Rect {
            x: 0,
            y: 0,
            width: 1920,
            height: 1080,
        };
        let work = Rect {
            height: 1040,
            ..screen
        };
        assert_eq!(bottom_center(screen, work, 342, 222, 48), (789, 770));
        let work = Rect {
            x: 80,
            width: 1840,
            ..work
        };
        // A side Dock must not shift the card away from the full screen centre.
        assert_eq!(bottom_center(screen, work, 342, 222, 48).0, 789);
    }
    #[test]
    fn negative_origin_retina_and_non_integer_scale_remain_in_work_area() {
        for scale in [1.0, 1.25, 2.0] {
            let px = |value: f64| (value * scale).round() as u32;
            let screen = Rect {
                x: -2560,
                y: -400,
                width: px(1800.0),
                height: px(1169.0),
            };
            let work = Rect {
                y: screen.y + px(39.0) as i32,
                height: px(1032.0),
                ..screen
            };
            let (x, y) = bottom_center(screen, work, px(342.0), px(222.0), px(48.0));
            assert_eq!(x, screen.x + ((screen.width - px(342.0)) / 2) as i32);
            assert_eq!(
                y + px(222.0) as i32 + px(48.0) as i32,
                work.y + work.height as i32
            );
        }
    }
    #[test]
    fn undersized_work_area_never_produces_negative_clamp_range() {
        let rect = Rect {
            x: -100,
            y: 70,
            width: 50,
            height: 20,
        };
        assert_eq!(bottom_center(rect, rect, 342, 222, 48), (-100, 70));
    }
}
