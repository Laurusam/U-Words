use crate::overlay_layout;
use crate::AppState;
use tauri::{AppHandle, Manager, Runtime, State, WebviewWindow};

fn position_overlay<R: Runtime>(
    window: &WebviewWindow<R>,
    monitor: &tauri::Monitor,
    expanded: bool,
) -> Result<(), String> {
    let work_area = monitor.work_area();
    let size = tauri::LogicalSize::new(
        if expanded { 342.0 } else { 166.0 },
        if expanded { 222.0 } else { 66.0 },
    );
    let physical: tauri::PhysicalSize<u32> = size.to_physical(monitor.scale_factor());
    let gap = ((if expanded { 48.0 } else { 24.0 }) * monitor.scale_factor()).round() as u32;
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
    position_overlay(&window, &monitor, expanded)?;
    window
        .show()
        .map_err(|error| format!("显示悬浮窗失败：{error}"))
}

#[tauri::command]
pub fn hide_overlay(app: AppHandle) -> Result<(), String> {
    app.get_webview_window("overlay")
        .ok_or_else(|| "悬浮窗不存在".to_string())?
        .hide()
        .map_err(|error| format!("隐藏悬浮窗失败：{error}"))
}

#[tauri::command]
pub fn hide_window(app: AppHandle) -> Result<(), String> {
    app.get_webview_window("main")
        .ok_or_else(|| "主窗口不存在".to_string())?
        .hide()
        .map_err(|error| format!("隐藏窗口失败：{error}"))
}
