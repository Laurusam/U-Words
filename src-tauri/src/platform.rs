use crate::config::APP_ID;
use crate::input_target;
use arboard::Clipboard;
use enigo::{
    Direction::{Click, Press, Release},
    Enigo, Key, Keyboard, Settings,
};
use std::{fs, process::Command, thread, time::Duration};

#[cfg(target_os = "macos")]
#[link(name = "ApplicationServices", kind = "framework")]
unsafe extern "C" {
    fn AXIsProcessTrusted() -> u8;
}

#[cfg(target_os = "macos")]
fn accessibility_is_trusted() -> bool {
    // This is a non-prompting check. A failed check must not itself create a
    // macOS permission dialog every time a shortcut is simulated.
    unsafe { AXIsProcessTrusted() != 0 }
}

#[cfg(not(target_os = "macos"))]
fn accessibility_is_trusted() -> bool {
    true
}

fn accessibility_required_error() -> String {
    "尚未获得 macOS 辅助功能权限。请在“系统设置 → 隐私与安全性 → 辅助功能”中勾选 U-Words，然后点击重新检测。".into()
}

fn ensure_accessibility_access() -> Result<(), String> {
    if accessibility_is_trusted() {
        Ok(())
    } else {
        Err(accessibility_required_error())
    }
}

#[tauri::command]
pub fn get_accessibility_status() -> bool {
    accessibility_is_trusted()
}

#[tauri::command]
pub fn open_accessibility_settings() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        Command::new("/usr/bin/open")
            .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")
            .spawn()
            .map_err(|error| format!("打开辅助功能设置失败：{error}"))?;
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        Ok(())
    }
}

#[tauri::command]
pub fn get_input_target() -> input_target::InputTarget {
    input_target::inspect()
}

#[tauri::command]
pub fn copy_text(text: String) -> Result<(), String> {
    Clipboard::new()
        .map_err(|_| "初始化剪贴板失败".to_string())?
        .set_text(text)
        .map_err(|_| "复制失败，请重试".to_string())
}

#[tauri::command]
pub fn paste_text(
    text: String,
    expected_pid: Option<i32>,
    expected_key: Option<String>,
) -> Result<(), String> {
    ensure_accessibility_access()?;
    input_target::ensure_target(&input_target::inspect(), expected_pid, expected_key.as_deref())?;
    let mut clipboard = Clipboard::new().map_err(|error| format!("初始化剪贴板失败：{error}"))?;
    let previous = clipboard.get_text().ok();
    let previous_image = if previous.is_none() {
        clipboard.get_image().ok()
    } else {
        None
    };
    let mut enigo =
        Enigo::new(&Settings::default()).map_err(|error| format!("初始化键盘控制失败：{error}"))?;
    clipboard
        .set_text(text.as_str())
        .map_err(|error| format!("写入剪贴板失败：{error}"))?;
    thread::sleep(Duration::from_millis(120));
    let modifier = if cfg!(target_os = "macos") {
        Key::Meta
    } else {
        Key::Control
    };
    let paste_result = (|| -> Result<(), String> {
        input_target::ensure_target(&input_target::inspect(), expected_pid, expected_key.as_deref())?;
        enigo
            .key(modifier, Press)
            .map_err(|error| format!("模拟粘贴失败：{error}"))?;
        let click_result = enigo
            .key(Key::Unicode('v'), Click)
            .map_err(|error| format!("模拟粘贴失败：{error}"));
        let release_result = enigo
            .key(modifier, Release)
            .map_err(|error| format!("释放粘贴快捷键失败：{error}"));
        click_result?;
        release_result
    })();
    thread::sleep(Duration::from_millis(280));
    // Do not overwrite a clipboard value the user changed while the paste was in flight.
    if clipboard.get_text().ok().as_deref() == Some(text.as_str()) {
        if let Some(previous) = previous {
            let _ = clipboard.set_text(previous);
        } else if let Some(previous_image) = previous_image {
            let _ = clipboard.set_image(previous_image);
        } else {
            let _ = clipboard.clear();
        }
    }
    paste_result
}

fn send_copy_shortcut() -> Result<(), String> {
    ensure_accessibility_access()?;
    let mut enigo =
        Enigo::new(&Settings::default()).map_err(|error| format!("初始化键盘控制失败：{error}"))?;
    #[cfg(target_os = "macos")]
    {
        enigo
            .key(Key::Meta, Press)
            .map_err(|error| format!("读取选区失败：{error}"))?;
    }
    #[cfg(not(target_os = "macos"))]
    {
        enigo
            .key(Key::Control, Press)
            .map_err(|error| format!("读取选区失败：{error}"))?;
    }
    enigo
        .key(Key::Unicode('c'), Click)
        .map_err(|error| format!("读取选区失败：{error}"))?;
    #[cfg(target_os = "macos")]
    {
        enigo
            .key(Key::Meta, Release)
            .map_err(|error| format!("读取选区失败：{error}"))?;
    }
    #[cfg(not(target_os = "macos"))]
    {
        enigo
            .key(Key::Control, Release)
            .map_err(|error| format!("读取选区失败：{error}"))?;
    }
    Ok(())
}

#[tauri::command]
pub fn get_selected_text() -> Result<String, String> {
    // 焦点在自身时绝不模拟 Cmd+C：自家选区不进剪贴板哨兵链路（语义同 selection mac 分支）
    if input_target::focus_is_self() {
        return Ok(String::new());
    }
    let mut clipboard = Clipboard::new().map_err(|error| format!("初始化剪贴板失败：{error}"))?;
    let previous = clipboard.get_text().ok();
    let previous_image = if previous.is_none() {
        clipboard.get_image().ok()
    } else {
        None
    };
    let sentinel = format!("__U_WORDS_NO_SELECTION_{}__", std::process::id());
    clipboard
        .set_text(sentinel.as_str())
        .map_err(|error| format!("准备读取选区失败：{error}"))?;
    let copy_result = send_copy_shortcut();
    if copy_result.is_ok() {
        thread::sleep(Duration::from_millis(140));
    }
    let selected = clipboard.get_text().unwrap_or_default();
    if let Some(previous) = previous {
        let _ = clipboard.set_text(previous);
    } else if let Some(previous_image) = previous_image {
        let _ = clipboard.set_image(previous_image);
    } else {
        let _ = clipboard.clear();
    }
    copy_result?;
    Ok(if selected == sentinel {
        String::new()
    } else {
        selected.trim().to_string()
    })
}

#[tauri::command]
pub fn get_active_app() -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        let app = objc2_app_kit::NSWorkspace::sharedWorkspace()
            .frontmostApplication()
            .and_then(|application| application.localizedName().map(|name| name.to_string()))
            .filter(|name| !name.trim().is_empty());
        Ok(app.unwrap_or_else(|| "macOS 应用".into()))
    }
    #[cfg(target_os = "windows")]
    {
        let script = "$signature = '[DllImport(\"user32.dll\")] public static extern IntPtr GetForegroundWindow(); [DllImport(\"user32.dll\")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);'; Add-Type -MemberDefinition $signature -Name NativeMethods -Namespace UWords; [uint32]$foregroundPid = 0; [UWords.NativeMethods]::GetWindowThreadProcessId([UWords.NativeMethods]::GetForegroundWindow(), [ref]$foregroundPid) | Out-Null; (Get-Process -Id $foregroundPid).ProcessName";
        let output = Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-Command", script])
            .output()
            .map_err(|error| format!("读取当前应用失败：{error}"))?;
        if output.status.success() {
            let app = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !app.is_empty() {
                return Ok(app);
            }
        }
        return Ok("Windows 应用".into());
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        Ok("桌面应用".into())
    }
}

fn xml_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

#[tauri::command]
pub fn set_launch_at_login(enabled: bool) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let home = dirs::home_dir().ok_or_else(|| "无法定位用户目录".to_string())?;
        let agents = home.join("Library/LaunchAgents");
        let plist_path = agents.join(format!("{APP_ID}.plist"));
        if enabled {
            fs::create_dir_all(&agents).map_err(|error| format!("创建启动项目录失败：{error}"))?;
            let executable =
                std::env::current_exe().map_err(|error| format!("读取应用路径失败：{error}"))?;
            let body = format!(
                "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n<plist version=\"1.0\"><dict><key>Label</key><string>{APP_ID}</string><key>ProgramArguments</key><array><string>{}</string></array><key>RunAtLoad</key><true/><key>KeepAlive</key><false/></dict></plist>\n",
                xml_escape(&executable.to_string_lossy())
            );
            let temp_path = agents.join(format!("{APP_ID}.plist.tmp"));
            fs::write(&temp_path, body).map_err(|error| format!("写入启动项失败：{error}"))?;
            fs::rename(&temp_path, &plist_path)
                .map_err(|error| format!("保存启动项失败：{error}"))?;
        } else if plist_path.exists() {
            fs::remove_file(&plist_path).map_err(|error| format!("移除启动项失败：{error}"))?;
        }
        Ok(())
    }
    #[cfg(target_os = "windows")]
    {
        let key = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
        if enabled {
            let executable =
                std::env::current_exe().map_err(|error| format!("读取应用路径失败：{error}"))?;
            let value = format!("\"{}\"", executable.to_string_lossy());
            let status = Command::new("reg")
                .args(["add", key, "/v", "U-Words", "/t", "REG_SZ", "/d"])
                .arg(value)
                .args(["/f"])
                .status()
                .map_err(|error| format!("写入 Windows 启动项失败：{error}"))?;
            if !status.success() {
                return Err("写入 Windows 启动项失败".into());
            }
        } else {
            let status = Command::new("reg")
                .args(["delete", key, "/v", "U-Words", "/f"])
                .status()
                .map_err(|error| format!("移除 Windows 启动项失败：{error}"))?;
            if !status.success() {
                return Err("移除 Windows 启动项失败".into());
            }
        }
        return Ok(());
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = enabled;
        Err("当前平台暂不支持开机启动".into())
    }
}
