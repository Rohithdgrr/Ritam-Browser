//! Chrome webview attachment and window layout (Rohan).
//!
//! The window itself has no webview: it is created bare and gets children —
//! the chrome (app origin) pinned to the top strip, and one content webview
//! per tab filling the rest (Tauri's multi-webview API, the `unstable`
//! feature — see PLAN.md Request 3 for the risk note).

use tauri::{
    AppHandle, LogicalPosition, LogicalSize, Manager, PhysicalSize, Position, Rect, Size, Webview,
    WebviewBuilder, WebviewUrl, Window, Wry,
};

/// Height of the chrome strip in logical pixels: tab strip (40) +
/// toolbar (44) + status bar (24), matching `shell/shell.css`.
pub const CHROME_HEIGHT: f64 = 108.0;

/// Smallest usable content height, so the window can never squeeze a tab
/// into nothing.
const MIN_CONTENT_HEIGHT: f64 = 120.0;

/// Logical (DPI-independent) inner size of the window.
pub fn window_logical_size(window: &Window<Wry>) -> (f64, f64) {
    let scale = window.scale_factor().unwrap_or(1.0);
    let size = window
        .inner_size()
        .unwrap_or(PhysicalSize::new(1180, 760));
    (size.width as f64 / scale, size.height as f64 / scale)
}

/// Create the chrome webview as the window's first child.
pub fn attach_chrome(window: &Window<Wry>) -> Result<Webview<Wry>, tauri::Error> {
    let (width, _) = window_logical_size(window);
    window.add_child(
        WebviewBuilder::new(
            "chrome",
            WebviewUrl::App(std::path::PathBuf::from("index.html")),
        ),
        LogicalPosition::new(0.0, 0.0),
        LogicalSize::new(width, CHROME_HEIGHT),
    )
}

/// Where a content tab webview belongs: below the chrome, full width.
pub fn content_bounds(window: &Window<Wry>) -> Rect {
    let (width, height) = window_logical_size(window);
    Rect {
        position: Position::Logical(LogicalPosition::new(0.0, CHROME_HEIGHT)),
        size: Size::Logical(LogicalSize::new(
            width,
            (height - CHROME_HEIGHT).max(MIN_CONTENT_HEIGHT),
        )),
    }
}

/// Resize the chrome strip and every tab webview. Dimensions arrive in
/// *physical* pixels (from `WindowEvent::Resized`); conversion happens here,
/// on the drainer thread, so the UI thread never issues a dispatcher call of
/// its own. Runs on the drainer, never on the UI thread itself.
pub fn relayout(app: &AppHandle<Wry>, tabs: &[Webview<Wry>], physical_w: f64, physical_h: f64) {
    let scale = app
        .get_window("main")
        .and_then(|w| w.scale_factor().ok())
        .unwrap_or(1.0);
    let width = physical_w / scale;
    let height = physical_h / scale;
    let content_h = (height - CHROME_HEIGHT).max(MIN_CONTENT_HEIGHT);
    if let Some(chrome) = app.get_webview("chrome") {
        let _ = chrome.set_bounds(Rect {
            position: Position::Logical(LogicalPosition::new(0.0, 0.0)),
            size: Size::Logical(LogicalSize::new(width, CHROME_HEIGHT)),
        });
    }
    let bounds = Rect {
        position: Position::Logical(LogicalPosition::new(0.0, CHROME_HEIGHT)),
        size: Size::Logical(LogicalSize::new(width, content_h)),
    };
    for tab in tabs {
        let _ = tab.set_bounds(bounds.clone());
    }
}

/// Real WebView2 runtime version from the OS, or `None` if it cannot be
/// determined — never assumed (contract §3 `runtime_info`).
pub fn webview2_version() -> Option<String> {
    tauri::webview_version().ok()
}
