//! 置顶悬浮侧栏：右缘贴边、无边框、透明背景。
//! 只负责窗口生命周期与定位；内容与 OCR 流程在前端。
use serde_json::json;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::thread::JoinHandle;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

const LABEL: &str = "overlay";
const WIDTH: f64 = 360.0;
const HEIGHT: f64 = 640.0;
const BANDS: [u32; 4] = [1, 7, 11, 15];
/// 折叠后只剩一条竖直把手。
const COLLAPSED_WIDTH: f64 = 44.0;
/// 悬停判定轮询间隔：鼠标是否落在侧栏里，决定是否穿透。
const WATCH_INTERVAL: Duration = Duration::from_millis(100);
static WATCHER: Mutex<Option<(u64, JoinHandle<()>)>> = Mutex::new(None);
static GENERATION: AtomicU64 = AtomicU64::new(0);

fn trace(app: &AppHandle, level: &str, event: &str, message: String) {
    if let Ok((_, logs)) = crate::collector::directories(app) {
        let _ = crate::collector::append_log(&logs, level, event, &message);
    }
}

fn anchor(window: &WebviewWindow) -> Result<(), String> {
    let monitor = window
        .current_monitor()
        .map_err(|e| e.to_string())?
        .or_else(|| window.primary_monitor().ok().flatten())
        .ok_or_else(|| "无法获取当前显示器".to_string())?;
    let origin = monitor.position();
    let area = monitor.size();
    let size = window.outer_size().map_err(|e| e.to_string())?;
    let x = origin.x + area.width.saturating_sub(size.width) as i32;
    let y = origin.y + (area.height.saturating_sub(size.height) / 2) as i32;
    window
        .set_position(PhysicalPosition::new(x, y))
        .map_err(|e| e.to_string())
}

fn notify(window: &WebviewWindow, level: u32) -> Result<(), String> {
    window
        .emit(
            "overlay:level",
            json!({"level": level, "at": chrono::Utc::now().to_rfc3339()}),
        )
        .map_err(|e| e.to_string())
}

/// 默认鼠标穿透，指针进入侧栏矩形时才恢复可点击。
fn cursor_overlays(window: &WebviewWindow) -> bool {
    let (Ok(cursor), Ok(origin), Ok(size)) = (
        window.cursor_position(),
        window.outer_position(),
        window.outer_size(),
    ) else {
        return false;
    };
    let x = origin.x as f64;
    let y = origin.y as f64;
    cursor.x >= x
        && cursor.x <= x + size.width as f64
        && cursor.y >= y
        && cursor.y <= y + size.height as f64
}

fn stop_watcher() {
    let generation = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    if let Ok(mut guard) = WATCHER.lock() {
        if let Some((owner, handle)) = guard.take() {
            if owner == generation - 1 {
                drop(guard);
                let _ = handle.join();
            }
        }
    }
}

fn start_watcher(app: &AppHandle) {
    stop_watcher();
    let generation = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    let app = app.clone();
    let handle = std::thread::spawn(move || {
        let mut hovering = false;
        while GENERATION.load(Ordering::SeqCst) == generation {
            let Some(window) = app.get_webview_window(LABEL) else {
                break;
            };
            let inside = cursor_overlays(&window);
            if inside != hovering {
                hovering = inside;
                if window.set_ignore_cursor_events(!inside).is_ok() {
                    trace(
                        &app,
                        "info",
                        "overlay-pointer",
                        if inside {
                            "pointer entered overlay, input enabled".into()
                        } else {
                            "pointer left overlay, input ignored".into()
                        },
                    );
                }
            }
            std::thread::sleep(WATCH_INTERVAL);
        }
    });
    if let Ok(mut guard) = WATCHER.lock() {
        *guard = Some((generation, handle));
    }
}

#[tauri::command]
pub fn overlay_set_collapsed(app: AppHandle, collapsed: bool) -> Result<f64, String> {
    let window = app
        .get_webview_window(LABEL)
        .ok_or_else(|| "侧栏未打开".to_string())?;
    let width = if collapsed { COLLAPSED_WIDTH } else { WIDTH };
    window
        .set_size(PhysicalSize::new(width as u32, HEIGHT as u32))
        .map_err(|e| e.to_string())?;
    anchor(&window)?;
    trace(
        &app,
        "info",
        "overlay-collapse",
        format!("collapsed={collapsed} width={width}"),
    );
    Ok(width)
}

#[tauri::command]
pub fn overlay_open(app: AppHandle, level: u32) -> Result<(), String> {
    if !BANDS.contains(&level) {
        return Err("未知的海克斯等级".into());
    }
    if let Some(window) = app.get_webview_window(LABEL) {
        window.show().map_err(|e| e.to_string())?;
        window
            .set_always_on_top(true)
            .map_err(|e| e.to_string())?;
        anchor(&window)?;
        window.set_ignore_cursor_events(true).map_err(|e| e.to_string())?;
        start_watcher(&app);
        notify(&window, level)?;
        trace(&app, "info", "overlay-open", format!("reused window at level {level}"));
        return Ok(());
    }
    let window = WebviewWindowBuilder::new(
        &app,
        LABEL,
        WebviewUrl::App("index.html?overlay=1".into()),
    )
    .title("海萤 · 海克斯侧栏")
    .inner_size(WIDTH, HEIGHT)
    .resizable(false)
    .transparent(true)
    .decorations(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .focused(false)
    .build()
    .map_err(|e| e.to_string())?;
    anchor(&window)?;
    window.set_ignore_cursor_events(true).map_err(|e| e.to_string())?;
    start_watcher(&app);
    notify(&window, level)?;
    trace(&app, "info", "overlay-open", format!("created window at level {level}"));
    Ok(())
}

#[tauri::command]
pub fn overlay_ready(app: AppHandle, level: Option<u32>) -> Result<(), String> {
    trace(
        &app,
        "info",
        "overlay-ready",
        match level {
            Some(level) => format!("frontend mounted at level {level}"),
            None => "frontend mounted".into(),
        },
    );
    Ok(())
}

#[tauri::command]
pub fn overlay_close(app: AppHandle) -> Result<(), String> {
    stop_watcher();
    if let Some(window) = app.get_webview_window(LABEL) {
        window.hide().map_err(|e| e.to_string())?;
        trace(&app, "info", "overlay-close", "hidden by user".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn collapse_shrinks_to_a_handle_only() {
        assert!(COLLAPSED_WIDTH < WIDTH / 4.0);
        assert!(COLLAPSED_WIDTH > 24.0);
    }

    #[test]
    fn watcher_poll_interval_is_short_but_not_busy() {
        assert!(WATCH_INTERVAL >= Duration::from_millis(50));
        assert!(WATCH_INTERVAL <= Duration::from_millis(250));
    }

    #[test]
    fn only_official_levels_are_openable() {
        for level in BANDS {
            assert!(BANDS.contains(&level));
        }
        assert!(!BANDS.contains(&6));
        assert!(!BANDS.contains(&16));
    }
}
