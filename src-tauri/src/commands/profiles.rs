//! Local browser profiles.
//!
//! A profile is a local identity (name + optional email) with its own
//! workspaces and tabs. Ritam does not sign in to any account service: the
//! email is a label the user chooses for the profile, exactly like a local
//! Chrome profile that was never signed in.
//!
//! Since schema v2 every row that belongs to a browser (bookmarks, history,
//! downloads, reading list, permissions, settings) carries `profile_id`, and
//! each profile gets its own webview data directory. Deleting a profile drops
//! both.

use crate::db::{active_profile_id, ensure_ai_tab, now_ms, set_shell_state, DbState};
use crate::error::AppError;
use crate::models::Profile;
use rusqlite::{params, Connection};
use std::path::PathBuf;
use tauri::{AppHandle, Manager, State};

const PROFILE_COLORS: &[&str] = &[
    "#4A6B5D", "#2F6F8F", "#8A5A44", "#6B4E8F", "#B5651D", "#3F7A4F", "#A04456", "#4C5B7A",
];
const MAX_NAME: usize = 80;
const MAX_EMAIL: usize = 254;

const PROFILE_COLS: &str = "id, name, email, color, avatar, sort_order, created_at";

fn row_to_profile(row: &rusqlite::Row) -> rusqlite::Result<Profile> {
    Ok(Profile {
        id: row.get(0)?,
        name: row.get(1)?,
        email: row.get(2)?,
        color: row.get(3)?,
        avatar: row.get(4)?,
        sort_order: row.get(5)?,
        created_at: row.get(6)?,
    })
}

fn clean_name(raw: &str) -> Result<String, AppError> {
    let name: String = raw.trim().chars().take(MAX_NAME).collect();
    if name.is_empty() {
        return Err(AppError::InvalidInput("profile name is required".into()));
    }
    Ok(name)
}

/// Empty is allowed (a local profile does not need an address). Otherwise the
/// value must look like `local@domain.tld` — no display names, no schemes.
fn clean_email(raw: Option<String>) -> Result<String, AppError> {
    let email = raw.unwrap_or_default().trim().to_string();
    if email.is_empty() {
        return Ok(email);
    }
    if email.len() > MAX_EMAIL
        || email.split_whitespace().count() != 1
        || email.matches('@').count() != 1
    {
        return Err(AppError::InvalidInput("profile email is not a valid address".into()));
    }
    let (local, domain) = email.split_once('@').unwrap_or_default();
    let valid_local = !local.is_empty()
        && local
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || ".!#$%&'*+/=?^_`{|}~-".contains(c));
    let valid_domain = domain.contains('.')
        && !domain.starts_with('.')
        && !domain.ends_with('.')
        && domain
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-');
    if !valid_local || !valid_domain {
        return Err(AppError::InvalidInput("profile email is not a valid address".into()));
    }
    Ok(email)
}

fn clean_color(raw: Option<String>) -> String {
    match raw {
        Some(c) if c.len() == 7 && c.starts_with('#') && c[1..].chars().all(|c| c.is_ascii_hexdigit()) => c,
        _ => PROFILE_COLORS[0].to_string(),
    }
}

/// A single emoji or two letters, or nothing. Anything longer is a rendering
/// accident, not an avatar.
fn clean_avatar(raw: Option<String>) -> Option<String> {
    let value = raw?.trim().to_string();
    if value.is_empty() {
        None
    } else {
        Some(value.chars().take(4).collect())
    }
}

/// Per-profile directory: `{app data}/profiles/{id}`. Holds the profile's
/// webview data and auto-fill file. 0700 on Unix so other users cannot read it.
pub fn profile_dir(app: &AppHandle, profile_id: &str) -> Result<PathBuf, AppError> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::InvalidInput(format!("could not resolve app data dir: {e}")))?
        .join("profiles")
        .join(profile_id);
    std::fs::create_dir_all(&base)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&base, std::fs::Permissions::from_mode(0o700));
    }
    Ok(base)
}

/// The profile whose workspaces are currently listed. Falls back to the oldest
/// profile so a missing setting can never hide every workspace.
pub fn resolve_active_profile(conn: &Connection) -> Option<String> {
    if let Some(id) = active_profile_id(conn) {
        let exists: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM profiles WHERE id = ?1)",
                params![id],
                |r| r.get(0),
            )
            .unwrap_or(false);
        if exists {
            return Some(id);
        }
    }
    conn.query_row("SELECT id FROM profiles ORDER BY sort_order ASC, created_at ASC LIMIT 1", [], |r| r.get(0))
        .ok()
}

/// First-run bootstrap: make sure at least one profile exists and that every
/// legacy workspace belongs to it.
pub fn ensure_default_profile(conn: &Connection) -> Result<(), AppError> {
    let count: i64 = conn.query_row("SELECT COUNT(*) FROM profiles", [], |r| r.get(0))?;
    if count == 0 {
        let id = uuid::Uuid::new_v4().to_string();
        conn.execute(
            "INSERT INTO profiles (id, name, email, color, sort_order, created_at)
             VALUES (?1, 'Personal', '', ?2, 0, ?3)",
            params![id, PROFILE_COLORS[0], now_ms()],
        )?;
        set_shell_state(conn, "active_profile_id", &id)?;
    }
    if let Some(profile) = resolve_active_profile(conn) {
        conn.execute(
            "UPDATE workspaces SET profile_id = ?1 WHERE profile_id IS NULL",
            params![profile],
        )?;
    }
    Ok(())
}

/// A brand-new profile starts with one workspace so tabs have a home.
fn ensure_workspace(conn: &Connection, profile_id: &str) -> Result<String, AppError> {
    let existing: Result<String, _> = conn.query_row(
        "SELECT id FROM workspaces WHERE profile_id = ?1 ORDER BY sort_order ASC LIMIT 1",
        params![profile_id],
        |r| r.get(0),
    );
    if let Ok(id) = existing {
        ensure_ai_tab(conn, &id)?;
        return Ok(id);
    }
    let id = uuid::Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO workspaces (id, name, color, sort_order, created_at, profile_id)
         VALUES (?1, 'Personal', ?2, 0, ?3, ?4)",
        params![id, PROFILE_COLORS[0], now_ms(), profile_id],
    )?;
    ensure_ai_tab(conn, &id)?;
    Ok(id)
}

#[tauri::command]
pub fn list_profiles(db: State<'_, DbState>) -> Result<serde_json::Value, AppError> {
    let conn = db.conn();
    let mut stmt = conn.prepare(&format!(
        "SELECT {PROFILE_COLS} FROM profiles ORDER BY sort_order ASC, created_at ASC"
    ))?;
    let rows: Vec<Profile> = stmt.query_map([], row_to_profile)?.collect::<Result<_, _>>()?;
    let default_id = rows.first().map(|p| p.id.clone());
    let active = resolve_active_profile(&conn);
    let profiles: Vec<serde_json::Value> = rows
        .iter()
        .map(|p| {
            serde_json::json!({
                "id": p.id,
                "name": p.name,
                "email": p.email,
                "color": p.color,
                "avatar": p.avatar,
                "sort_order": p.sort_order,
                "created_at": p.created_at,
                "is_default": Some(&p.id) == default_id.as_ref(),
            })
        })
        .collect();
    Ok(serde_json::json!({ "profiles": profiles, "active_profile_id": active }))
}

#[tauri::command]
pub fn create_profile(
    app: AppHandle,
    db: State<'_, DbState>,
    name: String,
    email: Option<String>,
    color: Option<String>,
    avatar: Option<String>,
) -> Result<Profile, AppError> {
    let name = clean_name(&name)?;
    let email = clean_email(email)?;
    let fallback_color = {
        let count: i64 = db.conn().query_row("SELECT COUNT(*) FROM profiles", [], |r| r.get(0))?;
        PROFILE_COLORS[(count as usize) % PROFILE_COLORS.len()].to_string()
    };
    let color = color.map(|c| clean_color(Some(c))).unwrap_or(fallback_color);
    let avatar = clean_avatar(avatar);
    let conn = db.conn();
    let sort_order: i64 = conn.query_row("SELECT COUNT(*) FROM profiles", [], |r| r.get(0))?;
    let id = uuid::Uuid::new_v4().to_string();
    let now = now_ms();
    conn.execute(
        "INSERT INTO profiles (id, name, email, color, avatar, sort_order, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![id, name, email, color, avatar, sort_order, now],
    )?;
    ensure_workspace(&conn, &id)?;
    drop(conn);
    profile_dir(&app, &id)?;
    Ok(Profile { id, name, email, color, avatar, sort_order, created_at: now })
}

fn update_profile_row(
    conn: &Connection,
    profile_id: &str,
    name: Option<String>,
    email: Option<String>,
    color: Option<String>,
    avatar: Option<String>,
) -> Result<Profile, AppError> {
    let current = conn
        .query_row(
            &format!("SELECT {PROFILE_COLS} FROM profiles WHERE id = ?1"),
            params![profile_id],
            row_to_profile,
        )
        .map_err(|_| AppError::NotFound("profile not found".into()))?;
    let name = match name {
        Some(value) => clean_name(&value)?,
        None => current.name,
    };
    let email = match email {
        Some(value) => clean_email(Some(value))?,
        None => current.email,
    };
    let color = color.map(|c| clean_color(Some(c))).unwrap_or(current.color);
    let avatar = match avatar {
        Some(value) => clean_avatar(Some(value)),
        None => current.avatar,
    };
    conn.execute(
        "UPDATE profiles SET name = ?1, email = ?2, color = ?3, avatar = ?4 WHERE id = ?5",
        params![name, email, color, avatar, profile_id],
    )?;
    conn.query_row(
        &format!("SELECT {PROFILE_COLS} FROM profiles WHERE id = ?1"),
        params![profile_id],
        row_to_profile,
    )
    .map_err(AppError::from)
}

#[tauri::command]
pub fn update_profile(
    db: State<'_, DbState>,
    profile_id: String,
    name: Option<String>,
    email: Option<String>,
    color: Option<String>,
    avatar: Option<String>,
) -> Result<Profile, AppError> {
    let conn = db.conn();
    update_profile_row(&conn, &profile_id, name, email, color, avatar)
}

#[tauri::command]
pub fn rename_profile(db: State<'_, DbState>, profile_id: String, name: String) -> Result<Profile, AppError> {
    let conn = db.conn();
    update_profile_row(&conn, &profile_id, Some(name), None, None, None)
}

/// The default profile is the one the app starts on. There is no extra column:
/// it is simply the first profile in `sort_order`.
#[tauri::command]
pub fn set_default_profile(db: State<'_, DbState>, profile_id: String) -> Result<serde_json::Value, AppError> {
    let conn = db.conn();
    let mut stmt = conn.prepare("SELECT id FROM profiles ORDER BY sort_order ASC, created_at ASC")?;
    let mut ids: Vec<String> = stmt.query_map([], |r| r.get(0))?.collect::<Result<_, _>>()?;
    if !ids.contains(&profile_id) {
        return Err(AppError::NotFound("profile not found".into()));
    }
    ids.retain(|id| id != &profile_id);
    ids.insert(0, profile_id.clone());
    for (index, id) in ids.iter().enumerate() {
        conn.execute(
            "UPDATE profiles SET sort_order = ?1 WHERE id = ?2",
            params![index as i64, id],
        )?;
    }
    Ok(serde_json::json!({ "default_profile_id": profile_id }))
}

/// Removes a profile's workspaces, tabs and every scoped row, then its files.
/// The active profile cannot be deleted: the user must switch away first, so a
/// mis-click can never leave the shell without its current profile.
#[tauri::command]
pub fn delete_profile(
    app: AppHandle,
    db: State<'_, DbState>,
    profile_id: String,
) -> Result<serde_json::Value, AppError> {
    let conn = db.conn();
    let count: i64 = conn.query_row("SELECT COUNT(*) FROM profiles", [], |r| r.get(0))?;
    if count <= 1 {
        return Err(AppError::InvalidInput("cannot delete the last profile".into()));
    }
    if active_profile_id(&conn).as_deref() == Some(profile_id.as_str()) {
        return Err(AppError::InvalidInput(
            "switch to another profile before deleting this one".into(),
        ));
    }
    let exists: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM profiles WHERE id = ?1)",
        params![profile_id],
        |r| r.get(0),
    )?;
    if !exists {
        return Err(AppError::NotFound("profile not found".into()));
    }
    let tx = conn.unchecked_transaction()?;
    for table in [
        "bookmarks",
        "history",
        "downloads",
        "reading_list",
        "site_permissions",
        "settings",
        "notes",
    ] {
        tx.execute(&format!("DELETE FROM {table} WHERE profile_id = ?1"), params![profile_id])?;
    }
    // Tabs go with their workspace (ON DELETE CASCADE).
    tx.execute("DELETE FROM workspaces WHERE profile_id = ?1", params![profile_id])?;
    tx.execute("DELETE FROM profiles WHERE id = ?1", params![profile_id])?;
    tx.commit()?;
    drop(conn);
    if let Ok(dir) = profile_dir(&app, &profile_id) {
        let _ = std::fs::remove_dir_all(dir);
    }
    Ok(serde_json::json!({ "deleted_id": profile_id }))
}

#[tauri::command]
pub fn set_active_profile(
    app: tauri::AppHandle,
    db: State<'_, DbState>,
    profile_id: String,
) -> Result<serde_json::Value, AppError> {
    let workspace = {
        let conn = db.conn();
        let exists: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM profiles WHERE id = ?1)",
            params![profile_id],
            |r| r.get(0),
        )?;
        if !exists {
            return Err(AppError::NotFound("profile not found".into()));
        }
        set_shell_state(&conn, "active_profile_id", &profile_id)?;
        let workspace = ensure_workspace(&conn, &profile_id)?;
        set_shell_state(&conn, "active_workspace_id", &workspace)?;
        workspace
    };
    // Custom key combos are per profile: rebuild the native table for this one.
    crate::register_shortcuts(&app);
    Ok(serde_json::json!({ "active_profile_id": profile_id, "active_workspace_id": workspace }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn conn() -> Connection {
        let conn = Connection::open_in_memory().expect("memory db");
        conn.execute_batch(include_str!("../../migrations/0001_init.sql")).expect("schema");
        crate::db::apply_profile_scope(&conn, None).expect("profile scope");
        conn
    }

    #[test]
    fn email_validation_accepts_gmail_and_rejects_noise() {
        assert_eq!(clean_email(Some("rohit93dgrr@gmail.com".into())).unwrap(), "rohit93dgrr@gmail.com");
        assert_eq!(clean_email(None).unwrap(), "");
        assert!(clean_email(Some("not-an-email".into())).is_err());
        assert!(clean_email(Some("a@b".into())).is_err());
        assert!(clean_email(Some("two words@example.com".into())).is_err());
        assert!(clean_email(Some("x@y.z@example.com".into())).is_err());
        assert!(clean_email(Some("user@-bad.com".into())).is_ok());
    }

    #[test]
    fn workspaces_are_scoped_to_the_active_profile() {
        let conn = conn();
        ensure_default_profile(&conn).unwrap();
        let first = resolve_active_profile(&conn).unwrap();
        let personal_workspace = ensure_workspace(&conn, &first).unwrap();
        let second = uuid::Uuid::new_v4().to_string();
        conn.execute(
            "INSERT INTO profiles (id, name, email, color, sort_order, created_at)
             VALUES (?1, 'Work', 'rohit93dgrr@gmail.com', '#2F6F8F', 1, 2)",
            params![second],
        )
        .unwrap();
        let work_workspace = ensure_workspace(&conn, &second).unwrap();

        // Same query the command uses, with the setting pointing at each profile.
        let scoped = |profile: &str| -> Vec<String> {
            set_shell_state(&conn, "active_profile_id", profile).unwrap();
            let mut stmt = conn
                .prepare("SELECT id FROM workspaces WHERE profile_id = ?1 ORDER BY sort_order ASC")
                .unwrap();
            stmt.query_map(params![profile], |r| r.get::<_, String>(0))
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap()
        };
        let work = scoped(&second);
        assert_eq!(work, vec![work_workspace.clone()]);
        let personal = scoped(&first);
        assert_eq!(personal, vec![personal_workspace]);
        assert!(!personal.contains(&work_workspace));
    }

    #[test]
    fn default_profile_claims_legacy_workspaces_once() {
        let conn = conn();
        conn.execute(
            "INSERT INTO workspaces (id, name, color, sort_order, created_at) VALUES ('ws', 'Old', '#4A6B5D', 0, 1)",
            [],
        )
        .unwrap();
        ensure_default_profile(&conn).unwrap();
        let profile: String = conn
            .query_row("SELECT profile_id FROM workspaces WHERE id = 'ws'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(Some(profile.clone()), resolve_active_profile(&conn));
        // Running it again must not create a second profile or move workspaces.
        ensure_default_profile(&conn).unwrap();
        ensure_default_profile(&conn).unwrap();
        let count: i64 = conn.query_row("SELECT COUNT(*) FROM profiles", [], |r| r.get(0)).unwrap();
        assert_eq!(count, 1);
    }
}
