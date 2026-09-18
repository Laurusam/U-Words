use crate::config::app_data_dir;
use crate::context_tools::{self, Session, ToolsState};
use arboard::Clipboard;
use base64::{engine::general_purpose::STANDARD, Engine};
use image::ImageEncoder;
use std::fs;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

struct CaptureRestore {
    app: AppHandle,
    previous: Option<Session>,
    main_visible: bool,
    completed: bool,
}
impl Drop for CaptureRestore {
    fn drop(&mut self) {
        if self.main_visible { if let Some(w)=self.app.get_webview_window("main"){let _=w.show();} }
        if !self.completed {
            if let Some(previous)=self.previous.take(){
                if let Ok(mut guard)=self.app.state::<ToolsState>().session.lock(){
                    // Never resurrect a session explicitly closed during capture.
                    if guard.as_ref().map(|s|s.id.as_str())==Some(previous.id.as_str()){
                        *guard=Some(previous.clone());
                        let _=self.app.emit_to("result","tools-session",&previous);
                        if let Some(w)=self.app.get_webview_window("result"){let _=w.show();}
                    }
                }
            }
        }
    }
}

fn normalize(bytes: &[u8]) -> Result<String, String> {
    if bytes.len() > 16_000_000 {
        return Err("图片超过 16MB，请缩小截图区域".into());
    }
    let mut reader = image::ImageReader::new(std::io::Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|_| "无法识别图片格式")?;
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(16_384);
    limits.max_image_height = Some(16_384);
    limits.max_alloc = Some(256_000_000);
    reader.limits(limits);
    let img = reader.decode().map_err(|_| "图片无法解码或尺寸过大")?;
    let img = if img.width() > 3072 || img.height() > 3072 {
        img.resize(3072, 3072, image::imageops::FilterType::Lanczos3)
    } else {
        img
    };
    let mut png = vec![];
    img.write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
        .map_err(|error| error.to_string())?;
    if png.len() > 12_000_000 {
        return Err("处理后的图片仍过大，请缩小区域".into());
    }
    Ok(format!("data:image/png;base64,{}", STANDARD.encode(png)))
}

fn capture_failure(app: &AppHandle, id: &str, message: &str) {
    if let Ok(mut guard) = app.state::<ToolsState>().session.lock() {
        if let Some(session) = guard.as_mut().filter(|s| s.id == id) {
            session.error = Some(message.into());
            let _ = app.emit_to("result", "tools-session", &*session);
            if let Some(window) = app.get_webview_window("result") {
                let _ = window.show();
            }
        }
    }
}

// 截图进程连启动都失败时，结果窗口也必须看到原因，而不是只把错误抛给调用方。
fn capture_spawn_failure(app: &AppHandle, id: &str, error: &std::io::Error) -> String {
    let message = format!("截图程序启动失败：{error}");
    capture_failure(app, id, &message);
    message
}

#[tauri::command]
pub async fn capture_region(app: AppHandle, action: Option<String>) -> Result<Session, String> {
    let action = action
        .filter(|action| action == "ocr")
        .unwrap_or_else(|| "image".into());
    let previous=app.state::<ToolsState>().session.lock().map_err(|_|"会话繁忙")?.clone()
        .filter(|s|!s.busy&&s.image.is_some());
    let mut restore=CaptureRestore{app:app.clone(),previous:previous.clone(),main_visible:app.get_webview_window("main").and_then(|w|w.is_visible().ok()).unwrap_or(false),completed:false};
    // Re-capture is transactional: keep the old image until a replacement is ready.
    let session = if let Some(previous)=previous {previous} else {context_tools::open_result(
        &app,
        &action,
        None,
        String::new(),
        String::new(),
        None,
    )?};
    for label in ["main", "radial", "selectionbar", "result", "overlay"] {
        if let Some(window) = app.get_webview_window(label) {
            let _ = window.hide();
        }
    }
    tokio::time::sleep(Duration::from_millis(180)).await;
    let dir = app_data_dir(&app)?.join("captures");
    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    let path = dir.join(format!("{}.png", uuid::Uuid::new_v4()));
    #[cfg(target_os = "macos")]
    let status = match tokio::process::Command::new("/usr/sbin/screencapture")
        .args(["-i", "-x", "-t", "png"])
        .arg(&path)
        .kill_on_drop(true)
        .status()
        .await
    {
        Ok(status) => status,
        Err(error) => return Err(capture_spawn_failure(&app, &session.id, &error)),
    };
    #[cfg(target_os = "windows")]
    let status = {
        let script = include_str!("capture_windows.ps1");
        let encoded = STANDARD.encode(
            script
                .encode_utf16()
                .flat_map(u16::to_le_bytes)
                .collect::<Vec<_>>(),
        );
        match tokio::process::Command::new("powershell.exe")
            .args(["-NoProfile", "-STA", "-EncodedCommand", &encoded])
            .env("UWORDS_CAPTURE_PATH", &path)
            .kill_on_drop(true)
            .creation_flags(0x08000000)
            .status()
            .await
        {
            Ok(status) => status,
            Err(error) => return Err(capture_spawn_failure(&app, &session.id, &error)),
        }
    };
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    return Err("当前平台未实现截图".into());
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    {
        if !status.success() || !path.is_file() {
            let _ = fs::remove_file(&path);
            let message = "截图已取消或未获得屏幕录制权限；请在系统设置 → 隐私与安全性 → 屏幕录制中授权，也可直接粘贴图片或选择文件";
            capture_failure(&app, &session.id, message);
            return Err(message.into());
        }
        let bytes = fs::read(&path).map_err(|error| error.to_string());
        let _ = fs::remove_file(&path);
        let data = match bytes.and_then(|bytes| normalize(&bytes)) {
            Ok(data) => data,
            Err(error) => {
                capture_failure(&app, &session.id, &error);
                return Err(error);
            }
        };
        let state = app.state::<ToolsState>();
        let result = {
            let mut guard = state.session.lock().map_err(|_| "会话繁忙")?;
            let s = guard
                .as_mut()
                .filter(|s| s.id == session.id)
                .ok_or("截图会话已取消")?;
            s.image = Some(data);
            s.messages.clear();s.result.clear();s.error=None;
            s.clone()
        };
        let _ = app.emit_to("result", "tools-session", &result);
        if let Some(window) = app.get_webview_window("result") {
            let _ = context_tools::position(&app, &window, 460., 480., None);
            let _ = window.show();
        }
        restore.completed=true;
        Ok(result)
    }
}

#[tauri::command]
pub fn attach_image(app: AppHandle, id: String, data: Option<String>) -> Result<Session, String> {
    let encoded = if let Some(data) = data {
        if data.len() > 24_000_000 {
            return Err("图片过大".into());
        }
        let (_, body) = data.split_once(",").ok_or("图片数据无效")?;
        normalize(&STANDARD.decode(body).map_err(|_| "图片数据无效")?)?
    } else {
        let mut clipboard = Clipboard::new().map_err(|_| "无法访问剪贴板")?;
        let img = clipboard.get_image().map_err(|_| "剪贴板中没有图片")?;
        if img.width > 16384 || img.height > 16384 {
            return Err("图片尺寸过大".into());
        }
        let mut png = vec![];
        image::codecs::png::PngEncoder::new(&mut png)
            .write_image(
                &img.bytes,
                img.width as u32,
                img.height as u32,
                image::ExtendedColorType::Rgba8,
            )
            .map_err(|error| error.to_string())?;
        normalize(&png)?
    };
    let state = app.state::<ToolsState>();
    let mut guard = state.session.lock().map_err(|_| "会话繁忙")?;
    let session = guard
        .as_mut()
        .filter(|session| session.id == id && !session.busy)
        .ok_or("会话已关闭或正在处理")?;
    session.image = Some(encoded);
    if session.action != "ocr" {
        session.action = "image".into();
    }
    session.messages.clear();
    session.result.clear();
    let result = session.clone();
    let _ = app.emit_to("result", "tools-session", &result);
    Ok(result)
}

#[tauri::command]
pub fn export_image(app: AppHandle, id: String, copy: bool) -> Result<String, String> {
    let state = app.state::<ToolsState>();
    let data = state
        .session
        .lock()
        .map_err(|_| "会话繁忙")?
        .as_ref()
        .filter(|session| session.id == id)
        .and_then(|session| session.image.clone())
        .ok_or("没有图片")?;
    let bytes = STANDARD
        .decode(data.split_once(',').ok_or("图片无效")?.1)
        .map_err(|_| "图片无效")?;
    if copy {
        let img = image::load_from_memory(&bytes)
            .map_err(|error| error.to_string())?
            .into_rgba8();
        Clipboard::new()
            .map_err(|error| error.to_string())?
            .set_image(arboard::ImageData {
                width: img.width() as usize,
                height: img.height() as usize,
                bytes: std::borrow::Cow::Owned(img.into_raw()),
            })
            .map_err(|error| error.to_string())?;
        Ok("已复制".into())
    } else {
        let path = dirs::download_dir()
            .ok_or("找不到下载目录")?
            .join(format!("U-Words-{}.png", uuid::Uuid::new_v4()));
        fs::write(&path, bytes).map_err(|error| error.to_string())?;
        Ok(path.to_string_lossy().into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reject_invalid_image() {
        assert!(normalize(b"not an image").is_err());
    }
}
