use crate::db::{now_ms, DbState};
use crate::error::AppError;
use crate::models::{CloseTabResult, Tab};
use crate::navigation::{validate_navigation_url, HOME_URL};
use crate::webview::{LayoutState, TabWindowManager};
use rusqlite::params;
use tauri::{AppHandle, State};

fn row_to_tab(row: &rusqlite::Row) -> rusqlite::Result<Tab> {
    Ok(Tab {
        id: row.get(0)?,
        workspace_id: row.get(1)?,
        url: row.get(2)?,
        title: row.get(3)?,
        favicon_url: row.get(4)?,
        is_pinned: row.get(5)?,
        sort_order: row.get(6)?,
        created_at: row.get(7)?,
        last_active_at: row.get(8)?,
    })
}

const TAB_COLS: &str = "id, workspace_id, url, title, favicon_url, is_pinned, sort_order, created_at, last_active_at";

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
        ).or_else(|_| {
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
    app: AppHandle,
    db: State<'_, DbState>,
    manager: State<'_, TabWindowManager>,
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
    manager.apply(&app);
    Ok(tab)
}

#[tauri::command]
pub fn close_tab(
    app: AppHandle,
    db: State<'_, DbState>,
    manager: State<'_, TabWindowManager>,
    tab_id: String,
) -> Result<CloseTabResult, AppError> {
    let conn = db.conn();
    let tab = get_tab(&conn, &tab_id)?;
    let workspace_id = tab.workspace_id.clone();

    manager.close_window(&tab_id);
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
    manager.apply(&app);
    Ok(CloseTabResult { closed_id: tab_id, active_tab_id })
}

#[tauri::command]
pub fn navigate_tab(
    app: AppHandle,
    db: State<'_, DbState>,
    manager: State<'_, TabWindowManager>,
    tab_id: String,
    url: String,
) -> Result<Tab, AppError> {
    let target = validate_navigation_url(&url)?;
    manager.navigate(&app, &tab_id, &target)?;

    let conn = db.conn();
    let title = title_from_url(&target);
    conn.execute(
        "UPDATE tabs SET url = ?1, title = ?2, last_active_at = ?3 WHERE id = ?4",
        params![target, title, now_ms(), tab_id],
    )?;
    get_tab(&conn, &tab_id)
}

#[tauri::command]
pub fn update_tab_meta(
    db: State<'_, DbState>,
    tab_id: String,
    title: Option<String>,
    url: Option<String>,
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
pub fn go_back(manager: State<'_, TabWindowManager>, tab_id: Option<String>) {
    if let Some(id) = tab_id {
        manager.eval_tab(&id, "history.back()");
    }
}

#[tauri::command]
pub fn go_forward(manager: State<'_, TabWindowManager>, tab_id: Option<String>) {
    if let Some(id) = tab_id {
        manager.eval_tab(&id, "history.forward()");
    }
}

#[tauri::command]
pub fn reload_tab(manager: State<'_, TabWindowManager>, tab_id: Option<String>) {
    if let Some(id) = tab_id {
        manager.eval_tab(&id, "location.reload()");
    }
}

#[tauri::command]
pub fn sync_tab_windows(
    app: AppHandle,
    manager: State<'_, TabWindowManager>,
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
