#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod asr;
mod capture;
mod cloud_asr;
mod config;
mod context_tools;
mod input_target;
mod llm;
mod models;
mod overlay;
mod overlay_layout;
mod platform;
mod recorder;
mod selection;
mod storage;
#[cfg(test)]
mod test_support;

use reqwest::Client;
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex},
};
use tauri::{
    menu::{MenuBuilder, MenuItemBuilder},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager, WindowEvent,
};
use whisper_rs::WhisperContext;

pub struct AppState {
    pub http_client: Client,
    pub whisper_contexts: Arc<Mutex<HashMap<PathBuf, Arc<WhisperContext>>>>,
    pub whisper_execution_lock: Arc<Mutex<()>>,
    pub overlay_monitor: Mutex<Option<tauri::Monitor>>,
}

impl AppState {
    fn new() -> Result<Self, String> {
        Ok(Self {
            http_client: build_http_client()?,
            whisper_contexts: Arc::new(Mutex::new(HashMap::new())),
            whisper_execution_lock: Arc::new(Mutex::new(())),
            overlay_monitor: Mutex::new(None),
        })
    }
}

fn build_http_client() -> Result<Client, String> {
    Client::builder()
        .connect_timeout(std::time::Duration::from_secs(15))
        .pool_idle_timeout(std::time::Duration::from_secs(90))
        .build()
        .map_err(|error| format!("初始化网络客户端失败：{error}"))
}

fn main() {
    tauri::Builder::default()
        .manage(AppState::new().expect("初始化 U-Words 运行状态失败"))
        .manage(context_tools::ToolsState::default())
        .manage(recorder::RecorderState::default())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .setup(|app| {
            app.manage(storage::Store::open(app.handle()).map_err(std::io::Error::other)?);
            let show = MenuItemBuilder::with_id("show", "打开 U-Words").build(app)?;
            let quit = MenuItemBuilder::with_id("quit", "退出 U-Words").build(app)?;
            let menu = MenuBuilder::new(app).items(&[&show, &quit]).build()?;
            let icon = app.default_window_icon().cloned().ok_or_else(|| {
                std::io::Error::new(std::io::ErrorKind::NotFound, "应用图标不存在")
            })?;
            let _tray = TrayIconBuilder::with_id("main")
                .icon(icon)
                .tooltip("U-Words · 本地语音输入")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "show" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        if let Some(window) = tray.app_handle().get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                })
                .build(app)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            storage::storage_read,
            storage::storage_write,
            selection::read_selection,
            context_tools::tools_session,
            context_tools::tools_open,
            context_tools::tools_apply_selection,
            context_tools::tools_close,
            context_tools::tools_run,
            context_tools::tools_replace,
            context_tools::tools_set_source,
            context_tools::tools_show_menu,
            context_tools::tools_hide_menu,
            capture::capture_region,
            capture::attach_image,
            capture::export_image,
            recorder::recording_devices,
            recorder::recording_start,
            recorder::recording_stop,
            recorder::transcribe_recording,
            recorder::cancel_processing,
            config::get_config,
            config::save_config,
            config::get_api_key_status,
            config::save_api_key,
            config::get_asr_token_status,
            config::save_asr_token,
            models::get_model_status,
            models::download_model,
            asr::transcribe,
            llm::render,
            llm::review_plan,
            platform::get_input_target,
            platform::copy_text,
            platform::paste_text,
            platform::get_selected_text,
            platform::get_active_app,
            platform::get_accessibility_status,
            platform::open_accessibility_settings,
            platform::set_launch_at_login,
            overlay::show_overlay,
            overlay::hide_overlay,
            overlay::resize_overlay,
            overlay::hide_window
        ])
        .on_window_event(|window, event| {
            if window.label() == "result" {
                if let WindowEvent::Focused(focused) = event {
                    let _ = window.app_handle().emit_to(
                        "main",
                        "tools-escape",
                        if *focused { "result" } else { "" },
                    );
                }
            }
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                if window.label() == "result" {
                    let app = window.app_handle().clone();
                    let _ = context_tools::tools_close(
                        app.clone(),
                        app.state::<context_tools::ToolsState>(),
                    );
                }
                let _ = window.hide();
            }
        })
        .run(tauri::generate_context!())
        .expect("U-Words 运行失败");
}
