//! On-demand file scanning for downloads.
//!
//! On Windows this shells out to Microsoft Defender's `MpCmdRun.exe` (the same
//! engine the OS uses) with remediation disabled: Ritam reports a verdict and
//! never deletes or quarantines a user's file. Other platforms report
//! `unavailable` rather than pretending a scan happened.

use crate::commands::profiles::resolve_active_profile;
use crate::db::DbState;
use crate::error::AppError;
use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::State;

#[derive(Debug, Serialize)]
pub struct ScanResult {
    /// "clean" | "threat" | "error" | "unavailable"
    pub status: String,
    pub detail: String,
}

impl ScanResult {
    fn new(status: &str, detail: impl Into<String>) -> Self {
        Self { status: status.to_string(), detail: detail.into() }
    }
}

/// Defender exit codes: 0 = no threat, 2 = threat found. Anything else is an
/// engine or invocation error, not a clean verdict.
pub fn classify_exit(code: i32) -> &'static str {
    match code {
        0 => "clean",
        2 => "threat",
        _ => "error",
    }
}

#[cfg(windows)]
fn defender_path() -> Option<PathBuf> {
    let program_files = std::env::var_os("ProgramFiles").map(PathBuf::from)?;
    let legacy = program_files.join("Windows Defender").join("MpCmdRun.exe");
    if legacy.is_file() {
        return Some(legacy);
    }
    // Versioned platform installs: pick the highest version folder name.
    let base = std::env::var_os("ProgramData")
        .map(PathBuf::from)?
        .join("Microsoft")
        .join("Windows Defender")
        .join("Platform");
    let mut versions: Vec<PathBuf> = std::fs::read_dir(base)
        .ok()?
        .flatten()
        .map(|entry| entry.path())
        .collect();
    versions.sort();
    versions
        .into_iter()
        .rev()
        .map(|dir| dir.join("MpCmdRun.exe"))
        .find(|candidate| candidate.is_file())
}

#[cfg(windows)]
fn run_scan(path: &Path) -> ScanResult {
    use std::process::Command;
    use std::sync::mpsc;
    use std::time::Duration;

    let Some(exe) = defender_path() else {
        return ScanResult::new(
            "unavailable",
            "Windows Defender's command-line scanner was not found on this machine.",
        );
    };

    // The scan can take a while on large files; run it off-thread with a cap so
    // the app never blocks, and report a timeout as an error verdict.
    let target = path.to_path_buf();
    let (sender, receiver) = mpsc::channel();
    std::thread::spawn(move || {
        let output = Command::new(&exe)
            .args(["-Scan", "-ScanType", "3", "-DisableRemediation", "-File"])
            .arg(&target)
            .output();
        let _ = sender.send(output);
    });

    match receiver.recv_timeout(Duration::from_secs(90)) {
        Ok(Ok(output)) => {
            let code = output.status.code().unwrap_or(-1);
            let detail: String = if output.stderr.is_empty() {
                String::from_utf8_lossy(&output.stdout).trim().chars().take(300).collect()
            } else {
                String::from_utf8_lossy(&output.stderr).trim().chars().take(300).collect()
            };
            ScanResult::new(classify_exit(code), detail)
        }
        Ok(Err(error)) => ScanResult::new("error", format!("could not start the scanner: {error}")),
        Err(_) => ScanResult::new("error", "the scan did not finish in time"),
    }
}

#[cfg(not(windows))]
fn run_scan(_path: &Path) -> ScanResult {
    ScanResult::new(
        "unavailable",
        "File scanning uses Microsoft Defender and is only available in the Windows app.",
    )
}

/// Scan a downloaded file and remember the verdict on its download row.
#[tauri::command]
pub fn scan_download(db: State<'_, DbState>, path: String) -> Result<ScanResult, AppError> {
    let file = PathBuf::from(path.trim());
    if !file.is_file() {
        return Err(AppError::NotFound("downloaded file not found".into()));
    }
    let result = run_scan(&file);
    let conn = db.conn();
    if let Some(profile) = resolve_active_profile(&conn) {
        conn.execute(
            "UPDATE downloads SET scan_status = ?1
             WHERE id = (SELECT id FROM downloads WHERE profile_id = ?2 AND destination = ?3
                         ORDER BY created_at DESC LIMIT 1)",
            rusqlite::params![result.status, profile, file.to_string_lossy()],
        )?;
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defender_exit_codes_are_verdicts() {
        assert_eq!(classify_exit(0), "clean");
        assert_eq!(classify_exit(2), "threat");
        assert_eq!(classify_exit(1), "error");
        assert_eq!(classify_exit(-1), "error");
    }
}
