//! Tab webview management — interim strategy (ADR-006).
//!
//! Milestone 1 renders pages in *frameless, taskbar-less* native windows that are
//! positioned over the main window's web content region and shown/hidden as tabs
//! switch. This uses only stable Tauri 2 APIs so the scaffold builds today.
//!
//! KNOWN LIMITATIONS (tracked in docs/ENGINE_SPIKE.md):
//! - Clicking a page focuses the tab window; the main chrome keeps its layout
//!   but OS-level shortcut quirks may occur.
//! - Tab windows are not minimized with the main window on every platform.
//! - Per-tab process isolation and memory accounting are engine concerns.
//!
//! The child-webview approach (single window, embedded views) is the intended
//! fix and is gated behind the Phase-0 spike — this module is the ONLY place
//! that needs to change when the engine decision lands.

use std::collections::HashMap;
use std::sync::Mutex;

use tauri::{
    AppHandle, LogicalPosition, LogicalSize, Manager, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};

use crate::error::AppError;

#[derive(Debug, Clone)]
pub struct LayoutState {
    /// Offset of the web region relative to the main window's origin (logical px).
    pub offset_x: f64,
    pub offset_y: f64,
    pub width: f64,
    pub height: f64,
    /// false → the shell is showing a non-browser view (home, settings, …): hide all tab windows.
    pub visible: bool,
    pub active: Option<String>,
}

impl Default for LayoutState {
    fn default() -> Self {
        Self { offset_x: 0.0, offset_y: 48.0, width: 1000.0, height: 700.0, visible: false, active: None }
    }
}

pub struct TabWindowManager {
    windows: Mutex<HashMap<String, WebviewWindow>>,
    layout: Mutex<LayoutState>,
}

impl TabWindowManager {
    pub fn new() -> Self {
        Self { windows: Mutex::new(HashMap::new()), layout: Mutex::new(LayoutState::default()) }
    }

    fn windows(&self) -> std::sync::MutexGuard<'_, HashMap<String, WebviewWindow>> {
        self.windows.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn layout(&self) -> LayoutState {
        self.layout.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    /// Store the new layout and re-apply window bounds/visibility immediately.
    pub fn set_layout(&self, layout: LayoutState, app: &AppHandle) {
        *self.layout.lock().unwrap_or_else(|e| e.into_inner()) = layout;
        self.apply(app);
    }

    /// Re-apply bounds/visibility from the stored layout. Called on move/resize/focus too.
    pub fn apply(&self, app: &AppHandle) {
        let layout = self.layout();
        let Ok(main) = app
            .get_webview_window("main")
            .ok_or_else(|| ())
        else {
            return;
        };
        let scale = main.scale_factor().unwrap_or(1.0);
        let outer = main.outer_position().unwrap_or_else(|_| tauri::PhysicalPosition::new(0, 0));
        let base_x = outer.x as f64 / scale;
        let base_y = outer.y as f64 / scale;

        for (tab_id, window) in self.windows().iter() {
            if layout.visible && layout.active.as_deref() == Some(tab_id.as_str()) {
                let _ = window.set_position(LogicalPosition::new(base_x + layout.offset_x, base_y + layout.offset_y));
                let _ = window.set_size(LogicalSize::new(layout.width.max(1.0), layout.height.max(1.0)));
                let _ = window.show();
            } else {
                let _ = window.hide();
            }
        }
    }

    /// Navigate a tab to a (validated) URL, recreating its native window.
    /// Typing a new URL is a full navigation anyway, so view state reset is expected.
    pub fn navigate(&self, app: &AppHandle, tab_id: &str, url: &str) -> Result<(), AppError> {
        self.close_window(tab_id);

        // Internal pages render in the shell, not in a native window.
        if url == "govind://home" || url == "about:blank" {
            return Ok(());
        }

        let parsed = tauri::Url::parse(url)
            .map_err(|e| AppError::InvalidInput(format!("invalid url: {e}")))?;

        let label = format!("tab-{tab_id}");
        let window = WebviewWindowBuilder::new(app, &label, WebviewUrl::External(parsed))
            .title("Govind Tab")
            .decorations(false)
            .skip_taskbar(true)
            .resizable(true)
            .focused(false)
            .visible(false)
            .build()
            .map_err(|e| AppError::Window(e.to_string()))?;

        self.windows().insert(tab_id.to_string(), window);
        self.apply(app);
        Ok(())
    }

    pub fn close_window(&self, tab_id: &str) {
        if let Some(window) = self.windows().remove(tab_id) {
            let _ = window.close();
        }
    }

    pub fn close_all(&self) {
        let drained: Vec<WebviewWindow> = self.windows().drain().map(|(_, w)| w).collect();
        for window in drained {
            let _ = window.close();
        }
    }

    /// Run JS inside a tab window (used for back/forward/reload).
    pub fn eval_tab(&self, tab_id: &str, js: &str) {
        if let Some(window) = self.windows().get(tab_id) {
            let _ = window.eval(js);
        }
    }
}

impl Default for TabWindowManager {
    fn default() -> Self {
        Self::new()
    }
}
