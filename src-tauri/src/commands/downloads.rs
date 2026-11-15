//! Download destination rules: sort files into folders and rename them.
//!
//! The engine (WebView2/wry) chooses the initial destination and then hands it
//! to `on_download`, which lets us rewrite the path before the transfer starts.
//! Everything here is a pure path decision except `unique_path`, which touches
//! the filesystem to avoid overwriting an existing file.

use std::path::{Path, PathBuf};

/// Folder a file is sorted into, by extension. `None` keeps the file where the
/// engine put it — unknown types are not shoved into an "Other" pile.
fn category_for(ext: &str) -> Option<&'static str> {
    Some(match ext {
        "jpg" | "jpeg" | "png" | "gif" | "webp" | "svg" | "bmp" | "heic" | "avif" => "Images",
        "mp4" | "mkv" | "webm" | "mov" | "avi" | "m4v" => "Video",
        "mp3" | "m4a" | "flac" | "wav" | "ogg" | "opus" => "Audio",
        "zip" | "7z" | "rar" | "tar" | "gz" | "bz2" | "xz" => "Archives",
        "pdf" | "doc" | "docx" | "xls" | "xlsx" | "ppt" | "pptx" | "txt" | "md" | "csv"
        | "epub" => "Documents",
        "exe" | "msi" | "dmg" | "pkg" | "deb" | "rpm" | "apk" | "appimage" => "Installers",
        _ => return None,
    })
}

pub fn extension_of(path: &Path) -> String {
    path.extension()
        .map(|ext| ext.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default()
}

/// `YYYY-MM-DD` in UTC, used by the `{date}` token.
pub fn date_stamp(now_ms: i64) -> String {
    // Howard Hinnant's civil_from_days.
    let days = now_ms.div_euclid(86_400_000);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}")
}

/// Filenames must survive every filesystem: no separators (a pattern is not a
/// path), no control characters, no leading/trailing dots, bounded length.
fn sanitize(value: &str) -> String {
    let cleaned: String = value
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '-',
            c if c.is_control() => '-',
            c => c,
        })
        .collect();
    cleaned.trim().trim_matches('.').trim().chars().take(120).collect()
}

/// Apply a rename pattern. Tokens: `{name}`, `{ext}`, `{host}`, `{date}`.
/// When the pattern has no `{ext}` token the original extension is appended.
pub fn render_name(pattern: &str, stem: &str, ext: &str, host: &str, date: &str) -> String {
    let filled = pattern
        .replace("{name}", stem)
        .replace("{ext}", ext)
        .replace("{host}", host)
        .replace("{date}", date);
    let cleaned = sanitize(&filled);
    let base = if cleaned.is_empty() { sanitize(stem) } else { cleaned };
    if ext.is_empty() || pattern.contains("{ext}") {
        base
    } else {
        format!("{base}.{ext}")
    }
}

/// Never clobber an existing file: "report.pdf" → "report (2).pdf".
fn unique_path(path: PathBuf) -> PathBuf {
    if !path.exists() {
        return path;
    }
    let parent = path.parent().map(Path::to_path_buf).unwrap_or_default();
    let stem = path
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "download".into());
    let ext = extension_of(&path);
    for n in 2..1000 {
        let candidate = parent.join(if ext.is_empty() {
            format!("{stem} ({n})")
        } else {
            format!("{stem} ({n}).{ext}")
        });
        if !candidate.exists() {
            return candidate;
        }
    }
    path
}

/// Destination for an incoming download. `organize` moves known file types into
/// a category folder beside the engine's chosen path; `pattern` renames.
/// An empty pattern and `organize == false` leave the path untouched.
pub fn destination_for(
    path: &Path,
    url: &str,
    organize: bool,
    pattern: &str,
    date: &str,
) -> PathBuf {
    let ext = extension_of(path);
    let stem = path
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "download".into());
    let host = tauri::Url::parse(url)
        .ok()
        .and_then(|parsed| parsed.host_str().map(|h| h.trim_start_matches("www.").to_string()))
        .unwrap_or_default();

    let mut target = path.to_path_buf();
    if organize {
        if let (Some(category), Some(parent), Some(name)) =
            (category_for(&ext), path.parent(), path.file_name())
        {
            target = parent.join(category).join(name);
        }
    }
    let pattern = pattern.trim();
    if !pattern.is_empty() {
        target.set_file_name(render_name(pattern, &stem, &ext, &host, date));
    }
    unique_path(target)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn date_stamp_formats_epoch_days() {
        assert_eq!(date_stamp(0), "1970-01-01");
        assert_eq!(date_stamp(1_700_000_000_000), "2023-11-14");
    }

    #[test]
    fn known_types_are_sorted_into_category_folders() {
        let organized = destination_for(
            Path::new("C:/Users/me/Downloads/report.pdf"),
            "https://example.com/report.pdf",
            true,
            "",
            "2026-11-15",
        );
        assert_eq!(organized, PathBuf::from("C:/Users/me/Downloads/Documents/report.pdf"));
    }

    #[test]
    fn unknown_types_stay_where_the_engine_put_them() {
        let path = Path::new("C:/Users/me/Downloads/data.bin");
        let kept = destination_for(path, "https://example.com/data.bin", true, "", "2026-11-15");
        assert_eq!(kept, path);
    }

    #[test]
    fn no_rules_means_no_change() {
        let path = Path::new("C:/Users/me/Downloads/movie.mp4");
        let same = destination_for(path, "https://example.com/movie.mp4", false, "", "2026-11-15");
        assert_eq!(same, path);
    }

    #[test]
    fn rename_patterns_fill_tokens_and_keep_the_extension() {
        assert_eq!(
            render_name("{host}-{name}-{date}", "annual report", "pdf", "example.com", "2026-11-15"),
            "example.com-annual report-2026-11-15.pdf"
        );
        // An explicit {ext} token means the pattern owns the whole name.
        assert_eq!(
            render_name("{date}-{name}.{ext}", "photo", "jpg", "example.com", "2026-11-15"),
            "2026-11-15-photo.jpg"
        );
    }

    #[test]
    fn rename_patterns_cannot_escape_the_folder() {
        let renamed = render_name("../../etc/passwd", "x", "txt", "example.com", "2026-11-15");
        assert!(!renamed.contains('/'));
        assert!(!renamed.contains('\\'));
        assert!(!renamed.starts_with('.'));
        assert!(renamed.ends_with(".txt"));
    }

    #[test]
    fn organization_and_renaming_compose() {
        let target = destination_for(
            Path::new("C:/Users/me/Downloads/IMG_0001.JPG"),
            "https://www.example.com/gallery/IMG_0001.JPG",
            true,
            "{host}-{date}",
            "2026-11-15",
        );
        assert_eq!(
            target,
            PathBuf::from("C:/Users/me/Downloads/Images/example.com-2026-11-15.jpg")
        );
    }

    #[test]
    fn existing_files_are_not_overwritten() {
        let dir = std::env::temp_dir().join(format!("ritam-downloads-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        std::fs::write(dir.join("notes.txt"), b"first").expect("seed file");

        let target = destination_for(&dir.join("notes.txt"), "https://example.com/notes.txt", false, "", "");
        assert_eq!(target.file_name().unwrap().to_string_lossy(), "notes (2).txt");

        std::fs::remove_dir_all(&dir).ok();
    }
}
