//! In-app file viewer backend: read one user-selected document and hand the
//! raw bytes to the shell, which renders them locally. No parser runs here and
//! nothing is ever uploaded.

use crate::error::AppError;
use std::path::Path;

/// One preview may not exceed this; larger files would exhaust memory long
/// before the webview could render them.
const MAX_VIEW_BYTES: u64 = 64 * 1024 * 1024;

/// Formats the shell can render. Mirrors `VIEWER_KINDS` in
/// `ui/js/lib/file-preview.js`; keep the two lists in sync.
pub const VIEWABLE_EXTENSIONS: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "webp", "bmp", "avif", "svg", "ico", //
    "mp4", "webm", "mov", "m4v", "ogv", //
    "pdf", "docx", "xlsx", "csv", "json", "md", "markdown", "txt", "log",
];

/// Read a viewable file as raw bytes. The extension allowlist keeps this from
/// becoming a general-purpose filesystem read for the renderer.
#[tauri::command]
pub async fn read_viewer_bytes(path: String) -> Result<tauri::ipc::Response, AppError> {
    let file = Path::new(&path);
    let extension = file
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if !VIEWABLE_EXTENSIONS.contains(&extension.as_str()) {
        return Err(AppError::InvalidInput(format!(
            "the viewer does not support .{extension} files"
        )));
    }

    let meta = std::fs::metadata(file)?;
    if !meta.is_file() {
        return Err(AppError::InvalidInput("not a file".into()));
    }
    if meta.len() > MAX_VIEW_BYTES {
        return Err(AppError::InvalidInput(format!(
            "file is too large to preview ({} MB limit)",
            MAX_VIEW_BYTES / (1024 * 1024)
        )));
    }

    let bytes = std::fs::read(file)?;
    Ok(tauri::ipc::Response::new(bytes))
}
