mod commands;
mod adblocker;
mod db;
mod error;
mod models;
mod navigation;
mod webview;
#[cfg(windows)]
mod webview2_blocker;

use tauri::{Emitter, Manager, WindowEvent};
#[cfg(desktop)]
use tauri_plugin_global_shortcut::{Builder as ShortcutBuilder, GlobalShortcutExt, ShortcutState};
use rusqlite::OptionalExtension;

use webview::TabWebviewManager;

/// Browser shortcuts that must work even while a *page* has the keyboard focus
/// (a child webview swallows key events, so the shell never sees them).
/// The handler only acts while the Ritam window is focused.
#[cfg(desktop)]
const SHORTCUTS: &[(&str, &str)] = &[
    ("Ctrl+T", "new-tab"),
    ("Ctrl+Shift+N", "new-private-tab"),
    ("Ctrl+Shift+T", "undo-close"),
    ("Ctrl+W", "close-tab"),
    ("Ctrl+K", "palette"),
    ("Ctrl+L", "focus-omnibar"),
    ("Ctrl+R", "reload"),
    ("Ctrl+D", "bookmark"),
    ("Ctrl+F", "find"),
    ("Ctrl+P", "print"),
    ("Ctrl+Shift+A", "tab-search"),
    ("Alt+Shift+M", "mute-tab"),
    ("Alt+Shift+D", "force-dark-websites"),
    ("Alt+Shift+T", "translate-page"),
    ("Alt+Shift+R", "read-aloud"),
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

#[cfg(desktop)]
fn main_window_focused(app: &tauri::AppHandle) -> bool {
    // The raw `Window` is used on purpose: `get_webview_window` returns `None`
    // once the window hosts child webviews (the tab views).
    app.get_window("main")
        .map(|w| w.is_focused().unwrap_or(false))
        .unwrap_or(false)
}

#[cfg(desktop)]
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

#[cfg(not(desktop))]
fn register_shortcuts(_app: &tauri::AppHandle) {}

#[cfg(desktop)]
fn unregister_shortcuts(app: &tauri::AppHandle) {
    let _ = app.global_shortcut().unregister_all();
}

#[cfg(not(desktop))]
fn unregister_shortcuts(_app: &tauri::AppHandle) {}

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

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_log::Builder::new().build())
        .plugin(tauri_plugin_shell::init())
        // Native open/save dialogs for bookmark import/export.
        .plugin(tauri_plugin_dialog::init());

    // Single-instance enforcement and global keyboard shortcuts are desktop
    // concepts — neither plugin API exists on Android/iOS.
    #[cfg(desktop)]
    let builder = builder
        .plugin(tauri_plugin_single_instance::init(|_app, _argv, _cwd| {
            // Second launch: focus the existing window instead of opening a new one.
            // (State access here is intentionally minimal.)
        }))
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
        );

    builder
        .manage(TabWebviewManager::new())
        .setup(|app| {
            #[cfg(desktop)]
            app.on_menu_event(|app, event| {
                let id = event.id().as_ref();
                if id.starts_with("menu-") {
                    if let Err(error) = app.emit_to("main", "more-menu-action", id.to_string()) {
                        log::warn!("could not forward browser menu action: {error}");
                    }
                }
            });

            let db = db::init(app.handle())?;
            app.manage(db);

            let blocker = app.state::<TabWebviewManager>().network_blocker();
            let network_blocking = app
                .state::<db::DbState>()
                .conn()
                .query_row(
                    "SELECT value FROM settings WHERE key = 'network_blocking'",
                    [],
                    |row| row.get::<_, String>(0),
                )
                .optional()?
                .as_deref()
                != Some("false");
            blocker.set_enabled(network_blocking);
            let blocker_allowlist = app
                .state::<db::DbState>()
                .conn()
                .query_row(
                    "SELECT value FROM settings WHERE key = 'adblock_allowlist'",
                    [],
                    |row| row.get::<_, String>(0),
                )
                .optional()?
                .unwrap_or_default();
            blocker.set_allowlist(&blocker_allowlist);
            let filter_list_dir = app.path().app_data_dir()?.join("filter-lists");
            if let Err(error) = blocker.load_cache(&filter_list_dir) {
                log::warn!("could not load cached network filter lists: {error}");
            }
            let app_handle = app.handle().clone();
            adblocker::start_updater(blocker, filter_list_dir, move || {
                app_handle
                    .state::<TabWebviewManager>()
                    .refresh_network_cosmetics();
            });

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
            commands::menu::show_more_menu,
            commands::backup::export_browser_backup_snapshot,
            commands::backup::import_browser_backup_snapshot,
            commands::backup::save_encrypted_browser_backup,
            commands::backup::open_encrypted_browser_backup,
            // Tabs & navigation
            commands::tabs::create_tab,
            commands::tabs::list_tabs,
            commands::tabs::activate_tab,
            commands::tabs::close_tab,
            commands::tabs::navigate_tab,
            commands::tabs::navigate_private_tab,
            commands::tabs::close_private_tab,
            commands::tabs::update_tab_meta,
            commands::tabs::toggle_pin_tab,
            commands::tabs::set_tab_group,
            commands::tabs::reorder_tab,
            commands::tabs::go_back,
            commands::tabs::go_forward,
            commands::tabs::reload_tab,
            commands::tabs::print_tab,
            commands::tabs::zoom_tab,
            commands::tabs::find_in_tab,
            commands::tabs::reader_mode_tab,
            commands::tabs::read_aloud_tab,
            commands::tabs::set_tab_muted,
            commands::tabs::control_tab_media,
            commands::tabs::set_force_dark_websites,
            commands::tabs::request_page_translation,
            commands::tabs::show_translated_page,
            commands::tabs::restore_translated_page,
            commands::tabs::set_spellcheck,
            commands::tabs::set_do_not_track,
            commands::tabs::set_content_blocking,
            commands::tabs::set_network_blocking,
            commands::tabs::set_network_blocking_allowlist,
            commands::tabs::get_network_blocker_status,
            commands::tabs::set_autofill_profiles,
            commands::tabs::request_page_snapshot,
            commands::tabs::clear_site_data,
            commands::tabs::bypass_unsafe_url,
            commands::tabs::inspect_tab,
            commands::tabs::duplicate_tab,
            commands::tabs::close_other_tabs,
            commands::tabs::sync_tab_windows,
            // Workspaces
            commands::profiles::list_profiles,
            commands::profiles::create_profile,
            commands::profiles::update_profile,
            commands::profiles::delete_profile,
            commands::profiles::set_active_profile,
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
            // Reading list ("save for later")
            commands::data::list_reading_items,
            commands::data::save_reading_item,
            commands::data::delete_reading_item,
            commands::data::clear_reading_list,
            // Bookmark import / export (Netscape format — Chrome/Firefox/Edge)
            commands::bookmarks_io::import_bookmarks_file,
            commands::bookmarks_io::export_bookmarks_file,
            commands::bookmarks_io::import_bookmarks_html,
            commands::bookmarks_io::export_bookmarks_html,
            // Settings & privacy
            commands::settings::get_settings,
            commands::settings::set_setting,
            commands::settings::clear_browsing_data,
            commands::settings::list_site_permissions,
            commands::settings::set_site_permission,
            commands::settings::clear_site_permissions,
            commands::settings::get_app_info,
            // Local file viewer (read-only previews)
            commands::viewer::read_viewer_bytes,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Ritam Browser");
}
