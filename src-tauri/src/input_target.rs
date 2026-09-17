use serde::Serialize;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InputTarget {
    pub editable: bool,
    pub app_pid: Option<i32>,
    pub reason: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_key: Option<String>,
}

fn unavailable(reason: &str) -> InputTarget {
    InputTarget {
        editable: false,
        app_pid: None,
        reason: reason.into(),
        target_key: None,
    }
}

pub fn ensure_target(target: &InputTarget, expected_pid: Option<i32>) -> Result<(), String> {
    if !target.editable {
        return Err(target.reason.clone());
    }
    if expected_pid.is_some() && expected_pid != target.app_pid {
        return Err("目标应用已切换，文字已保留，请复制后粘贴".into());
    }
    Ok(())
}

#[cfg(target_os = "macos")]
pub fn inspect() -> InputTarget {
    macos::inspect()
}

#[cfg(target_os = "windows")]
pub fn inspect() -> InputTarget {
    #[repr(C)]
    struct GuiThreadInfo {
        size: u32,
        flags: u32,
        windows: [isize; 6],
        caret: [i32; 4],
    }
    #[link(name = "user32")]
    unsafe extern "system" {
        fn GetForegroundWindow() -> isize;
        fn GetWindowThreadProcessId(window: isize, pid: *mut u32) -> u32;
        fn GetGUIThreadInfo(thread: u32, info: *mut GuiThreadInfo) -> i32;
    }
    unsafe {
        let window = GetForegroundWindow();
        if window == 0 {
            return unavailable("未检测到前台输入窗口，请复制文字");
        }
        let mut pid = 0;
        let thread = GetWindowThreadProcessId(window, &mut pid);
        let mut info = GuiThreadInfo {
            size: std::mem::size_of::<GuiThreadInfo>() as u32,
            flags: 0,
            windows: [0; 6],
            caret: [0; 4],
        };
        if thread == 0 || GetGUIThreadInfo(thread, &mut info) == 0 || info.windows[5] == 0 {
            return unavailable("未检测到系统输入光标，请复制文字");
        }
        InputTarget {
            editable: true,
            app_pid: Some(pid as i32),
            reason: "检测到系统输入光标".into(),
            target_key: (info.windows[1] != 0).then(|| format!("{pid}:{}", info.windows[1])),
        }
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub fn inspect() -> InputTarget {
    unavailable("当前系统无法检测输入光标，请复制文字")
}

#[cfg(target_os = "macos")]
mod macos {
    use super::*;
    use std::{
        ffi::{c_void, CString},
        ptr,
    };
    type Ref = *const c_void;
    #[link(name = "ApplicationServices", kind = "framework")]
    unsafe extern "C" {
        fn AXIsProcessTrusted() -> u8;
        fn AXUIElementCreateSystemWide() -> Ref;
        fn AXUIElementCopyAttributeValue(element: Ref, name: Ref, value: *mut Ref) -> i32;
        fn AXUIElementIsAttributeSettable(element: Ref, name: Ref, value: *mut u8) -> i32;
        fn AXUIElementGetPid(element: Ref, pid: *mut i32) -> i32;
        fn AXUIElementSetMessagingTimeout(element: Ref, seconds: f32) -> i32;
    }
    #[link(name = "CoreFoundation", kind = "framework")]
    unsafe extern "C" {
        fn CFStringCreateWithCString(allocator: Ref, text: *const i8, encoding: u32) -> Ref;
        fn CFStringGetCString(text: Ref, buffer: *mut i8, size: isize, encoding: u32) -> u8;
        fn CFGetTypeID(value: Ref) -> usize;
        fn CFStringGetTypeID() -> usize;
        fn CFBooleanGetTypeID() -> usize;
        fn CFBooleanGetValue(value: Ref) -> u8;
        fn CFRelease(value: Ref);
        fn CFHash(value: Ref) -> usize;
    }
    struct Owned(Ref);
    impl Drop for Owned {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe { CFRelease(self.0) };
            }
        }
    }
    fn name(text: &str) -> Owned {
        let text = CString::new(text).unwrap();
        Owned(unsafe { CFStringCreateWithCString(ptr::null(), text.as_ptr(), 0x08000100) })
    }
    fn attribute(element: Ref, text: &str) -> Option<Owned> {
        let name = name(text);
        let mut result = ptr::null();
        let status = unsafe { AXUIElementCopyAttributeValue(element, name.0, &mut result) };
        let owned = Owned(result);
        (status == 0 && !result.is_null()).then_some(owned)
    }
    fn boolean(element: Ref, text: &str) -> Option<bool> {
        let value = attribute(element, text)?;
        unsafe {
            (CFGetTypeID(value.0) == CFBooleanGetTypeID()).then(|| CFBooleanGetValue(value.0) != 0)
        }
    }
    fn string(element: Ref, text: &str) -> Option<String> {
        let value = attribute(element, text)?;
        let mut buffer = [0_i8; 256];
        unsafe {
            if CFGetTypeID(value.0) != CFStringGetTypeID()
                || CFStringGetCString(
                    value.0,
                    buffer.as_mut_ptr(),
                    buffer.len() as isize,
                    0x08000100,
                ) == 0
            {
                return None;
            }
            Some(
                std::ffi::CStr::from_ptr(buffer.as_ptr())
                    .to_string_lossy()
                    .into(),
            )
        }
    }
    pub fn inspect() -> InputTarget {
        unsafe {
            if AXIsProcessTrusted() == 0 {
                return unavailable("辅助功能未授权，文字已保留，请复制文字");
            }
            let system = Owned(AXUIElementCreateSystemWide());
            if system.0.is_null() {
                return unavailable("无法读取输入焦点，请复制文字");
            }
            AXUIElementSetMessagingTimeout(system.0, 0.25);
            let Some(focus) = attribute(system.0, "AXFocusedUIElement") else {
                return unavailable("未检测到可编辑光标，请复制文字");
            };
            AXUIElementSetMessagingTimeout(focus.0, 0.25);
            let role = string(focus.0, "AXRole").unwrap_or_default();
            let subrole = string(focus.0, "AXSubrole").unwrap_or_default();
            if subrole == "AXSecureTextField"
                || role == "AXSecureTextField"
                || boolean(focus.0, "AXProtectedContent") == Some(true)
            {
                return unavailable("受保护输入框不自动插入，请自行处理文字");
            }
            let mut settable = 0;
            let value_name = name("AXValue");
            let writable = AXUIElementIsAttributeSettable(focus.0, value_name.0, &mut settable)
                == 0
                && settable != 0;
            let text_role = matches!(role.as_str(), "AXTextField" | "AXTextArea" | "AXComboBox");
            let editable = boolean(focus.0, "AXEnabled") != Some(false)
                && (boolean(focus.0, "AXEditable") == Some(true) || (text_role && writable));
            if !editable {
                return unavailable("未确认可编辑光标，文字已保留，请复制文字");
            }
            let mut pid = 0;
            if AXUIElementGetPid(focus.0, &mut pid) != 0 || pid <= 0 {
                return unavailable("无法确认目标应用，请复制文字");
            }
            if pid == std::process::id() as i32 {
                return unavailable("当前焦点在 U-Words，请复制到目标应用");
            }
            InputTarget {
                editable: true,
                app_pid: Some(pid),
                reason: "检测到可编辑输入框".into(),
                // Metadata-only best-effort identity, not proof the document is unchanged.
                target_key: attribute(focus.0, "AXWindow")
                    .map(|window| format!("{pid}:{}:{}", CFHash(window.0), CFHash(focus.0))),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unknown_cursor_and_changed_app_never_paste() {
        assert!(ensure_target(&unavailable("无光标"), None).is_err());
        let target = InputTarget {
            editable: true,
            app_pid: Some(123),
            reason: String::new(),
            target_key: None,
        };
        assert!(ensure_target(&target, Some(123)).is_ok());
        assert!(ensure_target(&target, Some(456)).is_err());
    }
}
