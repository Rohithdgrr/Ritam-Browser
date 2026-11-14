//! Bookmark import / export (PRD P1).
//!
//! Import and export use the Netscape bookmark file format — the universal
//! HTML format that Chrome, Firefox and Edge all read *and* write, so
//! bookmarks move between Govind and other browsers in both directions.
//!
//! The parsing/serialising lives here in Rust (the security boundary): URLs are
//! allowlisted by `validate_saved_url` before they reach the database. The file
//! itself is chosen by the user through native open/save dialogs; Govind never
//! reads a path the user did not pick.

use crate::db::{now_ms, DbState};
use crate::error::AppError;
use crate::models::Bookmark;
use crate::navigation::validate_saved_url;
use rusqlite::params;
use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, State};

/// Upper bounds that keep a hostile/oversized import file from doing damage.
const MAX_ITEMS: usize = 5_000;
const MAX_FILE_BYTES: u64 = 20 * 1024 * 1024; // 20 MB
const MAX_TITLE: usize = 500;
const MAX_URL: usize = 2_048;

#[derive(Debug, Clone, Serialize)]
pub struct ImportSummary {
    pub imported: usize,
    pub skipped: usize,
    pub duplicates: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct ExportSummary {
    pub path: String,
    pub count: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct ParsedBookmark {
    pub title: String,
    pub url: String,
}

// ── Netscape HTML parsing (pure, unit-tested) ─────────────────────────

fn decode_entities(s: &str) -> String {
    const ENTITIES: &[(&str, &str)] = &[
        ("&amp;", "&"),
        ("&lt;", "<"),
        ("&gt;", ">"),
        ("&quot;", "\""),
        ("&#39;", "'"),
        ("&apos;", "'"),
    ];
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(idx) = rest.find('&') {
        out.push_str(&rest[..idx]);
        let after = &rest[idx..];
        let mut matched = None;
        for (entity, decoded) in ENTITIES {
            if let Some(rem) = after.strip_prefix(entity) {
                matched = Some((*decoded, rem));
                break;
            }
        }
        match matched {
            Some((decoded, rem)) => {
                out.push_str(decoded);
                rest = rem;
            }
            None => {
                out.push('&');
                rest = &after[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

fn strip_tags(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut depth = 0usize;
    for ch in s.chars() {
        match ch {
            '<' => depth += 1,
            '>' => depth = depth.saturating_sub(1),
            _ if depth == 0 => out.push(ch),
            _ => {}
        }
    }
    out
}

fn is_http_url(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    lower.starts_with("https://") || lower.starts_with("http://")
}

/// Extract `(title, url)` pairs from a Netscape bookmark file. Dedupes by URL
/// (first wins) and skips anything that is not http(s).
pub fn parse_bookmarks_html(html: &str) -> Vec<ParsedBookmark> {
    let bytes = html.as_bytes();
    let lower = html.to_ascii_lowercase();
    let mut out: Vec<ParsedBookmark> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut search_from = 0usize;

    while let Some(rel) = lower[search_from..].find("<a") {
        let tag_start = search_from + rel;
        // Only consider real <a ...> tags (next char is whitespace or '>').
        let after = bytes.get(tag_start + 2).copied().unwrap_or(b' ');
        if !(after == b' ' || after == b'\t' || after == b'\r' || after == b'\n' || after == b'>') {
            search_from = tag_start + 2;
            continue;
        }
        let Some(tag_end_rel) = lower[tag_start..].find('>') else { break };
        let tag_end = tag_start + tag_end_rel;
        let tag = &html[tag_start..=tag_end];
        let Some(close_rel) = lower[tag_end..].find("</a>") else { break };
        let close_start = tag_end + close_rel;
        let inner = &html[tag_end + 1..close_start];

        if let Some(url) = extract_href(tag) {
            let url = decode_entities(url.trim());
            if is_http_url(&url) {
                let title = decode_entities(&strip_tags(inner)).trim().to_string();
                let url: String = url.chars().take(MAX_URL).collect();
                let title: String = title.chars().take(MAX_TITLE).collect();
                if seen.insert(url.clone()) {
                    out.push(ParsedBookmark { title, url });
                }
            }
        }
        search_from = close_start + 4;
    }
    out
}

/// Pull the `href` attribute value out of a single `<a …>` tag.
///
/// Requires `href` to start a new attribute (tag start or preceded by
/// whitespace) so `data-href="…"` is not mistaken for the real target.
fn extract_href(tag: &str) -> Option<&str> {
    let lower = tag.to_ascii_lowercase();
    let bytes = lower.as_bytes();
    let mut search = 0usize;
    let pos = loop {
        let rel = lower[search..].find("href")?;
        let abs = search + rel;
        let before_ok = abs == 0
            || bytes[abs - 1].is_ascii_whitespace();
        if before_ok {
            break abs;
        }
        search = abs + 4;
    };
    let after = &tag[pos + 4..];
    let after = after.trim_start();
    let after = after.strip_prefix('=')?.trim_start();
    let first = after.chars().next()?;
    if first == '"' || first == '\'' {
        let end = after[1..].find(first)? + 1;
        Some(&after[1..end])
    } else {
        let end = after.find(|c: char| c.is_whitespace() || c == '>')?;
        Some(&after[..end])
    }
}

// ── Netscape HTML serialising (pure, unit-tested) ─────────────────────

fn escape_html(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for ch in s.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            _ => out.push(ch),
        }
    }
    out
}

/// Build a Netscape bookmark file body from bookmark rows. Only http(s) URLs are
/// written — the format that every browser can re-import.
pub fn build_bookmarks_html(bookmarks: &[Bookmark]) -> String {
    let mut rows = String::new();
    for b in bookmarks {
        if !is_http_url(&b.url) {
            continue;
        }
        rows.push_str(&format!(
            "    <DT><A HREF=\"{}\">{}</A>\n",
            escape_html(&b.url),
            escape_html(if b.title.is_empty() { &b.url } else { &b.title })
        ));
    }
    format!(
        "<!DOCTYPE NETSCAPE-Bookmark-file-1>\n\
<!-- Generated by Govind Browser -->\n\
<META HTTP-EQUIV=\"Content-Type\" CONTENT=\"text/html; charset=UTF-8\">\n\
<TITLE>Bookmarks</TITLE>\n\
<H1>Bookmarks</H1>\n\
<DL><p>\n{rows}</DL><p>\n"
    )
}

// ── Commands ──────────────────────────────────────────────────────────

/// Persist parsed items into the bookmarks table, honouring the URL unique
/// constraint (existing URL → update title, keep favourite flag).
fn insert_bookmarks(conn: &rusqlite::Connection, items: &[ParsedBookmark]) -> Result<ImportSummary, AppError> {
    let mut summary = ImportSummary { imported: 0, skipped: 0, duplicates: 0 };
    let mut order: i64 =
        conn.query_row("SELECT COALESCE(MAX(sort_order), -1) + 1 FROM bookmarks", [], |r| r.get(0))?;
    for item in items {
        if summary.imported + summary.duplicates >= MAX_ITEMS {
            summary.skipped += 1;
            continue;
        }
        // Re-validate at the boundary: the parser already filters, but this is
        // the single place that decides what may touch the database.
        let Ok(target) = validate_saved_url(&item.url) else {
            summary.skipped += 1;
            continue;
        };
        let title = if item.title.is_empty() { target.clone() } else { item.title.clone() };
        let existing: Option<String> =
            conn.query_row("SELECT id FROM bookmarks WHERE url = ?1", params![target], |r| r.get(0)).ok();
        if existing.is_some() {
            conn.execute(
                "UPDATE bookmarks SET title = ?1 WHERE url = ?2",
                params![title, target],
            )?;
            summary.duplicates += 1;
            continue;
        }
        let id = uuid::Uuid::new_v4().to_string();
        conn.execute(
            "INSERT INTO bookmarks (id, title, url, is_favorite, sort_order, created_at)
             VALUES (?1, ?2, ?3, 0, ?4, ?5)",
            params![id, title, target, order, now_ms()],
        )?;
        order += 1;
        summary.imported += 1;
    }
    Ok(summary)
}

/// Open a native file picker, parse the chosen bookmarks file and import it.
#[tauri::command]
pub async fn import_bookmarks_file(
    app: AppHandle,
    db: State<'_, DbState>,
) -> Result<ImportSummary, AppError> {
    use tauri_plugin_dialog::DialogExt;

    let picked = app
        .dialog()
        .file()
        .add_filter("Bookmark files", &["html", "htm"])
        .add_filter("All files", &["*"])
        .blocking_pick_file();

    let Some(file_path) = picked else {
        return Err(AppError::InvalidInput("import cancelled".into()));
    };

    let path = file_path.into_path().map_err(|e| AppError::InvalidInput(format!("bad file path: {e}")))?;
    let summary = import_bookmarks_from_path(&db, &path)?;
    Ok(summary)
}

/// Import from an explicit path (used by the command above and by tests).
pub fn import_bookmarks_from_path(db: &DbState, path: &Path) -> Result<ImportSummary, AppError> {
    let meta = std::fs::metadata(path)?;
    if !meta.is_file() {
        return Err(AppError::InvalidInput("not a file".into()));
    }
    if meta.len() > MAX_FILE_BYTES {
        return Err(AppError::InvalidInput("bookmark file is too large".into()));
    }
    let html = std::fs::read_to_string(path)?;
    let items = parse_bookmarks_html(&html);
    let conn = db.conn();
    insert_bookmarks(&conn, &items)
}

/// Import bookmarks from an in-memory Netscape HTML document.
///
/// Used by the browser preview (which reads the chosen file with the File API,
/// since it has no native dialog) and by any caller that already holds the
/// text. Parsing and URL validation still happen here, in Rust.
#[tauri::command]
pub fn import_bookmarks_html(db: State<'_, DbState>, html: String) -> Result<ImportSummary, AppError> {
    if html.len() as u64 > MAX_FILE_BYTES {
        return Err(AppError::InvalidInput("bookmark data is too large".into()));
    }
    let items = parse_bookmarks_html(&html);
    let conn = db.conn();
    insert_bookmarks(&conn, &items)
}

/// Serialise every stored bookmark as a Netscape HTML document.
///
/// Used by the browser preview (blob download) and by the export command.
#[tauri::command]
pub fn export_bookmarks_html(db: State<'_, DbState>) -> Result<String, AppError> {
    export_bookmarks_to_string(&db)
}

/// Ask the user where to save the bookmarks file, then write it.
#[tauri::command]
pub async fn export_bookmarks_file(
    app: AppHandle,
    db: State<'_, DbState>,
) -> Result<ExportSummary, AppError> {
    use tauri_plugin_dialog::DialogExt;

    let file_path = app
        .dialog()
        .file()
        .add_filter("Bookmark files", &["html"])
        .set_file_name("govind-bookmarks.html")
        .blocking_save_file();

    let Some(file_path) = file_path else {
        return Err(AppError::InvalidInput("export cancelled".into()));
    };

    let mut path: PathBuf =
        file_path.into_path().map_err(|e| AppError::InvalidInput(format!("bad file path: {e}")))?;
    // Browsers import by extension; make sure it ends in .html.
    if path.extension().and_then(|e| e.to_str()).map(|e| e.eq_ignore_ascii_case("html")) != Some(true) {
        path.set_extension("html");
    }

    let html = export_bookmarks_to_string(&db)?;
    let count = html.matches("<DT><A ").count();
    write_atomic(&path, html.as_bytes())?;
    Ok(ExportSummary { path: path.display().to_string(), count })
}

/// Read every bookmark and serialise it as a Netscape file.
pub fn export_bookmarks_to_string(db: &DbState) -> Result<String, AppError> {
    let conn = db.conn();
    let mut stmt = conn.prepare(
        "SELECT id, title, url, is_favorite, sort_order, created_at FROM bookmarks
         ORDER BY is_favorite DESC, sort_order ASC, created_at DESC",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(Bookmark {
            id: row.get(0)?,
            title: row.get(1)?,
            url: row.get(2)?,
            is_favorite: row.get(3)?,
            sort_order: row.get(4)?,
            created_at: row.get(5)?,
        })
    })?;
    let mut bookmarks = Vec::new();
    for row in rows {
        bookmarks.push(row?);
    }
    Ok(build_bookmarks_html(&bookmarks))
}

/// Write to a temp sibling, then rename over the target (never leaves a
/// half-written file behind if the process dies mid-write).
fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), AppError> {
    let dir = path.parent().unwrap_or_else(|| Path::new("."));
    let tmp = dir.join(format!(".govind-export-{}", uuid::Uuid::new_v4()));
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"<!DOCTYPE NETSCAPE-Bookmark-file-1>
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<DL><p>
    <DT><A HREF="https://example.com/">Example &amp; Co</A>
    <DT><A HREF='https://quoted.org/x'>Single quoted</A>
    <DT><A HREF=https://bare.org/y>Bare</A>
    <DT><A HREF="https://dup.com/a">First</A>
    <DT><A HREF="https://dup.com/a">Second</A>
    <DT><A HREF="javascript:void(0)">Evil</A>
    <DT><A HREF="file:///etc/passwd">Local</A>
    <DT><A HREF="https://nested.com">Some <b>bold</b> title</A>
    <DT><A HREF="https://nested.com/nested">Nested <A HREF="https://ignored.com">ignore me</A></DT>
</DL><p>"#;

    #[test]
    fn parses_exported_format() {
        let items = parse_bookmarks_html(SAMPLE);
        assert_eq!(items[0].title, "Example & Co");
        assert_eq!(items[0].url, "https://example.com/");
        assert_eq!(items[1].url, "https://quoted.org/x");
        assert_eq!(items[2].url, "https://bare.org/y");
        assert_eq!(items[3].title, "First");
    }

    #[test]
    fn dedupes_and_filters_dangerous() {
        let items = parse_bookmarks_html(SAMPLE);
        assert!(items.iter().all(|i| i.url.starts_with("http")));
        let dups = items.iter().filter(|i| i.url == "https://dup.com/a").count();
        assert_eq!(dups, 1);
    }

    #[test]
    fn strips_markup_from_title() {
        let items = parse_bookmarks_html(SAMPLE);
        let nested = items.iter().find(|i| i.url == "https://nested.com").unwrap();
        assert_eq!(nested.title, "Some bold title");
    }

    #[test]
    fn round_trips() {
        let bookmarks: Vec<Bookmark> = ["https://govind.test/", "https://govind.test/two"]
            .iter()
            .enumerate()
            .map(|(i, url)| Bookmark {
                id: i.to_string(),
                title: format!("T & <{i}>"),
                url: url.to_string(),
                is_favorite: 0,
                sort_order: i as i64,
                created_at: 0,
            })
            .collect();
        let html = build_bookmarks_html(&bookmarks);
        let parsed = parse_bookmarks_html(&html);
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0].title, "T & <0>");
    }

    #[test]
    fn skips_non_http_on_export() {
        let bookmarks = vec![Bookmark {
            id: "1".into(),
            title: "x".into(),
            url: "file:///nope".into(),
            is_favorite: 0,
            sort_order: 0,
            created_at: 0,
        }];
        let html = build_bookmarks_html(&bookmarks);
        assert_eq!(parse_bookmarks_html(&html).len(), 0);
    }

    #[test]
    fn empty_input_is_empty() {
        assert!(parse_bookmarks_html("").is_empty());
    }
}