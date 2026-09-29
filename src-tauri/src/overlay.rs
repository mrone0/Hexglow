//! 置顶悬浮侧栏：右缘贴边、无边框、透明背景。
//! 只负责窗口生命周期与定位；内容与 OCR 流程在前端。
use serde_json::json;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};
use tauri::{
    AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};

const LABEL: &str = "overlay";
const WIDTH: f64 = 360.0;
const HEIGHT: f64 = 640.0;
const BANDS: [u32; 4] = [1, 7, 11, 15];
/// 折叠后只剩一条竖直把手。
const COLLAPSED_WIDTH: f64 = 44.0;
/// 悬停判定轮询间隔：鼠标是否落在侧栏里，决定是否穿透。
const WATCH_INTERVAL: Duration = Duration::from_millis(100);
/// 指针在侧栏内停留多久才恢复可点击：快速划过保持穿透，不打断游戏操作。
const DWELL: Duration = Duration::from_millis(400);
/// 弹出后若始终无人交互，自动收起，只留 44px 把手，不遮挡游戏画面。
const AUTO_COLLAPSE: Duration = Duration::from_secs(20);
static WATCHER: Mutex<Option<(u64, JoinHandle<()>)>> = Mutex::new(None);
static GENERATION: AtomicU64 = AtomicU64::new(0);
/// 当前是否处于收起态。resize 生效有延迟，坐标与自动收起判定都以它为准，不读窗口尺寸。
static COLLAPSED: AtomicBool = AtomicBool::new(false);

fn trace(app: &AppHandle, level: &str, event: &str, message: String) {
    if let Ok((_, logs)) = crate::collector::directories(app) {
        let _ = crate::collector::append_log(&logs, level, event, &message);
    }
}

/// 按目标逻辑宽度贴右缘、垂直居中。
/// 不读取 outer_size：set_size 生效有延迟，读到旧宽度会把窗口算到屏幕中间。
fn anchor(window: &WebviewWindow, logical_width: f64) -> Result<(), String> {
    let monitor = window
        .current_monitor()
        .map_err(|e| e.to_string())?
        .or_else(|| window.primary_monitor().ok().flatten())
        .ok_or_else(|| "无法获取当前显示器".to_string())?;
    let origin = monitor.position();
    let area = monitor.size();
    let scale = monitor.scale_factor();
    let x = edge_x(area.width, logical_width, scale);
    let height_px = (HEIGHT * scale).round() as i32;
    let y = origin.y + (area.height as i32 - height_px).max(0) / 2;
    let position = PhysicalPosition::new(x + origin.x, y);
    window.set_position(position.clone()).map_err(|e| e.to_string())?;
    if let Ok((_, logs)) = crate::collector::directories(window.app_handle()) {
        let _ = crate::collector::append_log(
            &logs,
            "info",
            "overlay-anchor",
            &format!(
                "logical={logical_width} scale={scale} monitor={}x{}@{},{x} → pos={},{}",
                area.width,
                area.height,
                origin.x,
                position.x,
                position.y
            ),
        );
    }
    Ok(())
}

/// 纯函数：右缘 x 坐标（物理像素）。逻辑宽度 × 缩放，不依赖窗口当前尺寸。
fn edge_x(area_width: u32, logical_width: f64, scale: f64) -> i32 {
    let width_px = (logical_width * scale).round() as i32;
    (area_width as i32 - width_px).max(0)
}

/// 统一用逻辑尺寸调窗口大小，与建窗时的 inner_size 口径一致（Retina 下不缩水一半）。
fn resize(window: &WebviewWindow, logical_width: f64) -> Result<(), String> {
    window
        .set_size(LogicalSize::new(logical_width, HEIGHT))
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

/// 让旧 watcher 自行退出，绝不 join。
/// watcher 每 100ms 都会调用需要主线程的窗口 API（set_size / cursor_position 等），
/// 一旦从主线程或 IPC 线程 join，就会与"等主线程"互相等待而卡死整个应用。
/// 旧线程在下一轮循环看到 generation 变化后自行结束，句柄随 drop 分离。
fn stop_watcher() {
    GENERATION.fetch_add(1, Ordering::SeqCst);
    if let Ok(mut guard) = WATCHER.lock() {
        guard.take();
    }
}

fn start_watcher(app: &AppHandle) {
    stop_watcher();
    let generation = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    let app = app.clone();
    let handle = std::thread::spawn(move || {
        let started = Instant::now();
        let mut enabled = false; // 当前是否已恢复可点击
        let mut dwell_since: Option<Instant> = None;
        let mut expanded_since: Option<Instant> = None;
        while GENERATION.load(Ordering::SeqCst) == generation {
            let Some(window) = app.get_webview_window(LABEL) else {
                break;
            };
            let inside = cursor_overlays(&window);
            if inside {
                if dwell_since.is_none() {
                    dwell_since = Some(Instant::now());
                }
            } else {
                dwell_since = None;
            }
            let should_enable =
                inside && dwell_since.is_some_and(|at| at.elapsed() >= DWELL);
            if should_enable != enabled {
                enabled = should_enable;
                if window.set_ignore_cursor_events(!enabled).is_ok() {
                    trace(
                        &app,
                        "info",
                        "overlay-pointer",
                        if enabled {
                            format!("pointer dwelled in overlay after {DWELL:?}, input enabled")
                        } else {
                            "pointer left overlay, input ignored".into()
                        },
                    );
                }
            }
            // 无人交互的弹出：到期自动收起，避免长时间遮挡游戏。
            if COLLAPSED.load(Ordering::SeqCst) {
                expanded_since = None;
            } else if enabled {
                expanded_since = None; // 用户正在交互，不自动收起
            } else {
                let since = *expanded_since.get_or_insert(Instant::now());
                if started.elapsed() >= AUTO_COLLAPSE && since.elapsed() >= AUTO_COLLAPSE {
                    let _ = resize(&window, COLLAPSED_WIDTH);
                    let _ = anchor(&window, COLLAPSED_WIDTH);
                    COLLAPSED.store(true, Ordering::SeqCst);
                    let _ = window.emit(
                        "overlay:collapsed",
                        json!({"collapsed": true, "reason": "auto"}),
                    );
                    expanded_since = None;
                    trace(
                        &app,
                        "info",
                        "overlay-collapse",
                        format!(
                            "auto-collapsed after {AUTO_COLLAPSE:?} without interaction; stays click-through"
                        ),
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
    resize(&window, width)?;
    anchor(&window, width)?;
    COLLAPSED.store(collapsed, Ordering::SeqCst);
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
        // 已可见时不重复 show，避免弹出时抢走游戏焦点。
        if !window.is_visible().unwrap_or(false) {
            window.show().map_err(|e| e.to_string())?;
        }
        window
            .set_always_on_top(true)
            .map_err(|e| e.to_string())?;
        // 主动弹出：恢复展开态（可能此前被自动收起），并保持穿透。
        resize(&window, WIDTH)?;
        anchor(&window, WIDTH)?;
        COLLAPSED.store(false, Ordering::SeqCst);
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
    anchor(&window, WIDTH)?;
    COLLAPSED.store(false, Ordering::SeqCst);
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
    fn interaction_never_hijacks_gameplay() {
        // 快速划过必须保持穿透，只有停留足够久才恢复可点击。
        assert!(DWELL >= Duration::from_millis(200));
        assert!(DWELL < AUTO_COLLAPSE);
        // 无人交互的弹出要自动收起，避免长时间遮挡画面。
        assert!(AUTO_COLLAPSE >= Duration::from_secs(10));
        assert!(WATCH_INTERVAL < DWELL, "轮询必须快于停留判定");
    }

    #[test]
    fn edge_math_keeps_the_panel_on_the_right_edge() {
        // 收起/展开都按目标逻辑宽度算坐标，绝不读取可能过期的窗口尺寸。
        assert_eq!(edge_x(2560, 44.0, 2.0), 2472);
        assert_eq!(edge_x(2560, 360.0, 2.0), 1840);
        assert!(edge_x(2560, 44.0, 2.0) > edge_x(2560, 360.0, 2.0), "收起态更靠右");
        assert_eq!(edge_x(1440, 360.0, 1.0), 1080);
        // 屏幕比窗口窄时不能算出负坐标。
        assert_eq!(edge_x(100, 360.0, 1.0), 0);
        // Retina 缩放：逻辑 360pt 在 2x 下占 720px。
        assert_eq!(edge_x(2880, 360.0, 2.0), 2160);
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
