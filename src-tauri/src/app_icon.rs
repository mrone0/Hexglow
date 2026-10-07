#[cfg(windows)]
pub fn apply(window: &tauri::WebviewWindow) -> Result<(), String> {
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{HINSTANCE, LPARAM, WPARAM};
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::UI::WindowsAndMessaging::{
        LoadImageW, SendMessageW, ICON_BIG, ICON_SMALL, IMAGE_ICON, LR_DEFAULTCOLOR, LR_SHARED,
        WM_SETICON,
    };

    const APP_ICON_RESOURCE: usize = 32512;
    let hwnd = window.hwnd().map_err(|error| error.to_string())?;
    let module = unsafe { GetModuleHandleW(None) }.map_err(|error| error.to_string())?;
    let instance = HINSTANCE(module.0);
    for (kind, size) in [(ICON_SMALL, 32), (ICON_BIG, 256)] {
        let icon = unsafe {
            LoadImageW(
                Some(instance),
                PCWSTR(APP_ICON_RESOURCE as *const u16),
                IMAGE_ICON,
                size,
                size,
                LR_DEFAULTCOLOR | LR_SHARED,
            )
        }
        .map_err(|error| format!("读取 Windows 应用图标失败：{error}"))?;
        unsafe {
            SendMessageW(
                hwnd,
                WM_SETICON,
                Some(WPARAM(kind as usize)),
                Some(LPARAM(icon.0 as isize)),
            );
        }
    }
    Ok(())
}

#[cfg(not(windows))]
pub fn apply(_window: &tauri::WebviewWindow) -> Result<(), String> {
    Ok(())
}
