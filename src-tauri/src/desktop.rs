//! Desktop lifetime belongs to the tray, not the visibility of the main window.

use std::sync::Mutex;
use std::time::Duration;
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    App, AppHandle, Emitter, Manager, Window, WindowEvent,
};

const TRAY_ID: &str = "hexglow-tray";
const SHOW_ID: &str = "hexglow-show";
const QUIT_ID: &str = "hexglow-quit";
const EXIT_TIMEOUT: Duration = Duration::from_secs(10);
const BACKGROUND_TICK_INTERVAL: Duration = Duration::from_secs(1);

#[derive(Default)]
struct ExitState {
    frontend_ready: bool,
    next_request: u64,
    pending: Option<u64>,
}

#[derive(Debug, PartialEq)]
enum ExitRequest {
    Immediate,
    AlreadyPending,
    Save(u64),
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum ExitSource {
    Tray,
    MainWindow,
}

impl ExitState {
    fn request_from(&mut self, source: ExitSource) -> Result<ExitRequest, String> {
        // A visible frontend must never bypass its not-yet-installed save listener.
        if source == ExitSource::MainWindow && !self.frontend_ready {
            return Err("应用正在准备保存保护，请稍后再点击完全退出。".into());
        }
        Ok(self.request())
    }

    fn request(&mut self) -> ExitRequest {
        if !self.frontend_ready {
            return ExitRequest::Immediate;
        }
        if self.pending.is_some() {
            return ExitRequest::AlreadyPending;
        }
        self.next_request += 1;
        self.pending = Some(self.next_request);
        ExitRequest::Save(self.next_request)
    }

    fn finish(&mut self, request: u64) -> bool {
        if self.pending != Some(request) {
            return false;
        }
        self.pending = None;
        true
    }
}

#[derive(Default)]
struct DesktopState(Mutex<ExitState>);

fn trace(app: &AppHandle, level: &str, event: &str, message: &str) {
    crate::collector::log_event(app, level, event, message);
}

fn require_main_window(label: &str) -> Result<(), String> {
    if label == "main" {
        Ok(())
    } else {
        Err("只有主窗口可以处理应用退出".into())
    }
}

fn cancel_exit(app: &AppHandle, request: u64, reason: &str, message: &str) {
    let state = app.state::<DesktopState>();
    let Ok(mut exit) = state.0.lock() else {
        return;
    };
    if !exit.finish(request) {
        return;
    }
    drop(exit);
    // Never log frontend error text: it can contain paths or private session data.
    trace(
        app,
        "warn",
        "desktop-exit-cancel",
        &format!("requestId={request} reason={reason}; app remains running"),
    );
    show_main(app);
    let _ = app.emit_to(
        "main",
        "app:exit-error",
        serde_json::json!({ "requestId": request, "message": message }),
    );
}

fn request_exit(app: &AppHandle, source: ExitSource) -> Result<(), String> {
    let state = app.state::<DesktopState>();
    let mut exit = state.0.lock().map_err(|_| "退出状态不可用，请重试")?;
    let decision = exit.request_from(source)?;
    drop(exit);
    trace(
        app,
        "info",
        "desktop-exit-request",
        &format!("source={source:?} action={decision:?}"),
    );
    let request = match decision {
        ExitRequest::Immediate => {
            app.exit(0);
            return Ok(());
        }
        ExitRequest::AlreadyPending => return Ok(()),
        ExitRequest::Save(request) => request,
    };
    if app
        .emit_to(
            "main",
            "app:before-exit",
            serde_json::json!({ "requestId": request }),
        )
        .is_err()
    {
        let message = "未能通知主窗口保存，本次退出已取消，请重试。";
        cancel_exit(app, request, "notify-failed", message);
        return Err(message.into());
    }
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(EXIT_TIMEOUT);
        cancel_exit(
            &app,
            request,
            "save-timeout",
            "保存对局超过 10 秒，本次退出已取消。请等待保存完成后再退出。",
        );
    });
    Ok(())
}

/// Explicit in-app exit and tray exit use the same save-before-exit protocol.
#[tauri::command]
pub fn desktop_request_exit(window: Window) -> Result<(), String> {
    require_main_window(window.label())?;
    request_exit(window.app_handle(), ExitSource::MainWindow)
}

/// Register only after the frontend has installed its save-before-exit listener.
#[tauri::command]
pub fn desktop_ready(window: Window) -> Result<(), String> {
    require_main_window(window.label())?;
    let state = window.state::<DesktopState>();
    let mut exit = state.0.lock().map_err(|_| "退出状态不可用")?;
    let first_connection = !exit.frontend_ready;
    exit.frontend_ready = true;
    drop(exit);
    if first_connection {
        trace(
            window.app_handle(),
            "info",
            "desktop-ready",
            "save listener ready",
        );
        // JS timers can be throttled when WebView2 is hidden. Dispatch the poll
        // wake-up from a native thread so tray/background collection keeps its
        // cadence without relying on unsupported browser command-line flags.
        let app = window.app_handle().clone();
        std::thread::spawn(move || loop {
            std::thread::sleep(BACKGROUND_TICK_INTERVAL);
            if app.get_webview_window("main").is_none() {
                break;
            }
            let _ = app.emit_to("main", "app:background-tick", ());
        });
    }
    Ok(())
}

#[tauri::command]
pub fn desktop_exit_ready(
    window: Window,
    request_id: u64,
    error: Option<String>,
) -> Result<(), String> {
    require_main_window(window.label())?;
    if let Some(error) = error {
        cancel_exit(
            window.app_handle(),
            request_id,
            "frontend-error",
            &format!("保存失败，应用仍在运行：{error}"),
        );
        return Ok(());
    }
    let state = window.state::<DesktopState>();
    let mut exit = state.0.lock().map_err(|_| "退出状态不可用")?;
    if !exit.finish(request_id) {
        return Err("本次退出已取消，请重新选择退出 Hexglow".into());
    }
    drop(exit);
    trace(
        window.app_handle(),
        "info",
        "desktop-exit-complete",
        &format!("requestId={request_id}; saved and exiting"),
    );
    window.app_handle().exit(0);
    Ok(())
}

/// Used both by the tray and by a subsequent launch of the application.
pub fn show_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

pub fn setup(app: &App) -> Result<(), Box<dyn std::error::Error>> {
    app.manage(DesktopState::default());
    let show = MenuItem::with_id(app, SHOW_ID, "打开 Hexglow", true, None::<&str>)?;
    let background = MenuItem::new(app, "关闭主窗口后仍在后台运行", false, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, QUIT_ID, "退出 Hexglow", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &background, &separator, &quit])?;
    let icon = app.default_window_icon().ok_or("应用缺少托盘图标")?.clone();
    TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon)
        .tooltip("Hexglow · 后台运行中，单击打开；右键退出")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            SHOW_ID => show_main(app),
            QUIT_ID => {
                if request_exit(app, ExitSource::Tray).is_err() {
                    trace(app, "error", "desktop-exit-request", "tray request failed");
                    show_main(app);
                }
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if matches!(
                event,
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                }
            ) {
                show_main(tray.app_handle());
            }
        })
        .build(app)?;
    trace(app.handle(), "info", "desktop-tray", "tray icon created");
    Ok(())
}

pub fn on_window_event(window: &Window, event: &WindowEvent) {
    // Overlay close requests keep their existing semantics. Do not intercept an
    // explicit app.exit(), which must also work for installation and updates.
    if window.label() == "main" {
        if let WindowEvent::CloseRequested { api, .. } = event {
            // Only keep the process alive after a successful hide and while a
            // tray exists, so a platform failure cannot strand an invisible app.
            if window.app_handle().tray_by_id(TRAY_ID).is_some() && window.hide().is_ok() {
                api.prevent_close();
                trace(
                    window.app_handle(),
                    "info",
                    "desktop-window-hide",
                    "main hidden; app remains in tray",
                );
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loaded_frontend_must_save_once_before_exit() {
        let mut state = ExitState::default();
        assert_eq!(state.request(), ExitRequest::Immediate);
        state.frontend_ready = true;
        assert_eq!(state.request(), ExitRequest::Save(1));
        assert_eq!(state.request(), ExitRequest::AlreadyPending);
        assert!(!state.finish(0));
        assert_eq!(state.pending, Some(1));
        assert!(state.finish(1));
        assert!(!state.finish(1));
    }

    #[test]
    fn in_app_exit_requires_main_window_and_ready_save_listener() {
        assert!(require_main_window("main").is_ok());
        assert!(require_main_window("overlay").is_err());
        assert!(require_main_window("").is_err());
        let mut state = ExitState::default();
        assert!(state.request_from(ExitSource::MainWindow).is_err());
        assert_eq!(state.pending, None);
        state.frontend_ready = true;
        assert_eq!(
            state.request_from(ExitSource::MainWindow),
            Ok(ExitRequest::Save(1))
        );
        assert_eq!(
            state.request_from(ExitSource::Tray),
            Ok(ExitRequest::AlreadyPending)
        );
    }

    #[test]
    fn cancelled_quit_cannot_acknowledge_or_cancel_later_quit() {
        let mut state = ExitState {
            frontend_ready: true,
            ..Default::default()
        };
        assert_eq!(state.request(), ExitRequest::Save(1));
        assert!(state.finish(1)); // Timed out or save failed: keep running.
        assert_eq!(state.request(), ExitRequest::Save(2));
        assert!(!state.finish(1)); // Late save result or old timeout.
        assert_eq!(state.pending, Some(2));
        assert!(state.finish(2));
    }
}
