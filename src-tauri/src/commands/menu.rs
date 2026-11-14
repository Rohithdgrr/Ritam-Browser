use tauri::{
    menu::{ContextMenu, MenuBuilder},
    AppHandle, LogicalPosition, Manager,
};

#[tauri::command]
pub fn show_more_menu(app: AppHandle, x: f64, y: f64) -> Result<(), String> {
    let window = app
        .get_window("main")
        .ok_or_else(|| "main window not found".to_string())?;
    let menu = MenuBuilder::new(&app)
        .text("menu-new-tab", "New Tab")
        .text("menu-new-private-tab", "New Private Tab")
        .text("menu-recently-closed", "Recently closed")
        .text("menu-history", "History")
        .text("menu-downloads", "Downloads")
        .text("menu-bookmarks", "Bookmarks and lists")
        .text("menu-reading-list", "Reading list")
        .text("menu-save-for-later", "Save page for later")
        .text("menu-task-manager", "Task manager")
        .text("menu-guest-mode", "Toggle guest mode")
        .separator()
        .text("menu-mute-active-tab", "Mute / unmute active tab")
        .text("menu-force-dark-websites", "Toggle forced dark websites")
        .text("menu-translate-page", "Translate / show original")
        .text("menu-read-aloud", "Read aloud / stop")
        .text("menu-fullscreen", "Toggle fullscreen")
        .separator()
        .text("menu-zoom-in", "Zoom in")
        .text("menu-zoom-out", "Zoom out")
        .text("menu-zoom-reset", "Reset zoom")
        .separator()
        .text("menu-print", "Print / Save as PDF...")
        .text("menu-clear-site-data", "Clear cookies and site data for this page")
        .text("menu-clear-data", "Delete browsing data...")
        .text("menu-settings", "Settings...")
        .separator()
        .text("menu-about", "About Govind")
        .build()
        .map_err(|error| error.to_string())?;

    menu.popup_at(window, LogicalPosition::new((x - 300.0).max(0.0), y))
    .map_err(|error| error.to_string())
}
