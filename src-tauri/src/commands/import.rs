//! One-way import of bookmarks, history and (never) passwords from another
//! browser installed on this machine.
//!
//! Everything here is read-only against the source: Chromium and Firefox keep
//! their databases open, so the file (plus its `-wal`/`-shm` companions) is
//! copied to a temp directory first and opened with `SQLITE_OPEN_READ_ONLY`.
//! Import writes only to the active profile; the profile is resolved in Rust and
//! is not a parameter, so a bad argument cannot redirect rows elsewhere.
//!
//! Passwords are reported as skipped. Modern browser stores are encrypted with
//! DPAPI / Keychain / NSS, and Ritam does not invent decryption — that would be
//! building the password manager this release explicitly does not have.

use crate::commands::bookmarks_io::{insert_bookmarks, ParsedBookmark};
use crate::commands::profiles::resolve_active_profile;
use crate::db::{now_ms, DbState};
use crate::error::AppError;
use rusqlite::{params, Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::State;

const MAX_HISTORY: usize = 20_000;
const MAX_BOOKMARKS: usize = 5_000;

#[derive(Debug, Clone, Serialize)]
pub struct PasswordStore {
    pub readable: bool,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct BrowserSource {
    pub id: String,
    pub name: String,
    pub profile_paths: Vec<String>,
    pub password_store: PasswordStore,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct ImportOptions {
    pub bookmarks: bool,
    pub history: bool,
    pub passwords: bool,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct Counts {
    pub imported: usize,
    pub skipped: usize,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct PasswordResult {
    pub imported: usize,
    pub skipped_reason: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ImportReport {
    pub source: String,
    pub bookmarks: Counts,
    pub history: Counts,
    pub passwords: PasswordResult,
    pub warnings: Vec<String>,
}

fn encrypted_store() -> PasswordStore {
    PasswordStore {
        readable: false,
        reason: "the source store is encrypted; Ritam does not decrypt passwords".into(),
    }
}

fn home_dir() -> PathBuf {
    std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .map(PathBuf::from)
        .unwrap_or_default()
}

fn chromium_roots() -> Vec<(&'static str, &'static str, PathBuf)> {
    #[cfg(target_os = "windows")]
    {
        let local = std::env::var("LOCALAPPDATA").map(PathBuf::from).unwrap_or_default();
        vec![
            ("chrome", "Google Chrome", local.join("Google/Chrome/User Data")),
            ("edge", "Microsoft Edge", local.join("Microsoft/Edge/User Data")),
            ("brave", "Brave", local.join("BraveSoftware/Brave-Browser/User Data")),
        ]
    }
    #[cfg(target_os = "macos")]
    {
        let home = home_dir();
        vec![
            ("chrome", "Google Chrome", home.join("Library/Application Support/Google/Chrome")),
            ("edge", "Microsoft Edge", home.join("Library/Application Support/Microsoft Edge")),
            ("brave", "Brave", home.join("Library/Application Support/BraveSoftware/Brave-Browser")),
        ]
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let home = home_dir();
        vec![
            ("chrome", "Google Chrome", home.join(".config/google-chrome")),
            ("edge", "Microsoft Edge", home.join(".config/microsoft-edge")),
            ("brave", "Brave", home.join(".config/BraveSoftware/Brave-Browser")),
        ]
    }
}

/// Chromium keeps one directory per profile under a shared "User Data" root.
fn chromium_profile_dirs(root: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(root) else { return Vec::new() };
    let mut out: Vec<PathBuf> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.is_dir())
        .filter(|path| path.join("Bookmarks").exists() || path.join("History").exists())
        .collect();
    out.sort();
    out
}

fn firefox_profile_dirs(root: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(root) else { return Vec::new() };
    let mut out: Vec<PathBuf> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.is_dir() && path.join("places.sqlite").exists())
        .collect();
    out.sort();
    out
}

#[cfg(target_os = "macos")]
fn safari_root() -> PathBuf {
    home_dir().join("Library/Safari")
}

#[tauri::command]
pub fn detect_installed_browsers() -> Vec<BrowserSource> {
    let mut sources = Vec::new();
    for (id, name, root) in chromium_roots() {
        let paths = chromium_profile_dirs(&root);
        if !paths.is_empty() {
            sources.push(BrowserSource {
                id: id.to_string(),
                name: name.to_string(),
                profile_paths: paths.iter().map(|p| p.display().to_string()).collect(),
                password_store: encrypted_store(),
            });
        }
    }
    let firefox_root = home_dir().join("AppData/Roaming/Mozilla/Firefox/Profiles");
    #[cfg(not(target_os = "windows"))]
    let firefox_root = {
        let _ = &firefox_root;
        home_dir().join(".mozilla/firefox")
    };
    let firefox_paths = firefox_profile_dirs(&firefox_root);
    if !firefox_paths.is_empty() {
        sources.push(BrowserSource {
            id: "firefox".into(),
            name: "Mozilla Firefox".into(),
            profile_paths: firefox_paths.iter().map(|p| p.display().to_string()).collect(),
            password_store: encrypted_store(),
        });
    }
    #[cfg(target_os = "macos")]
    {
        let bookmarks = safari_root().join("Bookmarks.plist");
        if bookmarks.exists() {
            sources.push(BrowserSource {
                id: "safari".into(),
                name: "Safari".into(),
                profile_paths: vec![safari_root().display().to_string()],
                password_store: encrypted_store(),
            });
        }
    }
    sources
}

// ── Parsers (pure, unit-tested) ───────────────────────────────────────

fn collect_chromium_bookmarks(node: &serde_json::Value, out: &mut Vec<ParsedBookmark>) {
    if let Some(children) = node.get("children").and_then(|c| c.as_array()) {
        for child in children {
            collect_chromium_bookmarks(child, out);
        }
    }
    if node.get("type").and_then(|t| t.as_str()) == Some("url") {
        if let (Some(name), Some(url)) = (
            node.get("name").and_then(|v| v.as_str()),
            node.get("url").and_then(|v| v.as_str()),
        ) {
            out.push(ParsedBookmark {
                title: name.chars().take(500).collect(),
                url: url.chars().take(2_048).collect(),
            });
        }
    }
}

fn parse_chromium_bookmarks(raw: &str) -> Result<Vec<ParsedBookmark>, AppError> {
    let root: serde_json::Value = serde_json::from_str(raw)
        .map_err(|_| AppError::InvalidInput("browser bookmarks file is not valid JSON".into()))?;
    let mut out = Vec::new();
    if let Some(roots) = root.get("roots").and_then(|r| r.as_object()) {
        for value in roots.values() {
            collect_chromium_bookmarks(value, &mut out);
        }
    }
    out.truncate(MAX_BOOKMARKS);
    Ok(out)
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn parse_safari_bookmarks(bytes: &[u8]) -> Result<Vec<ParsedBookmark>, AppError> {
    let value = plist::Value::from_reader(std::io::Cursor::new(bytes))
        .map_err(|_| AppError::InvalidInput("Safari bookmarks file is not a valid plist".into()))?;
    let mut out = Vec::new();
    collect_safari_bookmarks(&value, &mut out);
    out.truncate(MAX_BOOKMARKS);
    Ok(out)
}

fn collect_safari_bookmarks(value: &plist::Value, out: &mut Vec<ParsedBookmark>) {
    if let Some(array) = value.as_array() {
        for item in array {
            collect_safari_bookmarks(item, out);
        }
        return;
    }
    let Some(dict) = value.as_dictionary() else { return };
    if let Some(url) = dict.get("URLString").and_then(|v| v.as_string()) {
        let title = dict
            .get("URIDictionary")
            .and_then(|v| v.as_dictionary())
            .and_then(|d| d.get("title"))
            .and_then(|v| v.as_string())
            .unwrap_or(url);
        out.push(ParsedBookmark {
            title: title.chars().take(500).collect(),
            url: url.chars().take(2_048).collect(),
        });
    }
    if let Some(children) = dict.get("Children") {
        collect_safari_bookmarks(children, out);
    }
}

/// Chrome timestamps are microseconds since 1601-01-01; the UI shows Unix ms.
fn chrome_time_to_ms(value: i64) -> i64 {
    if value <= 0 {
        return now_ms();
    }
    (value / 1000 - 11_644_473_600_000).max(0)
}

fn firefox_time_to_ms(value: i64) -> i64 {
    if value <= 0 {
        return now_ms();
    }
    (value / 1000).max(0)
}

// ── Reading a source database without touching it ─────────────────────

struct TempCopy {
    dir: PathBuf,
    db: PathBuf,
}

impl Drop for TempCopy {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn copy_sqlite(source: &Path) -> Result<TempCopy, AppError> {
    let dir = std::env::temp_dir().join(format!("ritam-import-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir)?;
    let db = dir.join("source.sqlite");
    std::fs::copy(source, &db)?;
    for suffix in ["-wal", "-shm"] {
        let companion = PathBuf::from(format!("{}{suffix}", source.display()));
        if companion.exists() {
            let _ = std::fs::copy(&companion, dir.join(format!("source.sqlite{suffix}")));
        }
    }
    Ok(TempCopy { dir, db })
}

fn open_read_only(path: &Path) -> Result<Connection, AppError> {
    Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| AppError::InvalidInput(format!("could not read browser database: {e}")))
}

fn chromium_history(conn: &Connection) -> Vec<(String, String, i64, i64)> {
    let Ok(mut stmt) =
        conn.prepare("SELECT url, title, last_visit_time, visit_count FROM urls ORDER BY last_visit_time DESC")
    else {
        return Vec::new();
    };
    let rows = stmt.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, Option<String>>(1)?.unwrap_or_default(),
            r.get::<_, i64>(2).unwrap_or(0),
            r.get::<_, i64>(3).unwrap_or(1),
        ))
    });
    let Ok(rows) = rows else { return Vec::new() };
    rows.flatten()
        .map(|(url, title, when, count)| (url, title, chrome_time_to_ms(when), count.max(1)))
        .take(MAX_HISTORY)
        .collect()
}

fn firefox_bookmarks(conn: &Connection) -> Vec<ParsedBookmark> {
    let Ok(mut stmt) = conn.prepare(
        "SELECT b.title, p.url FROM moz_bookmarks b JOIN moz_places p ON b.fk = p.id
         WHERE b.type = 1 AND p.url IS NOT NULL",
    ) else {
        return Vec::new();
    };
    let rows = stmt.query_map([], |r| {
        Ok(ParsedBookmark {
            title: r.get::<_, Option<String>>(0)?.unwrap_or_default(),
            url: r.get::<_, String>(1)?,
        })
    });
    let Ok(rows) = rows else { return Vec::new() };
    rows.flatten().take(MAX_BOOKMARKS).collect()
}

fn firefox_history(conn: &Connection) -> Vec<(String, String, i64, i64)> {
    let Ok(mut stmt) = conn.prepare(
        "SELECT url, title, last_visit_date, visit_count FROM moz_places
         WHERE last_visit_date IS NOT NULL ORDER BY last_visit_date DESC",
    ) else {
        return Vec::new();
    };
    let rows = stmt.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, Option<String>>(1)?.unwrap_or_default(),
            r.get::<_, i64>(2).unwrap_or(0),
            r.get::<_, i64>(3).unwrap_or(1),
        ))
    });
    let Ok(rows) = rows else { return Vec::new() };
    rows.flatten()
        .map(|(url, title, when, count)| (url, title, firefox_time_to_ms(when), count.max(1)))
        .take(MAX_HISTORY)
        .collect()
}

fn insert_history(
    conn: &Connection,
    profile: &str,
    entries: &[(String, String, i64, i64)],
) -> Counts {
    let mut counts = Counts::default();
    for (url, title, visited_at, visit_count) in entries {
        let Ok(target) = crate::navigation::validate_saved_url(url) else {
            counts.skipped += 1;
            continue;
        };
        if target.starts_with("govind://") {
            counts.skipped += 1;
            continue;
        }
        let clean_title: String = if title.is_empty() { target.clone() } else { title.clone() };
        let result = conn.execute(
            "INSERT INTO history (id, profile_id, url, title, visited_at, visit_count)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(profile_id, url) DO UPDATE SET
               visited_at = MAX(history.visited_at, excluded.visited_at),
               visit_count = MAX(history.visit_count, excluded.visit_count),
               title = CASE WHEN excluded.visited_at > history.visited_at
                            THEN excluded.title ELSE history.title END",
            params![
                uuid::Uuid::new_v4().to_string(),
                profile,
                target,
                clean_title.chars().take(500).collect::<String>(),
                visited_at,
                visit_count
            ],
        );
        match result {
            Ok(1) => counts.imported += 1,
            Ok(_) => counts.skipped += 1,
            Err(_) => counts.skipped += 1,
        }
    }
    counts
}

/// Only paths Rust itself discovered are accepted, so a caller cannot point the
/// importer at an arbitrary file.
fn resolve_source(browser_id: &str, profile_path: &str) -> Result<BrowserSource, AppError> {
    let sources = detect_installed_browsers();
    let source = sources
        .into_iter()
        .find(|source| source.id == browser_id)
        .ok_or_else(|| AppError::NotFound("browser not found on this machine".into()))?;
    if !source.profile_paths.iter().any(|path| path == profile_path) {
        return Err(AppError::InvalidInput(
            "that browser profile was not detected on this machine".into(),
        ));
    }
    Ok(source)
}

#[tauri::command]
pub fn import_from_browser(
    db: State<'_, DbState>,
    browser_id: String,
    profile_path: String,
    options: Option<ImportOptions>,
) -> Result<ImportReport, AppError> {
    let options = options.unwrap_or(ImportOptions {
        bookmarks: true,
        history: true,
        passwords: false,
    });
    let source = resolve_source(&browser_id, &profile_path)?;
    let base = PathBuf::from(&profile_path);
    let mut report = ImportReport {
        source: source.name.clone(),
        bookmarks: Counts::default(),
        history: Counts::default(),
        passwords: PasswordResult {
            imported: 0,
            skipped_reason: "passwords are never imported: the source store is encrypted".into(),
        },
        warnings: Vec::new(),
    };
    if options.passwords {
        report.warnings.push(
            "Passwords were not imported. Ritam has no password manager in this release.".into(),
        );
    }

    let conn = db.conn();
    let profile = resolve_active_profile(&conn)
        .ok_or_else(|| AppError::InvalidInput("no active profile".into()))?;

    if options.bookmarks {
        let parsed = match source.id.as_str() {
            "firefox" => {
                let places = base.join("places.sqlite");
                match copy_sqlite(&places).and_then(|copy| open_read_only(&copy.db)) {
                    Ok(read) => firefox_bookmarks(&read),
                    Err(_) => {
                        report
                            .warnings
                            .push("Could not read Firefox bookmarks (places.sqlite).".into());
                        Vec::new()
                    }
                }
            }
            "safari" => {
                let file = base.join("Bookmarks.plist");
                match std::fs::read(&file) {
                    Ok(bytes) => parse_safari_bookmarks(&bytes).unwrap_or_else(|_| {
                        report.warnings.push("Safari bookmarks file could not be read.".into());
                        Vec::new()
                    }),
                    Err(_) => {
                        report.warnings.push("Safari bookmarks file is missing.".into());
                        Vec::new()
                    }
                }
            }
            _ => {
                let file = base.join("Bookmarks");
                match std::fs::read_to_string(&file) {
                    Ok(raw) => parse_chromium_bookmarks(&raw).unwrap_or_else(|_| {
                        report
                            .warnings
                            .push("Bookmarks file could not be parsed; nothing imported.".into());
                        Vec::new()
                    }),
                    Err(_) => {
                        report
                            .warnings
                            .push("This browser profile has no Bookmarks file.".into());
                        Vec::new()
                    }
                }
            }
        };
        match insert_bookmarks(&conn, &parsed) {
            Ok(summary) => {
                report.bookmarks.imported = summary.imported + summary.duplicates;
                report.bookmarks.skipped = summary.skipped;
            }
            Err(_) => report
                .warnings
                .push("Bookmarks could not be written to this profile.".into()),
        }
    }

    if options.history {
        let entries = if source.id == "firefox" {
            match copy_sqlite(&base.join("places.sqlite")).and_then(|copy| open_read_only(&copy.db)) {
                Ok(read) => firefox_history(&read),
                Err(_) => {
                    report
                        .warnings
                        .push("Could not read Firefox history (places.sqlite).".into());
                    Vec::new()
                }
            }
        } else if source.id == "safari" {
            Vec::new()
        } else {
            match copy_sqlite(&base.join("History")).and_then(|copy| open_read_only(&copy.db)) {
                Ok(read) => chromium_history(&read),
                Err(_) => {
                    report.warnings.push(
                        "Could not read browser history. Close the browser and try again.".into(),
                    );
                    Vec::new()
                }
            }
        };
        report.history = insert_history(&conn, &profile, &entries);
    }

    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::apply_profile_scope;

    const CHROME_BOOKMARKS: &str = r#"{
      "roots": {
        "bookmark_bar": {
          "children": [
            {"type": "url", "name": "Rust", "url": "https://www.rust-lang.org/"},
            {"type": "folder", "name": "Docs", "children": [
              {"type": "url", "name": "MDN", "url": "https://developer.mozilla.org/"}
            ]}
          ]
        },
        "other": {"children": [
          {"type": "url", "name": "Tauri", "url": "https://tauri.app/"}
        ]}
      }
    }"#;

    const SAFARI_BOOKMARKS: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>Children</key><array>
  <dict><key>Title</key><string>Favorites</string><key>Children</key><array>
    <dict><key>URLString</key><string>https://example.com/</string>
      <key>URIDictionary</key><dict><key>title</key><string>Example</string></dict></dict>
    <dict><key>URLString</key><string>https://example.org/</string>
      <key>URIDictionary</key><dict><key>title</key><string>Example Org</string></dict></dict>
  </array></dict>
</array></dict></plist>"#;

    fn conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(include_str!("../../migrations/0001_init.sql")).unwrap();
        apply_profile_scope(&conn, None).unwrap();
        crate::commands::profiles::ensure_default_profile(&conn).unwrap();
        conn
    }

    #[test]
    fn chrome_bookmarks_fixture_yields_three_entries() {
        let parsed = parse_chromium_bookmarks(CHROME_BOOKMARKS).unwrap();
        assert_eq!(parsed.len(), 3);
        assert!(parsed.iter().any(|b| b.title == "MDN"));
    }

    #[test]
    fn malformed_chrome_bookmarks_are_rejected() {
        assert!(parse_chromium_bookmarks("not json").is_err());
    }

    #[test]
    fn safari_plist_fixture_yields_two_entries() {
        let parsed = parse_safari_bookmarks(SAFARI_BOOKMARKS.as_bytes()).unwrap();
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0].title, "Example");
    }

    #[test]
    fn chrome_timestamps_become_unix_milliseconds() {
        // 2026-01-01T00:00:00Z in Chrome's 1601 epoch (microseconds).
        let value = 13_400_000_000_000_000_i64;
        let ms = chrome_time_to_ms(value);
        assert!(ms > 1_700_000_000_000 && ms < 1_900_000_000_000, "got {ms}");
        assert!(chrome_time_to_ms(0) > 0);
    }

    #[test]
    fn firefox_places_fixture_imports_two_bookmarks_and_history() {
        let dir = std::env::temp_dir().join(format!("ritam-import-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let places = dir.join("places.sqlite");
        {
            let db = Connection::open(&places).unwrap();
            db.execute_batch(
                "CREATE TABLE moz_places (id INTEGER PRIMARY KEY, url TEXT, title TEXT,
                   visit_count INTEGER, last_visit_date INTEGER);
                 CREATE TABLE moz_bookmarks (id INTEGER PRIMARY KEY, type INTEGER, fk INTEGER, title TEXT);
                 INSERT INTO moz_places VALUES (1, 'https://a.example/', 'A', 3, 1700000000000000);
                 INSERT INTO moz_places VALUES (2, 'https://b.example/', 'B', 1, 1700000001000000);
                 INSERT INTO moz_bookmarks VALUES (10, 1, 1, 'A');
                 INSERT INTO moz_bookmarks VALUES (11, 1, 2, 'B');",
            )
            .unwrap();
        }
        let read = open_read_only(&places).unwrap();
        assert_eq!(firefox_bookmarks(&read).len(), 2);
        let history = firefox_history(&read);
        assert_eq!(history.len(), 2);
        assert_eq!(history[0].2, 1_700_000_001_000);

        let conn = conn();
        let profile = resolve_active_profile(&conn).unwrap();
        let counts = insert_history(&conn, &profile, &history);
        assert_eq!(counts.imported, 2);
        // Importing the same rows again keeps the higher visit count.
        insert_history(&conn, &profile, &history);
        let total: i64 = conn.query_row("SELECT COUNT(*) FROM history", [], |r| r.get(0)).unwrap();
        assert_eq!(total, 2);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn history_is_scoped_to_one_profile() {
        let conn = conn();
        let first = resolve_active_profile(&conn).unwrap();
        let entries = vec![("https://example.com/".to_string(), "Example".to_string(), 5, 1)];
        insert_history(&conn, &first, &entries);
        conn.execute(
            "INSERT INTO profiles (id, name, email, color, sort_order, created_at)
             VALUES ('second', 'Work', '', '#2F6F8F', 1, 1)",
            [],
        )
        .unwrap();
        insert_history(&conn, "second", &entries);
        let scoped: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM history WHERE profile_id = 'second'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(scoped, 1);
    }
}
