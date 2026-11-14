mod commands;
mod db;
mod error;
mod models;
mod navigation;
mod webview;

use tauri::{Emitter, Manager, WindowEvent};
use tauri_plugin_global_shortcut::{Builder as ShortcutBuilder, GlobalShortcutExt, ShortcutState};

use webview::TabWebviewManager;

/// Browser shortcuts that must work even while a *page* has the keyboard focus
/// (a child webview swallows key events, so the shell never sees them).
/// The handler only acts while the Govind window is focused.
const SHORTCUTS: &[(&str, &str)] = &[
    ("Ctrl+T", "new-tab"),
    ("Ctrl+W", "close-tab"),
    ("Ctrl+K", "palette"),
    ("Ctrl+L", "focus-omnibar"),
    ("Ctrl+R", "reload"),
    ("Ctrl+D", "bookmark"),
    ("Ctrl+F", "find"),
    ("F11", "fullscreen"),
    ("Ctrl+,", "settings"),
    ("Ctrl+1", "tab-1"),
    ("Ctrl+2", "tab-2"),
    ("Ctrl+3", "tab-3"),
    ("Ctrl+4", "tab-4"),
    ("Ctrl+5", "tab-5"),
    ("Ctrl+6", "tab-6"),
    ("Ctrl+7", "tab-7"),
    ("Ctrl+8", "tab-8"),
    ("Ctrl+9", "tab-9"),
    ("Ctrl+Tab", "next-tab"),
    ("Ctrl+Shift+Tab", "prev-tab"),
    ("Alt+Left", "back"),
    ("Alt+Right", "forward"),
];

fn main_window_focused(app: &tauri::AppHandle) -> bool {
    // The raw `Window` is used on purpose: `get_webview_window` returns `None`
    // once the window hosts child webviews (the tab views).
    app.get_window("main")
        .map(|w| w.is_focused().unwrap_or(false))
        .unwrap_or(false)
}

fn register_shortcuts(app: &tauri::AppHandle) {
    let manager = app.global_shortcut();
    // Idempotent: drop any previous registration before (re-)adding them.
    let _ = manager.unregister_all();
    for (accel, _) in SHORTCUTS {
        if let Err(err) = manager.register(*accel) {
            log::warn!("could not register global shortcut {accel}: {err}");
        }
    }
}

fn unregister_shortcuts(app: &tauri::AppHandle) {
    let _ = app.global_shortcut().unregister_all();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Block auto-playing media before any webview exists (WebView2 reads this
    // env var). Append to — never clobber — developer-provided flags.
    let existing =
        std::env::var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS").unwrap_or_default();
    if !existing.contains("autoplay-policy") {
        std::env::set_var(
            "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
            format!("{existing} --autoplay-policy=user-gesture-required").trim(),
        );
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|_app, _argv, _cwd| {
            // Second launch: focus the existing window instead of opening a new one.
            // (State access here is intentionally minimal.)
        }))
        .plugin(tauri_plugin_log::Builder::new().build())
        .plugin(tauri_plugin_shell::init())
        .plugin(
            ShortcutBuilder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state() != ShortcutState::Pressed {
                        return;
                    }
                    if !main_window_focused(app) {
                        return;
                    }
                    let accel = shortcut.to_string();
                    if let Some((_, action)) = SHORTCUTS
                        .iter()
                        .find(|(a, _)| a.eq_ignore_ascii_case(&accel))
                    {
                        let _ = app.emit("shortcut", *action);
                    }
                })
                .build(),
        )
        .manage(TabWebviewManager::new())
        .setup(|app| {
            let db = db::init(app.handle())?;
            app.manage(db);

            let app_handle = app.handle().clone();
            if let Some(main) = app.get_window("main") {
                main.on_window_event(move |event| match event {
                    // Child webviews keep their own size, so re-apply on resize.
                    WindowEvent::Resized(_) | WindowEvent::Focused(true) => {
                        app_handle.state::<TabWebviewManager>().apply();
                        register_shortcuts(&app_handle);
                    }
                    WindowEvent::Focused(false) => {
                        // Do not swallow browser shortcuts in other applications.
                        unregister_shortcuts(&app_handle);
                    }
                    // When the main window is closing, tear down all tab webviews.
                    WindowEvent::CloseRequested { .. } => {
                        app_handle.state::<TabWebviewManager>().close_all();
                    }
                    _ => {}
                });
            }
            register_shortcuts(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // Tabs & navigation
            commands::tabs::create_tab,
            commands::tabs::list_tabs,
            commands::tabs::activate_tab,
            commands::tabs::close_tab,
            commands::tabs::navigate_tab,
            commands::tabs::update_tab_meta,
            commands::tabs::toggle_pin_tab,
            commands::tabs::reorder_tab,
            commands::tabs::go_back,
            commands::tabs::go_forward,
            commands::tabs::reload_tab,
            commands::tabs::print_tab,
            commands::tabs::zoom_tab,
            commands::tabs::find_in_tab,
            commands::tabs::inspect_tab,
            commands::tabs::duplicate_tab,
            commands::tabs::close_other_tabs,
            commands::tabs::sync_tab_windows,
            // Workspaces
            commands::workspaces::create_workspace,
            commands::workspaces::list_workspaces,
            commands::workspaces::rename_workspace,
            commands::workspaces::delete_workspace,
            commands::workspaces::set_active_workspace,
            // Bookmarks, history, notes, downloads
            commands::data::list_bookmarks,
            commands::data::save_bookmark,
            commands::data::delete_bookmark,
            commands::data::toggle_favorite,
            commands::data::search_history,
            commands::data::add_history_entry,
            commands::data::delete_history_entry,
            commands::data::save_note,
            commands::data::list_notes,
            commands::data::delete_note,
            commands::data::list_downloads,
            commands::data::record_download,
            commands::data::clear_downloads,
            commands::data::remove_download,
            // Settings & privacy
            commands::settings::get_settings,
            commands::settings::set_setting,
            commands::settings::clear_browsing_data,
            commands::settings::list_site_permissions,
            commands::settings::set_site_permission,
            commands::settings::clear_site_permissions,
            commands::settings::get_app_info,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Govind Browser");
}
