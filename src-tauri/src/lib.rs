mod commands;
mod db;
mod error;
mod models;
mod navigation;
mod webview;

use tauri::{Manager, WindowEvent};

use webview::TabWindowManager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|_app, _argv, _cwd| {
            // Second launch: focus the existing window instead of opening a new one.
            // (State access here is intentionally minimal.)
        }))
        .plugin(tauri_plugin_log::Builder::new().build())
        .plugin(tauri_plugin_shell::init())
        .manage(TabWindowManager::new())
        .setup(|app| {
            let db = db::init(app.handle())?;
            app.manage(db);

            // Keep the interim tab windows glued to the main window.
            let app_handle = app.handle().clone();
            if let Some(main) = app.get_webview_window("main") {
                main.on_window_event(move |event| match event {
                    WindowEvent::Moved(_) | WindowEvent::Resized(_) | WindowEvent::Focused(true) => {
                        app_handle.state::<TabWindowManager>().apply(&app_handle);
                    }
                    // When the main window is closing, tear down all tab windows.
                    WindowEvent::CloseRequested { .. } => {
                        app_handle.state::<TabWindowManager>().close_all();
                    }
                    _ => {}
                });
            }
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
