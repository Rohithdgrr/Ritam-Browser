//! Atomic file writes for generated artifacts and exports.
//!
//! Write a sibling temp file, flush it to disk, then rename it over the target.
//! A crash or power loss therefore leaves either the old file or the complete
//! new file, never a truncated one. The caller chooses a unique target when it
//! must not replace an existing file.

use crate::error::AppError;
use std::fs::{self, File};
use std::io::Write;
use std::path::Path;

pub fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), AppError> {
    let parent = path
        .parent()
        .filter(|dir| !dir.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(parent)?;

    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "artifact".to_string());
    let tmp = parent.join(format!(".{name}.{}.tmp", uuid::Uuid::new_v4()));

    let result = (|| -> Result<(), AppError> {
        let mut file = File::create(&tmp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&tmp, path)?;
        // Persist the rename itself where the platform supports directory fsync.
        #[cfg(unix)]
        {
            if let Ok(dir) = File::open(parent) {
                let _ = dir.sync_all();
            }
        }
        Ok(())
    })();

    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!("ritam-atomic-{tag}-{}", uuid::Uuid::new_v4()))
    }

    #[test]
    fn writes_new_files_and_creates_the_parent() {
        let dir = temp_dir("new");
        let target = dir.join("nested").join("report.txt");
        write_atomic(&target, b"complete").expect("write");
        assert_eq!(fs::read(&target).expect("read"), b"complete");
        assert!(!fs::read_dir(target.parent().unwrap())
            .unwrap()
            .flatten()
            .any(|entry| entry.file_name().to_string_lossy().contains(".tmp")));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn replaces_an_existing_file_in_one_step() {
        let dir = temp_dir("replace");
        fs::create_dir_all(&dir).unwrap();
        let target = dir.join("note.txt");
        fs::write(&target, b"old").unwrap();
        write_atomic(&target, b"new").expect("replace");
        assert_eq!(fs::read(&target).unwrap(), b"new");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn a_failed_rename_leaves_no_temp_file() {
        let dir = temp_dir("fail");
        fs::create_dir_all(&dir).unwrap();
        let target = dir.join("target");
        fs::create_dir_all(&target).unwrap(); // rename(file -> directory) fails
        assert!(write_atomic(&target, b"data").is_err());
        let leftovers: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name.ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "temp files left behind: {leftovers:?}");
        let _ = fs::remove_dir_all(dir);
    }
}
