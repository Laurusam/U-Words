use crate::overlay_layout;
use crate::AppState;
use tauri::{AppHandle, Manager, Runtime, State, WebviewWindow};

fn position_overlay<R: Runtime>(
    window: &WebviewWindow<R>,
    monitor: &tauri::Monitor,
    expanded: bool,
) -> Result<(), String> {
    position_overlay_sized(
        window,
        monitor,
        if expanded { 342.0 } else { 166.0 },
        if expanded { 222.0 } else { 66.0 },
        if expanded { 48.0 } else { 24.0 },
    )
}

/// bottom-center 定位 + set_size 一步到位；胶囊形态切换（F1/F2 → 文本/图片卡）共用。
fn position_overlay_sized<R: Runtime>(
    window: &WebviewWindow<R>,
    monitor: &tauri::Monitor,
    width: f64,
    height: f64,
    gap_points: f64,
) -> Result<(), String> {
    let work_area = monitor.work_area();
    let size = tauri::LogicalSize::new(width, height);
    let physical: tauri::PhysicalSize<u32> = size.to_physical(monitor.scale_factor());
    let gap = (gap_points * monitor.scale_factor()).round() as u32;
    let (x, y) = overlay_layout::bottom_center(
        overlay_layout::Rect {
            x: monitor.position().x,
            y: monitor.position().y,
            width: monitor.size().width,
            height: monitor.size().height,
        },
        overlay_layout::Rect {
            x: work_area.position.x,
            y: work_area.position.y,
            width: work_area.size.width,
            height: work_area.size.height,
        },
        physical.width,
        physical.height,
        gap,
    );
    // macOS global positions use screen points. Dividing by the target scale avoids
    // conversion with the old window scale while moving between mixed-DPI screens.
    #[cfg(target_os = "macos")]
    let position = tauri::LogicalPosition::new(
        x as f64 / monitor.scale_factor(),
        y as f64 / monitor.scale_factor(),
    );
    #[cfg(not(target_os = "macos"))]
    let position = tauri::PhysicalPosition::new(x, y);
    window
        .set_position(position)
        .map_err(|error| format!("定位悬浮窗失败：{error}"))?;
    window
        .set_size(size)
        .map_err(|error| format!("调整浮窗尺寸失败：{error}"))
}

#[tauri::command]
pub fn show_overlay(
    app: AppHandle,
    state: State<'_, AppState>,
    expanded: Option<bool>,
    width: Option<f64>,
    height: Option<f64>,
) -> Result<(), String> {
    let window = app
        .get_webview_window("overlay")
        .ok_or_else(|| "悬浮窗不存在".to_string())?;
    let expanded = expanded.unwrap_or(false);
    let primary = app
        .primary_monitor()
        .map_err(|error| format!("读取显示器失败：{error}"))?;
    let monitors = app
        .available_monitors()
        .map_err(|error| format!("读取显示器失败：{error}"))?;
    let mut anchor = state
        .overlay_monitor
        .lock()
        .map_err(|_| "浮窗屏幕状态不可用".to_string())?;
    // Retain the recording screen when the small capsule expands into a copy card.
    let retained = (expanded && window.is_visible().unwrap_or(false))
        .then(|| anchor.as_ref())
        .flatten()
        .and_then(|old| {
            monitors
                .iter()
                .find(|current| {
                    current.position() == old.position() && current.name() == old.name()
                })
                .cloned()
        });
    let current = app.cursor_position().ok().and_then(|cursor| {
        #[cfg(target_os = "macos")]
        let cursor = primary
            .as_ref()
            .map(|monitor| cursor.to_logical::<f64>(monitor.scale_factor()))?;
        app.monitor_from_point(cursor.x, cursor.y).ok().flatten()
    });
    let monitor = retained
        .or(current)
        .or(primary)
        .ok_or_else(|| "未检测到可用显示器".to_string())?;
    *anchor = Some(monitor.clone());
    drop(anchor);
    // 显式尺寸（F4 图片解析窗等自定义卡片）优先于两档预设形态
    let (effective_w, effective_h) = match (width, height) {
        (Some(w), Some(h)) => {
            position_overlay_sized(&window, &monitor, w, h, 24.0)?;
            (w, h)
        }
        _ => {
            let expanded_flag = expanded;
            position_overlay(&window, &monitor, expanded_flag)?;
            if expanded_flag { (342.0, 222.0) } else { (166.0, 66.0) }
        }
    };
    // 原生动效（路线 B）：同一闭包内保证“备层（opacity 0）→ show → 出场弹簧”的顺序，
    // 关闭时 effects 入口直接返回，行为与现状完全一致
    let effects_app = app.clone();
    let effects_window = window.clone();
    app.run_on_main_thread(move || {
        eprintln!("[effects-dbg] show_overlay 闭包执行（native={}）", effects_app.try_state::<crate::EffectsState>().map(|s| s.enabled.load(std::sync::atomic::Ordering::Relaxed)).unwrap_or(false));
        crate::effects::prepare_show_now(&effects_app, effective_w, effective_h);
        let _ = effects_window.show();
        crate::effects::begin_enter_now(&effects_app);
    })
    .map_err(|error| format!("显示悬浮窗失败：{error}"))
}

#[tauri::command]
pub fn hide_overlay(app: AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("overlay")
        .ok_or_else(|| "悬浮窗不存在".to_string())?;
    let effects_app = app.clone();
    let effects_window = window.clone();
    app.run_on_main_thread(move || {
        crate::effects::handle_hidden_now(&effects_app);
        let _ = effects_window.hide();
    })
    .map_err(|error| format!("隐藏悬浮窗失败：{error}"))
}

#[tauri::command]
pub fn hide_window(app: AppHandle) -> Result<(), String> {
    app.get_webview_window("main")
        .ok_or_else(|| "主窗口不存在".to_string())?
        .hide()
        .map_err(|error| format!("隐藏窗口失败：{error}"))
}

/// 胶囊形态切换时按新尺寸重排：沿用 stored anchor 所在屏幕，bottom-center 重定位 + set_size 一步到位。
/// 窗口尺寸立即到位，壳动画由前端 spring 接管（CapsuleStage）。
#[tauri::command]
pub fn resize_overlay(
    app: AppHandle,
    state: State<'_, AppState>,
    width: f64,
    height: f64,
) -> Result<(), String> {
    let window = app
        .get_webview_window("overlay")
        .ok_or_else(|| "悬浮窗不存在".to_string())?;
    let anchor = state
        .overlay_monitor
        .lock()
        .map_err(|_| "浮窗屏幕状态不可用".to_string())?;
    let monitor = match anchor.as_ref() {
        Some(current) => current.clone(),
        None => app
            .primary_monitor()
            .map_err(|error| format!("读取显示器失败：{error}"))?
            .ok_or_else(|| "未检测到可用显示器".to_string())?,
    };
    drop(anchor);
    position_overlay_sized(&window, &monitor, width, height, 24.0)?;
    // 窗口尺寸已到位：原生壳 w/h/radius 弹簧跟随（关闭时直接返回）
    let effects_app = app.clone();
    app.run_on_main_thread(move || {
        crate::effects::begin_morph_now(&effects_app, width, height);
    })
    .map_err(|error| format!("调整浮窗尺寸失败：{error}"))
}
