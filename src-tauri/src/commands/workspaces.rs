use crate::db::{ensure_ai_tab, now_ms, DbState};
use crate::commands::profiles::resolve_active_profile;
use crate::error::AppError;
use crate::models::{DeleteWorkspaceResult, Workspace};
use crate::webview::TabWebviewManager;
use rusqlite::params;
use tauri::{AppHandle, State};

fn row_to_workspace(row: &rusqlite::Row) -> rusqlite::Result<Workspace> {
    Ok(Workspace {
        id: row.get(0)?,
        name: row.get(1)?,
        color: row.get(2)?,
        sort_order: row.get(3)?,
        created_at: row.get(4)?,
    })
}

const WS_COLS: &str = "id, name, color, sort_order, created_at";

fn clean_name(raw: &str) -> Result<String, AppError> {
    let name: String = raw.trim().chars().take(80).collect();
    if name.is_empty() {
        return Err(AppError::InvalidInput("workspace name is required".into()));
    }
    Ok(name)
}

fn clean_color(raw: Option<String>) -> String {
    match raw {
        Some(c) if c.len() == 7 && c.starts_with('#') && c[1..].chars().all(|c| c.is_ascii_hexdigit()) => c,
        _ => "#4A6B5D".to_string(),
    }
}

#[tauri::command]
pub fn create_workspace(db: State<'_, DbState>, name: String, color: Option<String>) -> Result<Workspace, AppError> {
    let name = clean_name(&name)?;
    let color = clean_color(color);
    let conn = db.conn();
    let profile_id = resolve_active_profile(&conn);
    let sort_order: i64 = match &profile_id {
        Some(profile) => conn.query_row(
            "SELECT COUNT(*) FROM workspaces WHERE profile_id = ?1",
            params![profile],
            |r| r.get(0),
        )?,
        None => conn.query_row("SELECT COUNT(*) FROM workspaces", [], |r| r.get(0))?,
    };
    let id = uuid::Uuid::new_v4().to_string();
    let now = now_ms();
    conn.execute(
        "INSERT INTO workspaces (id, name, color, sort_order, created_at, profile_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![id, name, color, sort_order, now, profile_id],
    )?;
    ensure_ai_tab(&conn, &id)?;
    Ok(Workspace { id, name, color, sort_order, created_at: now })
}

#[tauri::command]
pub fn list_workspaces(db: State<'_, DbState>) -> Result<Vec<Workspace>, AppError> {
    let conn = db.conn();
    // Only the active profile's workspaces are listed; tabs follow via workspace.
    let profile_id = resolve_active_profile(&conn);
    let mut stmt = match &profile_id {
        Some(_profile) => conn.prepare(&format!(
            "SELECT {WS_COLS} FROM workspaces WHERE profile_id = ?1 ORDER BY sort_order ASC"
        ))?,
        None => conn.prepare(&format!("SELECT {WS_COLS} FROM workspaces ORDER BY sort_order ASC"))?,
    };
    let rows = match &profile_id {
        Some(profile) => stmt.query_map(params![profile], row_to_workspace)?,
        None => stmt.query_map([], row_to_workspace)?,
    };
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

#[tauri::command]
pub fn rename_workspace(db: State<'_, DbState>, workspace_id: String, name: String) -> Result<Workspace, AppError> {
    let name = clean_name(&name)?;
    let conn = db.conn();
    let changed = conn.execute(
        "UPDATE workspaces SET name = ?1 WHERE id = ?2",
        params![name, workspace_id],
    )?;
    if changed == 0 {
        return Err(AppError::NotFound("workspace not found".into()));
    }
    let ws = conn.query_row(
        &format!("SELECT {WS_COLS} FROM workspaces WHERE id = ?1"),
        params![workspace_id],
        row_to_workspace,
    )?;
    Ok(ws)
}

#[tauri::command]
pub fn delete_workspace(
    app: AppHandle,
    db: State<'_, DbState>,
    manager: State<'_, TabWebviewManager>,
    workspace_id: String,
) -> Result<DeleteWorkspaceResult, AppError> {
    let conn = db.conn();

    let profile: Option<String> = conn
        .query_row(
            "SELECT profile_id FROM workspaces WHERE id = ?1",
            params![workspace_id],
            |r| r.get(0),
        )
        .ok();
    let count: i64 = match &profile {
        Some(id) => conn.query_row(
            "SELECT COUNT(*) FROM workspaces WHERE profile_id = ?1",
            params![id],
            |r| r.get(0),
        )?,
        None => conn.query_row("SELECT COUNT(*) FROM workspaces", [], |r| r.get(0))?,
    };
    if count <= 1 {
        return Err(AppError::InvalidInput("cannot delete the last workspace".into()));
    }
    let exists: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM workspaces WHERE id = ?1)",
        params![workspace_id],
        |r| r.get(0),
    )?;
    if !exists {
        return Err(AppError::NotFound("workspace not found".into()));
    }

    // Close the native webview of every tab in this workspace before deleting rows.
    let tab_ids: Vec<String> = {
        let mut stmt = conn.prepare("SELECT id FROM tabs WHERE workspace_id = ?1")?;
        let rows = stmt.query_map(params![workspace_id], |r| r.get(0))?;
        rows.collect::<Result<Vec<_>, _>>()?
    };
    for id in &tab_ids {
        manager.close_view(id);
    }

    conn.execute("DELETE FROM workspaces WHERE id = ?1", params![workspace_id])?;

    let fallback: String = match &profile {
        Some(id) => conn.query_row(
            "SELECT id FROM workspaces WHERE profile_id = ?1 ORDER BY sort_order ASC LIMIT 1",
            params![id],
            |r| r.get(0),
        )?,
        None => conn.query_row(
            "SELECT id FROM workspaces ORDER BY sort_order ASC LIMIT 1",
            [],
            |r| r.get(0),
        )?,
    };
    conn.execute(
        "INSERT OR REPLACE INTO settings (key, value) VALUES ('active_workspace_id', ?1)",
        params![fallback],
    )?;

    let result = DeleteWorkspaceResult { deleted_id: workspace_id, active_workspace_id: fallback };
    drop(conn);
    let _ = app; // keep handle for symmetry with other commands
    Ok(result)
}

#[tauri::command]
pub fn set_active_workspace(db: State<'_, DbState>, workspace_id: String) -> Result<serde_json::Value, AppError> {
    let conn = db.conn();
    let exists: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM workspaces WHERE id = ?1)",
        params![workspace_id],
        |r| r.get(0),
    )?;
    if !exists {
        return Err(AppError::NotFound("workspace not found".into()));
    }
    conn.execute(
        "INSERT OR REPLACE INTO settings (key, value) VALUES ('active_workspace_id', ?1)",
        params![workspace_id],
    )?;
    Ok(serde_json::json!({ "active_workspace_id": workspace_id }))
}
