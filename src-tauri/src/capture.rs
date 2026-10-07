//! 屏幕截取：只在正式目标平台 Windows 上实现。
//! 读取显卡当前输出的像素，不读取游戏进程内存。
use image::RgbImage;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CaptureSkip {
    NoGameWindow,
    GameHidden,
    GameMinimized,
    GameNotForeground,
    #[cfg(not(target_os = "windows"))]
    UnsupportedPlatform,
}

impl CaptureSkip {
    pub fn code(self) -> &'static str {
        match self {
            Self::NoGameWindow => "game-window-not-found",
            Self::GameHidden => "game-window-hidden",
            Self::GameMinimized => "game-window-minimized",
            Self::GameNotForeground => "game-not-foreground",
            #[cfg(not(target_os = "windows"))]
            Self::UnsupportedPlatform => "unsupported-platform",
        }
    }

    pub fn message(self) -> &'static str {
        match self {
            Self::NoGameWindow => "未找到英雄联盟游戏窗口，跳过自动截屏",
            Self::GameHidden => "游戏窗口不可见，跳过自动截屏",
            Self::GameMinimized => "游戏窗口已最小化，跳过自动截屏",
            Self::GameNotForeground => "游戏窗口不在前台，跳过自动截屏",
            #[cfg(not(target_os = "windows"))]
            Self::UnsupportedPlatform => "自动截屏仅支持 Windows；本平台可用图片路径调用 OCR",
        }
    }
}

pub(crate) enum CaptureAttempt {
    Captured(RgbImage),
    Skipped(CaptureSkip),
}

#[cfg(target_os = "windows")]
pub(crate) fn try_grab_center_image() -> Result<CaptureAttempt, String> {
    imp::try_grab_center()
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn try_grab_center_image() -> Result<CaptureAttempt, String> {
    Ok(CaptureAttempt::Skipped(CaptureSkip::UnsupportedPlatform))
}

#[cfg(any(target_os = "windows", test))]
fn capture_skip(
    game: Option<usize>,
    foreground: usize,
    visible: bool,
    minimized: bool,
) -> Option<CaptureSkip> {
    let Some(game) = game else {
        return Some(CaptureSkip::NoGameWindow);
    };
    if minimized {
        return Some(CaptureSkip::GameMinimized);
    }
    if !visible {
        return Some(CaptureSkip::GameHidden);
    }
    if game != foreground {
        return Some(CaptureSkip::GameNotForeground);
    }
    None
}

/// 中心区域比例：海克斯选择卡片位于游戏客户区中部。
#[cfg(any(target_os = "windows", test))]
const CENTER_WIDTH_RATIO: f64 = 0.62;
#[cfg(any(target_os = "windows", test))]
const CENTER_HEIGHT_RATIO: f64 = 0.52;

#[cfg(any(target_os = "windows", test))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct ScreenRect {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

#[cfg(target_os = "windows")]
pub(crate) fn game_client_rect() -> Result<ScreenRect, String> {
    imp::game_client_rect()
}

#[cfg(target_os = "windows")]
pub fn grab_center_png() -> Result<Vec<u8>, String> {
    Ok(encode(&grab_center_image()?))
}

#[cfg(target_os = "windows")]
pub fn grab_center_image() -> Result<RgbImage, String> {
    match try_grab_center_image()? {
        CaptureAttempt::Captured(image) => Ok(image),
        CaptureAttempt::Skipped(reason) => Err(reason.message().into()),
    }
}

#[cfg(not(target_os = "windows"))]
pub fn grab_center_image() -> Result<RgbImage, String> {
    Err("自动截屏仅支持 Windows；本平台可用图片路径调用 OCR".into())
}

#[cfg(not(target_os = "windows"))]
pub fn grab_center_png() -> Result<Vec<u8>, String> {
    Err("自动截屏仅支持 Windows；本平台可用图片路径调用 OCR".into())
}

#[cfg(target_os = "windows")]
mod imp {
    use image::RgbImage;
    use std::ffi::c_void;
    use std::mem::size_of;
    use windows::core::{BOOL, PWSTR};
    use windows::Win32::Foundation::{CloseHandle, HWND, LPARAM, POINT, RECT};
    use windows::Win32::Graphics::Gdi::{
        BitBlt, ClientToScreen, CreateCompatibleDC, CreateDIBSection, DeleteDC, DeleteObject,
        GetDC, ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HDC,
        SRCCOPY,
    };
    use windows::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows::Win32::UI::HiDpi::{
        SetThreadDpiAwarenessContext, DPI_AWARENESS_CONTEXT,
        DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetClientRect, GetForegroundWindow, GetSystemMetrics,
        GetWindowThreadProcessId, IsIconic, IsWindowVisible, SM_CXVIRTUALSCREEN,
        SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN,
    };

    struct PhysicalPixels(DPI_AWARENESS_CONTEXT);
    impl PhysicalPixels {
        fn enter() -> Result<Self, String> {
            let previous =
                unsafe { SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) };
            if previous.is_invalid() {
                return Err("无法切换到物理像素截屏上下文".into());
            }
            Ok(Self(previous))
        }
    }
    impl Drop for PhysicalPixels {
        fn drop(&mut self) {
            unsafe {
                SetThreadDpiAwarenessContext(self.0);
            }
        }
    }

    fn belongs_to_game(window: HWND) -> bool {
        unsafe {
            let mut pid = 0;
            GetWindowThreadProcessId(window, Some(&mut pid));
            if pid == 0 {
                return false;
            }
            let Ok(process) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else {
                return false;
            };
            let mut path = vec![0u16; 32768];
            let mut length = path.len() as u32;
            let queried = QueryFullProcessImageNameW(
                process,
                PROCESS_NAME_WIN32,
                PWSTR(path.as_mut_ptr()),
                &mut length,
            );
            let _ = CloseHandle(process);
            queried.is_ok()
                && super::is_game_executable(&String::from_utf16_lossy(&path[..length as usize]))
        }
    }

    fn client_rect(window: HWND) -> Result<super::ScreenRect, String> {
        unsafe {
            let mut client = RECT::default();
            GetClientRect(window, &mut client).map_err(|e| format!("无法获取游戏客户区：{e}"))?;
            let mut top_left = POINT {
                x: client.left,
                y: client.top,
            };
            let mut bottom_right = POINT {
                x: client.right,
                y: client.bottom,
            };
            if !ClientToScreen(window, &mut top_left).as_bool()
                || !ClientToScreen(window, &mut bottom_right).as_bool()
            {
                return Err("无法定位游戏客户区的屏幕坐标".into());
            }
            super::screen_rect(top_left.x, top_left.y, bottom_right.x, bottom_right.y)
        }
    }

    fn find_game_window() -> Result<Option<HWND>, String> {
        let foreground = unsafe { GetForegroundWindow() };
        if belongs_to_game(foreground) && client_rect(foreground).is_ok() {
            return Ok(Some(foreground));
        }
        struct Search {
            window: Option<HWND>,
            area: u64,
            ready: bool,
        }
        unsafe extern "system" fn visit(window: HWND, context: LPARAM) -> BOOL {
            let search = &mut *(context.0 as *mut Search);
            if belongs_to_game(window) {
                let area = client_rect(window)
                    .map(|rect| u64::from(rect.width) * u64::from(rect.height))
                    .unwrap_or(0);
                let ready =
                    IsWindowVisible(window).as_bool() && !IsIconic(window).as_bool() && area > 0;
                if search.window.is_none() || (ready, area) > (search.ready, search.area) {
                    search.window = Some(window);
                    search.area = area;
                    search.ready = ready;
                }
            }
            BOOL(1)
        }
        let mut search = Search {
            window: None,
            area: 0,
            ready: false,
        };
        unsafe { EnumWindows(Some(visit), LPARAM((&mut search as *mut Search) as isize)) }
            .map_err(|e| format!("无法查找游戏窗口：{e}"))?;
        Ok(search.window)
    }

    pub fn game_client_rect() -> Result<super::ScreenRect, String> {
        let _physical = PhysicalPixels::enter()?;
        let window = find_game_window()?.ok_or(super::CaptureSkip::NoGameWindow.message())?;
        if unsafe { IsIconic(window).as_bool() } {
            return Err(super::CaptureSkip::GameMinimized.message().into());
        }
        if !unsafe { IsWindowVisible(window).as_bool() } {
            return Err(super::CaptureSkip::GameHidden.message().into());
        }
        client_rect(window)
    }

    fn current_skip(window: Option<HWND>) -> Option<super::CaptureSkip> {
        let foreground = unsafe { GetForegroundWindow() };
        super::capture_skip(
            window.map(|w| w.0 as usize),
            foreground.0 as usize,
            window.is_some_and(|w| unsafe { IsWindowVisible(w).as_bool() }),
            window.is_some_and(|w| unsafe { IsIconic(w).as_bool() }),
        )
    }

    pub fn try_grab_center() -> Result<super::CaptureAttempt, String> {
        let _physical = PhysicalPixels::enter()?;
        let window = find_game_window()?;
        if let Some(reason) = current_skip(window) {
            return Ok(super::CaptureAttempt::Skipped(reason));
        }
        let window = window.ok_or("游戏窗口状态失效")?;
        let client = client_rect(window)?;
        let image = capture_region(super::center_region(client)?)?;
        // BitBlt 读取显示输出；截屏期间切到其他应用时丢弃画面，不送入 OCR/cache。
        if let Some(reason) = current_skip(Some(window)) {
            return Ok(super::CaptureAttempt::Skipped(reason));
        }
        Ok(super::CaptureAttempt::Captured(image))
    }

    fn capture_region(region: super::ScreenRect) -> Result<RgbImage, String> {
        let (desktop_x, desktop_y, desktop_width, desktop_height) = unsafe {
            (
                GetSystemMetrics(SM_XVIRTUALSCREEN),
                GetSystemMetrics(SM_YVIRTUALSCREEN),
                GetSystemMetrics(SM_CXVIRTUALSCREEN),
                GetSystemMetrics(SM_CYVIRTUALSCREEN),
            )
        };
        if desktop_width <= 0 || desktop_height <= 0 {
            return Err("无法获取虚拟桌面尺寸".into());
        }
        let desktop = super::ScreenRect {
            x: desktop_x,
            y: desktop_y,
            width: desktop_width as u32,
            height: desktop_height as u32,
        };
        if !super::contains(desktop, region) {
            return Err("游戏的海克斯区域部分位于屏幕外，请将游戏窗口移回屏幕内".into());
        }
        let super::ScreenRect {
            x,
            y,
            width,
            height,
        } = region;
        let bytes = (width as usize)
            .checked_mul(height as usize)
            .and_then(|n| n.checked_mul(4))
            .ok_or("游戏截屏缓冲区尺寸溢出")?;
        unsafe {
            let screen: HDC = GetDC(None);
            if screen.is_invalid() {
                return Err("无法访问屏幕设备上下文".into());
            }
            let memory: HDC = CreateCompatibleDC(Some(screen));
            if memory.is_invalid() {
                ReleaseDC(None, screen);
                return Err("无法创建截取设备上下文".into());
            }
            let mut info = BITMAPINFO::default();
            // Negative height gives top-down rows so pixels map straight onto the image.
            info.bmiHeader = BITMAPINFOHEADER {
                biSize: size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: width as i32,
                biHeight: -(height as i32),
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            };
            let mut bits: *mut c_void = std::ptr::null_mut();
            let created = CreateDIBSection(Some(memory), &info, DIB_RGB_COLORS, &mut bits, None, 0);
            let bitmap = match created {
                Ok(bitmap) => bitmap,
                Err(error) => {
                    let _ = DeleteDC(memory);
                    ReleaseDC(None, screen);
                    return Err(format!("无法分配截取缓冲区：{error}"));
                }
            };
            if bits.is_null() {
                let _ = DeleteObject(bitmap.into());
                let _ = DeleteDC(memory);
                ReleaseDC(None, screen);
                return Err("截取缓冲区为空".into());
            }
            let previous = SelectObject(memory, bitmap.into());
            let copied = BitBlt(
                memory,
                0,
                0,
                width as i32,
                height as i32,
                Some(screen),
                x,
                y,
                SRCCOPY,
            );
            let decoded = copied.map(|()| {
                let pixels = std::slice::from_raw_parts(bits as *const u8, bytes);
                bgra_to_rgb(pixels, width, height)
            });
            SelectObject(memory, previous);
            let _ = DeleteObject(bitmap.into());
            let _ = DeleteDC(memory);
            ReleaseDC(None, screen);
            decoded.map_err(|error| format!("屏幕像素读取失败：{error}"))
        }
    }

    fn bgra_to_rgb(bytes: &[u8], width: u32, height: u32) -> RgbImage {
        let mut pixels = Vec::with_capacity((width * height * 3) as usize);
        for pixel in bytes.chunks_exact(4) {
            pixels.extend_from_slice(&[pixel[2], pixel[1], pixel[0]]);
        }
        RgbImage::from_raw(width, height, pixels).expect("pixel buffer matches dimensions")
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn bgra_to_rgb_swaps_channels() {
            let image = bgra_to_rgb(&[1, 2, 3, 255, 4, 5, 6, 255], 2, 1);
            assert_eq!(image.get_pixel(0, 0).0, [3, 2, 1]);
            assert_eq!(image.get_pixel(1, 0).0, [6, 5, 4]);
        }

        #[test]
        #[ignore = "需要可见的英雄联盟游戏窗口"]
        fn live_game_capture_uses_client_region() {
            use windows::Win32::Graphics::Gdi::{
                GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST,
            };
            use windows::Win32::UI::HiDpi::GetDpiForWindow;
            let scan = crate::ocr::perform_scan(None).unwrap();
            if scan["skipped"] == true {
                println!(
                    "automatic capture skipped: {}; source={}; text_regions=0; candidates=0",
                    scan["reason"], scan["source"]
                );
                assert_eq!(scan["lines"], serde_json::json!([]));
                assert_eq!(scan["candidates"], serde_json::json!([]));
                assert_eq!(scan["cached"], false);
                return;
            }
            let _physical = PhysicalPixels::enter().unwrap();
            let window = find_game_window().unwrap().unwrap();
            let mut monitor = MONITORINFO {
                cbSize: size_of::<MONITORINFO>() as u32,
                ..Default::default()
            };
            assert!(unsafe {
                GetMonitorInfoW(
                    MonitorFromWindow(window, MONITOR_DEFAULTTONEAREST),
                    &mut monitor,
                )
            }
            .as_bool());
            println!(
                "game monitor={},{},{},{}; window_dpi={}",
                monitor.rcMonitor.left,
                monitor.rcMonitor.top,
                monitor.rcMonitor.right,
                monitor.rcMonitor.bottom,
                unsafe { GetDpiForWindow(window) }
            );
            let client = game_client_rect().unwrap();
            let region = super::super::center_region(client).unwrap();
            assert_eq!(scan["imageWidth"], region.width);
            assert_eq!(scan["imageHeight"], region.height);
            println!(
                "game client={client:?}; captured ROI={region:?}; capture={}ms",
                scan["acquisitionMs"]
            );
            println!(
                "scan={}ms; text_regions={}; candidates={}",
                scan["elapsedMs"],
                scan["lines"].as_array().unwrap().len(),
                scan["candidates"].as_array().unwrap().len()
            );
        }
    }
}

#[cfg(any(target_os = "windows", test))]
fn is_game_executable(path: &str) -> bool {
    path.rsplit(['\\', '/'])
        .next()
        .is_some_and(|name| name.eq_ignore_ascii_case("League of Legends.exe"))
}

#[cfg(any(target_os = "windows", test))]
fn screen_rect(left: i32, top: i32, right: i32, bottom: i32) -> Result<ScreenRect, String> {
    let width = i64::from(right) - i64::from(left);
    let height = i64::from(bottom) - i64::from(top);
    if width <= 0 || height <= 0 || width > i64::from(i32::MAX) || height > i64::from(i32::MAX) {
        return Err("游戏客户区尺寸无效".into());
    }
    Ok(ScreenRect {
        x: left,
        y: top,
        width: width as u32,
        height: height as u32,
    })
}

#[cfg(any(target_os = "windows", test))]
fn center_region(client: ScreenRect) -> Result<ScreenRect, String> {
    let right = i64::from(client.x) + i64::from(client.width);
    let bottom = i64::from(client.y) + i64::from(client.height);
    if client.width == 0
        || client.height == 0
        || client.width > i32::MAX as u32
        || client.height > i32::MAX as u32
        || right > i64::from(i32::MAX)
        || bottom > i64::from(i32::MAX)
    {
        return Err("游戏客户区尺寸或坐标无效".into());
    }
    let (x, y, width, height) = center_rect(client.width, client.height);
    Ok(ScreenRect {
        x: client.x + x as i32,
        y: client.y + y as i32,
        width,
        height,
    })
}

#[cfg(any(target_os = "windows", test))]
fn contains(outer: ScreenRect, inner: ScreenRect) -> bool {
    inner.x >= outer.x
        && inner.y >= outer.y
        && i64::from(inner.x) + i64::from(inner.width)
            <= i64::from(outer.x) + i64::from(outer.width)
        && i64::from(inner.y) + i64::from(inner.height)
            <= i64::from(outer.y) + i64::from(outer.height)
}

#[cfg(any(target_os = "windows", test))]
pub(crate) fn center_rect(width: u32, height: u32) -> (u32, u32, u32, u32) {
    let crop_width = ((width as f64) * CENTER_WIDTH_RATIO) as u32;
    let crop_height = ((height as f64) * CENTER_HEIGHT_RATIO) as u32;
    let x = width.saturating_sub(crop_width) / 2;
    let y = height.saturating_sub(crop_height) / 2;
    (x, y, crop_width.max(1), crop_height.max(1))
}

#[cfg(test)]
fn crop_center(screen: &RgbImage) -> RgbImage {
    let (x, y, width, height) = center_rect(screen.width(), screen.height());
    image::imageops::crop_imm(screen, x, y, width, height).to_image()
}

#[cfg(any(target_os = "windows", test))]
fn encode(image: &RgbImage) -> Vec<u8> {
    let mut png = Vec::new();
    image
        .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
        .expect("encoding an in-memory PNG cannot fail");
    png
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::Rgb;

    fn image(width: u32, height: u32) -> RgbImage {
        RgbImage::from_fn(width, height, |x, y| Rgb([x as u8, y as u8, 0]))
    }

    #[test]
    fn center_crop_is_centered_and_bounded() {
        let (x, y, width, height) = center_rect(1920, 1080);
        assert_eq!((width, height), (1190, 561));
        assert!((i64::from(x) * 2 + i64::from(width) - 1920).abs() <= 1);
        assert!((i64::from(y) * 2 + i64::from(height) - 1080).abs() <= 1);
    }

    #[test]
    fn game_identity_excludes_the_launcher_and_other_executables() {
        assert!(is_game_executable(
            "C:\\Riot Games\\League of Legends\\Game\\League of Legends.exe"
        ));
        assert!(is_game_executable("D:/Games/LEAGUE OF LEGENDS.EXE"));
        assert!(!is_game_executable("C:\\Riot Games\\LeagueClientUx.exe"));
        assert!(!is_game_executable("League of Legends.exe.other"));
    }

    #[test]
    fn automatic_capture_requires_the_same_visible_nonminimized_foreground_window() {
        assert_eq!(capture_skip(Some(11), 11, true, false), None);
        assert_eq!(
            capture_skip(Some(11), 22, true, false),
            Some(CaptureSkip::GameNotForeground)
        );
        assert_eq!(
            capture_skip(Some(11), 22, true, true),
            Some(CaptureSkip::GameMinimized)
        );
        assert_eq!(
            capture_skip(Some(11), 11, false, false),
            Some(CaptureSkip::GameHidden)
        );
        assert_eq!(
            capture_skip(None, 11, false, false),
            Some(CaptureSkip::NoGameWindow)
        );
    }

    #[test]
    fn roi_tracks_game_client_on_positive_and_negative_secondary_screens() {
        let left = screen_rect(-1920, 0, 0, 1080).unwrap();
        let left_roi = center_region(left).unwrap();
        assert_eq!(
            left_roi,
            ScreenRect {
                x: -1555,
                y: 259,
                width: 1190,
                height: 561
            }
        );
        let right = screen_rect(1920, 100, 3840, 1180).unwrap();
        let right_roi = center_region(right).unwrap();
        assert_eq!(right_roi.x, 2285);
        assert_eq!(right_roi.y, 359);
        assert!(contains(
            ScreenRect {
                x: -1920,
                y: 0,
                width: 5760,
                height: 2160
            },
            left_roi
        ));
        assert!(!contains(
            ScreenRect {
                x: 0,
                y: 0,
                width: 1920,
                height: 1080
            },
            left_roi
        ));
    }

    #[test]
    fn physical_roi_uses_client_pixels_without_a_second_dpi_scale() {
        let client = screen_rect(-2400, -200, 480, 1420).unwrap();
        let roi = center_region(client).unwrap();
        assert_eq!((roi.width, roi.height), (1785, 842));
        assert_eq!((roi.x, roi.y), (-1853, 189));
        assert!(contains(client, roi));
        let tiny = center_region(ScreenRect {
            x: 20,
            y: 30,
            width: 1,
            height: 1,
        })
        .unwrap();
        assert_eq!(
            tiny,
            ScreenRect {
                x: 20,
                y: 30,
                width: 1,
                height: 1
            }
        );
        assert!(center_region(ScreenRect {
            x: i32::MAX,
            y: 0,
            width: 1,
            height: 1
        })
        .is_err());
        assert!(center_region(ScreenRect {
            x: 0,
            y: 0,
            width: 0,
            height: 1
        })
        .is_err());
        assert!(screen_rect(1, 1, 1, 2).is_err());
        assert!(screen_rect(i32::MIN, 0, i32::MAX, 100).is_err());
    }

    #[test]
    fn crop_returns_expected_size() {
        let cropped = crop_center(&image(1920, 1080));
        assert_eq!((cropped.width(), cropped.height()), (1190, 561));
    }

    #[test]
    fn png_round_trip() {
        let png = encode(&image(64, 32));
        let decoded = image::load_from_memory(&png).unwrap().to_rgb8();
        assert_eq!((decoded.width(), decoded.height()), (64, 32));
    }

    #[test]
    fn non_windows_capture_reports_platform() {
        #[cfg(not(target_os = "windows"))]
        assert!(grab_center_png().unwrap_err().contains("Windows"));
    }
}
