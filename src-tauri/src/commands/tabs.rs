use crate::db::{now_ms, DbState};
use crate::error::AppError;
use crate::models::{CloseTabResult, Tab};
use crate::navigation::{validate_navigation_url, HOME_URL};
use crate::webview::{LayoutState, TabWebviewManager};
use rusqlite::params;
use tauri::{AppHandle, Manager, State};

fn row_to_tab(row: &rusqlite::Row) -> rusqlite::Result<Tab> {
    Ok(Tab {
        id: row.get(0)?,
        workspace_id: row.get(1)?,
        url: row.get(2)?,
        title: row.get(3)?,
        favicon_url: row.get(4)?,
        is_pinned: row.get(5)?,
        group_name: row.get(6)?,
        sort_order: row.get(7)?,
        created_at: row.get(8)?,
        last_active_at: row.get(9)?,
    })
}

const TAB_COLS: &str = "id, workspace_id, url, title, favicon_url, is_pinned, group_name, sort_order, created_at, last_active_at";

pub fn get_tab(conn: &rusqlite::Connection, tab_id: &str) -> Result<Tab, AppError> {
    conn.query_row(
        &format!("SELECT {TAB_COLS} FROM tabs WHERE id = ?1"),
        params![tab_id],
        row_to_tab,
    )
    .map_err(|e| match e {
        rusqlite::Error::QueryReturnedNoRows => AppError::NotFound("tab not found".into()),
        other => AppError::Db(other),
    })
}

fn title_from_url(url: &str) -> String {
    if url == HOME_URL {
        return "New Tab".to_string();
    }
    tauri::Url::parse(url)
        .map(|u| {
            let host = u.host_str().unwrap_or("").trim_start_matches("www.");
            let path = u.path();
            if path.is_empty() || path == "/" {
                host.to_string()
            } else {
                format!("{host}{path}")
            }
        })
        .unwrap_or_else(|_| url.chars().take(120).collect())
}

#[tauri::command]
pub fn create_tab(
    db: State<'_, DbState>,
    workspace_id: Option<String>,
    url: Option<String>,
) -> Result<Tab, AppError> {
    let target = validate_navigation_url(url.as_deref().unwrap_or(HOME_URL))?;
    let conn = db.conn();

    let ws_id = match workspace_id {
        Some(id) => {
            let exists: bool = conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM workspaces WHERE id = ?1)",
                params![id],
                |r| r.get(0),
            )?;
            if !exists {
                return Err(AppError::NotFound("workspace not found".into()));
            }
            id
        }
        None => conn.query_row(
            "SELECT value FROM settings WHERE key = 'active_workspace_id'",
            [],
            |r| r.get(0),
        )
        .or_else(|_| {
            conn.query_row("SELECT id FROM workspaces ORDER BY sort_order LIMIT 1", [], |r| r.get(0))
        })?,
    };

    let order: i64 = conn.query_row(
        "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM tabs WHERE workspace_id = ?1",
        params![ws_id],
        |r| r.get(0),
    )?;

    let id = uuid::Uuid::new_v4().to_string();
    let now = now_ms();
    let title = title_from_url(&target);
    conn.execute(
        "INSERT INTO tabs (id, workspace_id, url, title, favicon_url, is_pinned, sort_order, created_at, last_active_at)
         VALUES (?1, ?2, ?3, ?4, NULL, 0, ?5, ?6, ?6)",
        params![id, ws_id, target, title, order, now],
    )?;
    get_tab(&conn, &id)
}

#[tauri::command]
pub fn list_tabs(db: State<'_, DbState>, workspace_id: Option<String>) -> Result<Vec<Tab>, AppError> {
    let conn = db.conn();
    let mut out = Vec::new();
    match workspace_id {
        Some(ws) => {
            let mut stmt = conn.prepare(&format!(
                "SELECT {TAB_COLS} FROM tabs WHERE workspace_id = ?1 ORDER BY is_pinned DESC, sort_order ASC"
            ))?;
            let rows = stmt.query_map(params![ws], row_to_tab)?;
            for row in rows {
                out.push(row?);
            }
        }
        None => {
            let mut stmt = conn.prepare(&format!(
                "SELECT {TAB_COLS} FROM tabs ORDER BY is_pinned DESC, sort_order ASC"
            ))?;
            let rows = stmt.query_map([], row_to_tab)?;
            for row in rows {
                out.push(row?);
            }
        }
    }
    Ok(out)
}

#[tauri::command]
pub fn activate_tab(
    _app: AppHandle,
    db: State<'_, DbState>,
    manager: State<'_, TabWebviewManager>,
    tab_id: String,
) -> Result<Tab, AppError> {
    let conn = db.conn();
    conn.execute(
        "UPDATE tabs SET last_active_at = ?1 WHERE id = ?2",
        params![now_ms(), tab_id],
    )?;
    // Persist the workspace of the activated tab as the active workspace.
    if let Ok(tab) = get_tab(&conn, &tab_id) {
        conn.execute(
            "INSERT OR REPLACE INTO settings (key, value) VALUES ('active_workspace_id', ?1)",
            params![tab.workspace_id],
        )?;
    }
    let tab = get_tab(&conn, &tab_id)?;
    drop(conn);
    manager.apply();
    Ok(tab)
}

#[tauri::command]
pub fn close_tab(
    _app: AppHandle,
    db: State<'_, DbState>,
    manager: State<'_, TabWebviewManager>,
    tab_id: String,
) -> Result<CloseTabResult, AppError> {
    let conn = db.conn();
    let tab = get_tab(&conn, &tab_id)?;
    let workspace_id = tab.workspace_id.clone();

    manager.close_view(&tab_id);
    manager.remove_tab_state(&tab_id);
    conn.execute("DELETE FROM tabs WHERE id = ?1", params![tab_id])?;

    // Pick the next tab to activate: most recently used in this workspace…
    let mut active: Option<String> = conn
        .query_row(
            "SELECT id FROM tabs WHERE workspace_id = ?1 ORDER BY last_active_at DESC LIMIT 1",
            params![workspace_id],
            |r| r.get(0),
        )
        .ok()
        .or_else(|| {
            // …or across workspaces if this one is now empty
            conn.query_row("SELECT id FROM tabs ORDER BY last_active_at DESC LIMIT 1", [], |r| r.get(0)).ok()
        });

    // …or open a fresh home tab if none remain at all (browser convention)
    if active.is_none() {
        let new_id = uuid::Uuid::new_v4().to_string();
        let now = now_ms();
        conn.execute(
            "INSERT INTO tabs (id, workspace_id, url, title, favicon_url, is_pinned, sort_order, created_at, last_active_at)
             VALUES (?1, ?2, ?3, 'New Tab', NULL, 0, 0, ?4, ?4)",
            params![new_id, workspace_id, HOME_URL, now],
        )?;
        active = Some(new_id);
    }

    if let Some(ref id) = active {
        conn.execute("UPDATE tabs SET last_active_at = ?1 WHERE id = ?2", params![now_ms(), id])?;
    }
    let active_tab_id = active;
    drop(conn);
    manager.apply();
    Ok(CloseTabResult { closed_id: tab_id, active_tab_id })
}

/// Navigate a tab to a URL.
///
/// `async` on purpose: creating a webview must not happen on the UI thread
/// (WebView2 deadlocks on Windows).
#[tauri::command]
pub async fn navigate_tab(
    app: AppHandle,
    tab_id: String,
    url: String,
) -> Result<Tab, AppError> {
    let target = validate_navigation_url(&url)?;
    let manager = app.state::<TabWebviewManager>();
    manager.navigate(&app, &tab_id, &target, false).await?;

    let db = app.state::<DbState>();
    let conn = db.conn();
    let title = title_from_url(&target);
    conn.execute(
        "UPDATE tabs SET url = ?1, title = ?2, last_active_at = ?3 WHERE id = ?4",
        params![target, title, now_ms(), tab_id],
    )?;
    get_tab(&conn, &tab_id)
}

#[tauri::command]
pub async fn navigate_private_tab(
    app: AppHandle,
    tab_id: String,
    url: String,
) -> Result<(), AppError> {
    let target = validate_navigation_url(&url)?;
    app.state::<TabWebviewManager>()
        .navigate(&app, &tab_id, &target, true)
        .await
}

#[tauri::command]
pub fn close_private_tab(
    manager: State<'_, TabWebviewManager>,
    tab_id: String,
) {
    manager.close_private_tab(&tab_id);
}

#[tauri::command]
pub fn update_tab_meta(
    db: State<'_, DbState>,
    tab_id: String,
    title: Option<String>,
    url: Option<String>,
    favicon_url: Option<String>,
) -> Result<Tab, AppError> {
    let conn = db.conn();
    if let Some(url) = url {
        let target = validate_navigation_url(&url)?;
        conn.execute("UPDATE tabs SET url = ?1 WHERE id = ?2", params![target, tab_id])?;
    }
    if let Some(title) = title {
        let clean: String = title.chars().take(500).collect();
        conn.execute("UPDATE tabs SET title = ?1 WHERE id = ?2", params![clean, tab_id])?;
    }
    if let Some(favicon) = favicon_url {
        if favicon.is_empty() {
            conn.execute("UPDATE tabs SET favicon_url = NULL WHERE id = ?1", params![tab_id])?;
        } else {
            let clean: String = favicon.trim().chars().take(2048).collect();
            let lower = clean.to_ascii_lowercase();
            if lower.starts_with("http://") || lower.starts_with("https://") || lower.starts_with("data:image/") {
                conn.execute("UPDATE tabs SET favicon_url = ?1 WHERE id = ?2", params![clean, tab_id])?;
            }
        }
    }
    conn.execute("UPDATE tabs SET last_active_at = ?1 WHERE id = ?2", params![now_ms(), tab_id])?;
    get_tab(&conn, &tab_id)
}

#[tauri::command]
pub fn toggle_pin_tab(db: State<'_, DbState>, tab_id: String) -> Result<Tab, AppError> {
    let conn = db.conn();
    conn.execute("UPDATE tabs SET is_pinned = 1 - is_pinned WHERE id = ?1", params![tab_id])?;
    get_tab(&conn, &tab_id)
}

#[tauri::command]
pub fn set_tab_group(
    db: State<'_, DbState>,
    tab_id: String,
    group_name: Option<String>,
) -> Result<Tab, AppError> {
    let group_name = group_name
        .map(|name| name.trim().chars().take(40).collect::<String>())
        .filter(|name| !name.is_empty());
    let conn = db.conn();
    conn.execute(
        "UPDATE tabs SET group_name = ?1 WHERE id = ?2",
        params![group_name, tab_id],
    )?;
    get_tab(&conn, &tab_id)
}

#[tauri::command]
pub fn reorder_tab(
    db: State<'_, DbState>,
    tab_id: String,
    direction: String,
) -> Result<Vec<Tab>, AppError> {
    let conn = db.conn();
    let tab = get_tab(&conn, &tab_id)?;
    let mut stmt = conn.prepare(
        "SELECT id, sort_order FROM tabs WHERE workspace_id = ?1 ORDER BY sort_order ASC",
    )?;
    let siblings: Vec<(String, i64)> = stmt
        .query_map(params![tab.workspace_id], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<Result<_, _>>()?;
    drop(stmt);

    if let Some(i) = siblings.iter().position(|(id, _)| id == &tab_id) {
        let j = if direction == "up" { i.checked_sub(1) } else { (i + 1 < siblings.len()).then_some(i + 1) };
        if let Some(j) = j {
            let (a, ao) = &siblings[i];
            let (b, bo) = &siblings[j];
            conn.execute("UPDATE tabs SET sort_order = ?1 WHERE id = ?2", params![bo, a])?;
            conn.execute("UPDATE tabs SET sort_order = ?1 WHERE id = ?2", params![ao, b])?;
        }
    }
    drop(conn);
    list_tabs(db, Some(tab.workspace_id))
}

#[tauri::command]
pub fn go_back(manager: State<'_, TabWebviewManager>, tab_id: Option<String>) {
    if let Some(id) = tab_id {
        manager.eval_tab(&id, "history.back()");
    }
}

#[tauri::command]
pub fn go_forward(manager: State<'_, TabWebviewManager>, tab_id: Option<String>) {
    if let Some(id) = tab_id {
        manager.eval_tab(&id, "history.forward()");
    }
}

#[tauri::command]
pub fn reload_tab(manager: State<'_, TabWebviewManager>, tab_id: Option<String>) {
    if let Some(id) = tab_id {
        manager.reload_tab(&id);
    }
}

/// Print the page of a tab (not the shell chrome).
#[tauri::command]
pub fn print_tab(manager: State<'_, TabWebviewManager>, tab_id: Option<String>) {
    if let Some(id) = tab_id {
        manager.print_tab(&id);
    }
}

/// Set the zoom factor of a tab's page (1.0 = 100%).
#[tauri::command]
pub fn zoom_tab(manager: State<'_, TabWebviewManager>, tab_id: Option<String>, factor: f64) {
    if let Some(id) = tab_id {
        manager.set_zoom(&id, factor);
    }
}

/// Find text in a tab's page. Empty query clears the selection.
#[tauri::command]
pub fn find_in_tab(
    manager: State<'_, TabWebviewManager>,
    tab_id: Option<String>,
    query: String,
    forward: Option<bool>,
) {
    if let Some(id) = tab_id {
        manager.find_tab(&id, &query, forward.unwrap_or(true));
    }
}

#[tauri::command]
pub fn reader_mode_tab(
    manager: State<'_, TabWebviewManager>,
    tab_id: Option<String>,
    enabled: bool,
) {
    if let Some(id) = tab_id {
        manager.reader_mode(&id, enabled);
    }
}

#[tauri::command]
pub fn read_aloud_tab(
    manager: State<'_, TabWebviewManager>,
    tab_id: String,
) -> Result<(), AppError> {
    if manager.read_aloud(&tab_id) {
        Ok(())
    } else {
        Err(AppError::NotFound("tab webview not found".into()))
    }
}

#[tauri::command]
pub fn set_tab_muted(
    manager: State<'_, TabWebviewManager>,
    tab_id: String,
    muted: bool,
) -> Result<(), AppError> {
    if manager.set_tab_muted(&tab_id, muted) {
        Ok(())
    } else {
        Err(AppError::NotFound("tab webview not found".into()))
    }
}

#[tauri::command]
pub fn set_force_dark_websites(manager: State<'_, TabWebviewManager>, enabled: bool) {
    manager.set_force_dark_websites(enabled);
}

#[tauri::command]
pub fn request_page_translation(
    manager: State<'_, TabWebviewManager>,
    tab_id: String,
    request_id: String,
) -> Result<(), AppError> {
    if request_id.is_empty() || request_id.len() > 128 {
        return Err(AppError::InvalidInput("invalid translation request id".into()));
    }
    if manager.request_page_translation(&tab_id, &request_id) {
        Ok(())
    } else {
        Err(AppError::NotFound("tab webview not found".into()))
    }
}

#[tauri::command]
pub fn show_translated_page(
    manager: State<'_, TabWebviewManager>,
    tab_id: String,
    expected_url: String,
    title: String,
    text: String,
) -> Result<(), AppError> {
    if title.len() > 1000 || text.len() > 100_000 {
        return Err(AppError::InvalidInput("translated page is too large".into()));
    }
    if manager.show_translated_page(&tab_id, &expected_url, &title, &text) {
        Ok(())
    } else {
        Err(AppError::InvalidInput("page changed before translation completed".into()))
    }
}

#[tauri::command]
pub fn restore_translated_page(manager: State<'_, TabWebviewManager>, tab_id: String) {
    manager.restore_translated_page(&tab_id);
}

#[tauri::command]
pub fn set_spellcheck(manager: State<'_, TabWebviewManager>, enabled: bool) {
    manager.set_spellcheck(enabled);
}

#[tauri::command]
pub fn set_do_not_track(manager: State<'_, TabWebviewManager>, enabled: bool) {
    manager.set_do_not_track(enabled);
}

/// Push cosmetic content-blocking selectors into every page. The value is the
/// same `cosmetic_filters` setting string (validated by `set_setting`).
#[tauri::command]
pub fn set_content_blocking(manager: State<'_, TabWebviewManager>, css: String) -> Result<(), AppError> {
    if css.len() > 50_000 {
        return Err(AppError::InvalidInput("filter list too large".into()));
    }
    manager.set_content_blocking(css);
    Ok(())
}

/// Push the JSON autofill-profile array into every page.
#[tauri::command]
pub fn set_autofill_profiles(manager: State<'_, TabWebviewManager>, profiles_json: String) -> Result<(), AppError> {
    if profiles_json.len() > 100_000 {
        return Err(AppError::InvalidInput("autofill profiles too large".into()));
    }
    let parsed: serde_json::Value = serde_json::from_str(&profiles_json)
        .map_err(|_| AppError::InvalidInput("autofill profiles must be a JSON array".into()))?;
    if !parsed.is_array() || parsed.as_array().map(|a| a.len()).unwrap_or(0) > 50 {
        return Err(AppError::InvalidInput("autofill profiles must be an array of at most 50 entries".into()));
    }
    manager.set_autofill_profiles(profiles_json);
    Ok(())
}

/// Capture the page's visible text for an offline reading-list snapshot.
/// The result arrives on the `tab-snapshot-data` event.
#[tauri::command]
pub fn request_page_snapshot(
    manager: State<'_, TabWebviewManager>,
    tab_id: String,
    request_id: String,
) -> Result<(), AppError> {
    if request_id.is_empty() || request_id.len() > 128 {
        return Err(AppError::InvalidInput("invalid snapshot request id".into()));
    }
    if manager.request_page_snapshot(&tab_id, &request_id) {
        Ok(())
    } else {
        Err(AppError::NotFound("tab webview not found".into()))
    }
}

/// Expire cookies and clear origin storage for the page's site.
#[tauri::command]
pub fn clear_site_data(
    manager: State<'_, TabWebviewManager>,
    tab_id: String,
) -> Result<(), AppError> {
    if manager.clear_site_data(&tab_id) {
        Ok(())
    } else {
        Err(AppError::NotFound("tab webview not found".into()))
    }
}

/// The user chose to visit a safe-browsing-blocklisted URL anyway.
#[tauri::command]
pub fn bypass_unsafe_url(manager: State<'_, TabWebviewManager>, url: String) -> Result<(), AppError> {
    let target = validate_navigation_url(&url)?;
    manager.bypass_unsafe_url(&target);
    Ok(())
}

/// Open the engine DevTools for a tab's page.
#[tauri::command]
pub fn inspect_tab(manager: State<'_, TabWebviewManager>, tab_id: Option<String>) {
    if let Some(id) = tab_id {
        manager.inspect(&id);
    }
}

/// Duplicate a tab (same URL, same workspace) and load it in a fresh webview.
///
/// `async` for the same reason as `navigate_tab`: webview creation on Windows.
#[tauri::command]
pub async fn duplicate_tab(
    app: AppHandle,
    db: State<'_, DbState>,
    manager: State<'_, TabWebviewManager>,
    tab_id: String,
) -> Result<Tab, AppError> {
    let source = {
        let conn = db.conn();
        get_tab(&conn, &tab_id)?
    };

    let new_id = uuid::Uuid::new_v4().to_string();
    {
        let conn = db.conn();
        let order: i64 = conn.query_row(
            "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM tabs WHERE workspace_id = ?1",
            params![source.workspace_id],
            |r| r.get(0),
        )?;
        let now = now_ms();
        conn.execute(
            "INSERT INTO tabs (id, workspace_id, url, title, favicon_url, is_pinned, group_name, sort_order, created_at, last_active_at)
             VALUES (?1, ?2, ?3, ?4, ?5, 0, ?6, ?7, ?8, ?8)",
            params![new_id, source.workspace_id, source.url, source.title, source.favicon_url, source.group_name, order, now],
        )?;
    }

    // Web pages need a fresh webview; internal pages are shell-rendered.
    if !crate::navigation::is_internal_url(&source.url) {
        manager.navigate(&app, &new_id, &source.url, false).await?;
    }
    let conn = db.conn();
    get_tab(&conn, &new_id)
}

/// Close other tabs of the same workspace: `scope` "others" closes every tab
/// except `tab_id`; "right" closes the tabs after it in tab-bar order.
#[tauri::command]
pub fn close_other_tabs(
    db: State<'_, DbState>,
    manager: State<'_, TabWebviewManager>,
    tab_id: String,
    scope: String,
) -> Result<Vec<Tab>, AppError> {
    let conn = db.conn();
    let keep = get_tab(&conn, &tab_id)?;
    let mut stmt = conn.prepare(&format!(
        "SELECT {TAB_COLS} FROM tabs WHERE workspace_id = ?1 ORDER BY is_pinned DESC, sort_order ASC"
    ))?;
    let ordered: Vec<Tab> = stmt
        .query_map(params![keep.workspace_id], row_to_tab)?
        .collect::<Result<_, _>>()?;
    drop(stmt);

    let idx = ordered
        .iter()
        .position(|t| t.id == tab_id)
        .ok_or_else(|| AppError::NotFound("tab not found".into()))?;
    let targets: Vec<String> = match scope.as_str() {
        "right" => ordered.iter().skip(idx + 1).map(|t| t.id.clone()).collect(),
        _ => ordered.iter().filter(|t| t.id != tab_id).map(|t| t.id.clone()).collect(),
    };
    for id in &targets {
        manager.close_view(id);
        conn.execute("DELETE FROM tabs WHERE id = ?1", params![id])?;
    }
    conn.execute(
        "UPDATE tabs SET last_active_at = ?1 WHERE id = ?2",
        params![now_ms(), tab_id],
    )?;
    drop(conn);
    manager.apply();
    list_tabs(db, Some(keep.workspace_id))
}

/// Keep the native webviews aligned with the shell layout.
#[tauri::command]
pub fn sync_tab_windows(
    app: AppHandle,
    manager: State<'_, TabWebviewManager>,
    active_tab_id: Option<String>,
    visible: bool,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) {
    manager.set_layout(
        LayoutState {
            offset_x: x,
            offset_y: y,
            width: width.max(1.0),
            height: height.max(1.0),
            visible,
            active: active_tab_id,
        },
        &app,
    );
}
