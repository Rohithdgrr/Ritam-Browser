//! Tab webview management — the browser core.
//!
//! Every tab owns one **child webview** that lives inside the main window
//! (`Window::add_child`, Tauri 2 `unstable` feature) and is positioned over the
//! shell's web-content region. Switching tabs shows/hides those views, so the
//! whole browser is a single native window: no stray taskbar entries, no
//! focus traps between windows, and page state survives tab switches.
//!
//! Security: a child webview inherits the parent window's label, but Tauri's
//! ACL only grants the app's commands to *local* origins — a remote page can
//! never invoke a single Govind command (see `capabilities/default.json`).
//!
//! Windows note: creating a WebView2 controller from inside a webview message
//! handler deadlocks, so every command that creates a webview is `async` and
//! runs on Tauri's async runtime instead of the UI thread.

use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard};

use serde_json::json;
use tauri::{
  AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Url, Webview, WebviewUrl,
};
use tauri::webview::{DownloadEvent, NewWindowResponse, PageLoadEvent};

use crate::error::AppError;

/// Region of the main window (client-area coordinates) covered by the webview.
#[derive(Debug, Clone)]
pub struct LayoutState {
  pub offset_x: f64,
  pub offset_y: f64,
  pub width: f64,
  pub height: f64,
  /// false → the shell shows a non-browser view (home, settings …): hide every webview.
  pub visible: bool,
  pub active: Option<String>,
}

impl Default for LayoutState {
  fn default() -> Self {
    Self {
      offset_x: 0.0,
      offset_y: 80.0,
      width: 1000.0,
      height: 700.0,
      visible: false,
      active: None,
    }
  }
}

pub struct TabWebviewManager {
  webviews: Mutex<HashMap<String, Webview>>,
  layout: Mutex<LayoutState>,
}

impl TabWebviewManager {
  pub fn new() -> Self {
    Self {
      webviews: Mutex::new(HashMap::new()),
      layout: Mutex::new(LayoutState::default()),
    }
  }

  fn webviews(&self) -> MutexGuard<'_, HashMap<String, Webview>> {
    // A poisoned mutex still holds a valid map — keep serving.
    self.webviews.lock().unwrap_or_else(|e| e.into_inner())
  }

  fn layout(&self) -> LayoutState {
    self.layout.lock().unwrap_or_else(|e| e.into_inner()).clone()
  }

  /// Store the new layout and re-apply bounds/visibility immediately.
  pub fn set_layout(&self, layout: LayoutState, _app: &AppHandle) {
    *self.layout.lock().unwrap_or_else(|e| e.into_inner()) = layout;
    self.apply();
  }

  /// Show the active tab's webview over the web region; hide the others.
  pub fn apply(&self) {
    let layout = self.layout();
    // Clone the handles first so the lock is not held across runtime calls.
    let views: Vec<(String, Webview)> = self
      .webviews()
      .iter()
      .map(|(id, webview)| (id.clone(), webview.clone()))
      .collect();

    for (tab_id, webview) in views {
      let active = layout.visible && layout.active.as_deref() == Some(tab_id.as_str());
      if active {
        let _ = webview.set_position(LogicalPosition::new(layout.offset_x, layout.offset_y));
        let _ = webview.set_size(LogicalSize::new(layout.width.max(1.0), layout.height.max(1.0)));
        let _ = webview.show();
      } else {
        let _ = webview.hide();
      }
    }
  }

  /// Navigate a tab.
  ///
  /// The existing webview is reused so page state (scroll position, form input)
  /// survives navigation; a new one is created on first use. Internal pages
  /// (`govind://home`) are rendered by the shell, so their webview is dropped.
  pub async fn navigate(&self, app: &AppHandle, tab_id: &str, url: &str) -> Result<(), AppError> {
    // Internal pages (govind://…) are rendered by the shell, so the tab's
    // webview is dropped and the shell takes over the content region.
    if crate::navigation::is_internal_url(url) || url.eq_ignore_ascii_case("about:blank") {
      self.close_view(tab_id);
      return Ok(());
    }

    let parsed =
      Url::parse(url).map_err(|e| AppError::InvalidInput(format!("invalid url: {e}")))?;

    if let Some(webview) = self.webviews().get(tab_id) {
      let _ = webview.navigate(parsed);
      return Ok(());
    }

    self.create_view(app, tab_id, parsed).await
  }

  /// Create the child webview for a tab.
  ///
  /// Runs on Tauri's async runtime (the caller is an `async` command) — on
  /// Windows this *must* not happen on the UI thread.
  async fn create_view(
    &self,
    app: &AppHandle,
    tab_id: &str,
    url: Url,
  ) -> Result<(), AppError> {
    // NOTE: `get_webview_window("main")` returns `None` as soon as the window
    // hosts child webviews (Tauri only exposes a *WebviewWindow* when all of
    // its webviews share the window label), so the raw `Window` is used here.
    let Some(window) = app.get_window("main") else {
      return Err(AppError::Window("main window not found".into()));
    };

    let layout = self.layout();
    let position = LogicalPosition::new(layout.offset_x, layout.offset_y);
    let size = LogicalSize::new(layout.width.max(1.0), layout.height.max(1.0));

    let nav_id = tab_id.to_string();
    let title_id = tab_id.to_string();
    let load_id = tab_id.to_string();
    let download_id = tab_id.to_string();
    let popup_id = tab_id.to_string();

    let nav_handle = app.clone();
    let title_handle = app.clone();
    let load_handle = app.clone();
    let download_handle = app.clone();
    let popup_handle = app.clone();

    let builder = tauri::webview::WebviewBuilder::new(format!("tab-{tab_id}"), WebviewUrl::External(url))
      .on_navigation(move |url| {
        // Only real web pages may be loaded — no javascript:, file:, data:.
        if !is_page_url(url) {
          return false;
        }
        let _ = nav_handle.emit(
          "tab-url-changed",
          json!({ "tabId": nav_id, "url": url.to_string() }),
        );
        true
      })
      .on_document_title_changed(move |_webview, title| {
        let _ = title_handle.emit(
          "tab-title-changed",
          json!({ "tabId": title_id, "title": title }),
        );
      })
      .on_page_load(move |_webview, payload| {
        let event = match payload.event() {
          PageLoadEvent::Started => "tab-load-started",
          PageLoadEvent::Finished => "tab-load-finished",
        };
        let _ = load_handle.emit(
          event,
          json!({ "tabId": load_id, "url": payload.url().to_string() }),
        );
      })
      .on_download(move |_webview, event| {
        match event {
          DownloadEvent::Requested { url, destination } => {
            let _ = download_handle.emit(
              "download-started",
              json!({
                "tabId": download_id,
                "url": url.to_string(),
                "filename": destination.file_name().map(|n| n.to_string_lossy().to_string()),
              }),
            );
            true // allow the download
          }
          DownloadEvent::Finished { url, path, success } => {
            let _ = download_handle.emit(
              "download-finished",
              json!({
                "tabId": download_id,
                "url": url.to_string(),
                "path": path.map(|p| p.to_string_lossy().to_string()),
                "success": success,
              }),
            );
            true
          }
          _ => true,
        }
      })
      .on_new_window(move |url, _features| {
        // Pop-ups become new tabs in the UI instead of native windows.
        let _ = popup_handle.emit(
          "tab-new-window",
          json!({ "tabId": popup_id, "url": url.to_string() }),
        );
        NewWindowResponse::Deny
      });

    let webview = window
      .add_child(builder, position, size)
      .map_err(|e| AppError::Window(e.to_string()))?;

    // Start hidden: the tab becomes visible when it is activated.
    let _ = webview.hide();
    self.webviews().insert(tab_id.to_string(), webview);
    self.apply();
    Ok(())
  }

  /// Destroy a tab's webview (tab closed, or the tab returned to the home page).
  pub fn close_view(&self, tab_id: &str) {
    if let Some(webview) = self.webviews().remove(tab_id) {
      let _ = webview.close();
    }
  }

  pub fn close_all(&self) {
    let drained: Vec<Webview> = self.webviews().drain().map(|(_, w)| w).collect();
    for webview in drained {
      let _ = webview.close();
    }
  }

  /// Run JS inside a tab's webview (used for back/forward).
  pub fn eval_tab(&self, tab_id: &str, js: &str) {
    if let Some(webview) = self.webviews().get(tab_id) {
      let _ = webview.eval(js);
    }
  }

  /// Reload a tab's webview natively.
  pub fn reload_tab(&self, tab_id: &str) {
    if let Some(webview) = self.webviews().get(tab_id) {
      let _ = webview.reload();
    }
  }

  /// Print the page of a tab (not the shell chrome).
  pub fn print_tab(&self, tab_id: &str) {
    if let Some(webview) = self.webviews().get(tab_id) {
      let _ = webview.print();
    }
  }

  /// Set the zoom factor of a tab's page (1.0 = 100%).
  pub fn set_zoom(&self, tab_id: &str, factor: f64) {
    let factor = factor.clamp(0.25, 3.0);
    if let Some(webview) = self.webviews().get(tab_id) {
      let _ = webview.set_zoom(factor);
    }
  }

  /// The URL currently loaded in a tab (empty when the tab has no webview).
  #[allow(dead_code)]
  pub fn url_of(&self, tab_id: &str) -> Option<String> {
    self
      .webviews()
      .get(tab_id)
      .and_then(|webview| webview.url().ok())
      .map(|url| url.to_string())
  }
}

impl Default for TabWebviewManager {
  fn default() -> Self {
    Self::new()
  }
}

/// Only http(s) pages may be loaded in a tab webview.
fn is_page_url(url: &Url) -> bool {
  matches!(url.scheme(), "http" | "https")
}
