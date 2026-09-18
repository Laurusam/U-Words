use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Selection {
    pub text: String,
    pub pid: i32,
    pub key: String,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub editable: bool,
}

pub fn read() -> Option<Selection> {
    if pointer_down() { return None; }
    #[cfg(target_os = "macos")]
    {
        mac::read()
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        let output = std::process::Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-Command", include_str!("selection_windows.ps1")])
            .creation_flags(0x08000000)
            .output()
            .ok()?;
        serde_json::from_slice::<Selection>(&output.stdout)
            .ok()
            .filter(|selection| {
                !selection.text.trim().is_empty()
                    && selection.pid != std::process::id() as i32
            })
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        None
    }
}

fn pointer_down()->bool {
    #[cfg(target_os="macos")]
    { #[link(name="ApplicationServices",kind="framework")] unsafe extern "C"{fn CGEventSourceButtonState(state:i32,button:u32)->bool;}
      unsafe{return CGEventSourceButtonState(1,0)} }
    #[cfg(target_os="windows")]
    { #[link(name="user32")] unsafe extern "system"{fn GetAsyncKeyState(key:i32)->i16;}
      unsafe{return GetAsyncKeyState(1)<0} }
    #[cfg(not(any(target_os="macos",target_os="windows")))] { false }
}

#[cfg(target_os = "macos")]
mod mac {
    use super::*;
    use std::{
        ffi::{c_void, CString},
        ptr,
    };
    type Ref = *const c_void;
    #[repr(C)]
    struct Point {
        x: f64,
        y: f64,
    }
    #[repr(C)]
    struct Size {
        width: f64,
        height: f64,
    }
    #[repr(C)]
    struct Rect {
        origin: Point,
        size: Size,
    }
    #[link(name = "ApplicationServices", kind = "framework")]
    unsafe extern "C" {
        fn AXIsProcessTrusted() -> u8;
        fn AXUIElementCreateSystemWide() -> Ref;
        fn AXUIElementCopyAttributeValue(element: Ref, name: Ref, out: *mut Ref) -> i32;
        fn AXUIElementCopyParameterizedAttributeValue(
            element: Ref,
            name: Ref,
            parameter: Ref,
            out: *mut Ref,
        ) -> i32;
        fn AXUIElementGetPid(element: Ref, pid: *mut i32) -> i32;
        fn AXUIElementSetMessagingTimeout(element: Ref, timeout: f32) -> i32;
        fn AXValueGetValue(value: Ref, type_: u32, out: *mut c_void) -> u8;
        fn AXUIElementIsAttributeSettable(element: Ref, name: Ref, out: *mut u8) -> i32;
    }
    #[link(name = "CoreFoundation", kind = "framework")]
    unsafe extern "C" {
        fn CFStringCreateWithCString(allocator: Ref, string: *const i8, encoding: u32) -> Ref;
        fn CFStringGetCString(string: Ref, buffer: *mut i8, size: isize, encoding: u32) -> u8;
        fn CFGetTypeID(object: Ref) -> usize;
        fn CFStringGetTypeID() -> usize;
        fn CFRelease(object: Ref);
        fn CFHash(object: Ref) -> usize;
    }
    struct Owned(Ref);
    impl Drop for Owned {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe { CFRelease(self.0) }
            }
        }
    }
    fn name(string: &str) -> Owned {
        let string = CString::new(string).unwrap();
        Owned(unsafe { CFStringCreateWithCString(ptr::null(), string.as_ptr(), 0x08000100) })
    }
    fn attr(element: Ref, attribute: &str) -> Option<Owned> {
        let name = name(attribute);
        let mut value = ptr::null();
        let status = unsafe { AXUIElementCopyAttributeValue(element, name.0, &mut value) };
        let value = Owned(value);
        (status == 0 && !value.0.is_null()).then_some(value)
    }
    fn string(value: Ref) -> Option<String> {
        unsafe {
            if CFGetTypeID(value) != CFStringGetTypeID() {
                return None;
            }
            let mut buffer = vec![0i8; 262_145];
            if CFStringGetCString(value, buffer.as_mut_ptr(), buffer.len() as isize, 0x08000100)
                == 0
            {
                return None;
            }
            Some(std::ffi::CStr::from_ptr(buffer.as_ptr()).to_string_lossy().into())
        }
    }
    pub fn read() -> Option<Selection> {
        unsafe {
            if AXIsProcessTrusted() == 0 {
                return None;
            }
            let root = Owned(AXUIElementCreateSystemWide());
            AXUIElementSetMessagingTimeout(root.0, 0.15);
            let element = attr(root.0, "AXFocusedUIElement")?;
            AXUIElementSetMessagingTimeout(element.0, 0.15);
            let mut pid = 0;
            AXUIElementGetPid(element.0, &mut pid);
            if pid == std::process::id() as i32 {
                return None;
            }
            if attr(element.0, "AXSubrole")
                .and_then(|value| string(value.0))
                .as_deref()
                == Some("AXSecureTextField")
            {
                return None;
            }
            let text = string(attr(element.0, "AXSelectedText")?.0)?;
            if text.trim().is_empty() {
                return None;
            }
            let range = attr(element.0, "AXSelectedTextRange")?;
            let range_name = name("AXBoundsForRange");
            let mut bounds = ptr::null();
            if AXUIElementCopyParameterizedAttributeValue(
                element.0,
                range_name.0,
                range.0,
                &mut bounds,
            ) != 0
            {
                return None;
            }
            let bounds = Owned(bounds);
            if bounds.0.is_null() {
                return None;
            }
            let mut rect = Rect {
                origin: Point { x: 0., y: 0. },
                size: Size {
                    width: 0.,
                    height: 0.,
                },
            };
            if AXValueGetValue(bounds.0, 3, &mut rect as *mut _ as *mut c_void) == 0 {
                return None;
            }
            let mut editable = 0;
            let value = name("AXValue");
            AXUIElementIsAttributeSettable(element.0, value.0, &mut editable);
            Some(Selection {
                text,
                pid,
                key: format!("{pid}:{}:{}", CFHash(element.0), CFHash(range.0)),
                x: rect.origin.x,
                y: rect.origin.y,
                width: rect.size.width,
                height: rect.size.height,
                editable: editable != 0,
            })
        }
    }
}

#[tauri::command]
pub async fn read_selection() -> Option<Selection> {
    tauri::async_runtime::spawn_blocking(read)
        .await
        .ok()
        .flatten()
}

pub fn activate(pid: i32) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use objc2_app_kit::{NSApplicationActivationOptions, NSRunningApplication};
        let app = NSRunningApplication::runningApplicationWithProcessIdentifier(pid)
            .ok_or("原应用已退出")?;
        #[allow(deprecated)]
        if app.activateWithOptions(NSApplicationActivationOptions::ActivateIgnoringOtherApps) {
            return Ok(());
        }
    }
    #[cfg(target_os = "windows")]
    unsafe {
        type Hwnd = *mut std::ffi::c_void;
        #[link(name = "user32")]
        extern "system" {
            fn EnumWindows(
                callback: unsafe extern "system" fn(Hwnd, isize) -> i32,
                data: isize,
            ) -> i32;
            fn GetWindowThreadProcessId(window: Hwnd, process_id: *mut u32) -> u32;
            fn IsWindowVisible(window: Hwnd) -> i32;
            fn SetForegroundWindow(window: Hwnd) -> i32;
        }
        unsafe extern "system" fn visit(window: Hwnd, data: isize) -> i32 {
            let pair = &mut *(data as *mut (u32, bool));
            let mut process_id = 0;
            GetWindowThreadProcessId(window, &mut process_id);
            if process_id == pair.0 && IsWindowVisible(window) != 0 {
                pair.1 = SetForegroundWindow(window) != 0;
                return 0;
            }
            1
        }
        let mut pair = (pid as u32, false);
        EnumWindows(visit, &mut pair as *mut _ as isize);
        if pair.1 {
            return Ok(());
        }
    }
    Err("无法恢复原应用，请切回原选区后重试或复制结果".into())
}
