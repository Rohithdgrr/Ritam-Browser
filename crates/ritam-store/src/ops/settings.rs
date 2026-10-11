//! Typed settings. Only the keys in `SettingKey` exist; unknown keys are
//! rejected on write, and a garbled stored value degrades to the default
//! while being counted as malformed.

use rusqlite::{params, OptionalExtension};

use crate::error::StoreError;
use crate::model::{SettingKey, SettingValue};
use crate::Actor;

pub(crate) fn get(actor: &mut Actor, key: SettingKey) -> Result<SettingValue, StoreError> {
    let raw: Option<String> = actor
        .conn
        .query_row(
            "SELECT value FROM settings WHERE key = ?1",
            [key.as_str()],
            |r| r.get(0),
        )
        .optional()?;
    match raw {
        None => Ok(SettingValue::default_of(key)),
        Some(raw) => match SettingValue::decode(key, &raw) {
            Ok(value) => Ok(value),
            Err(_) => {
                actor.malformed_rows_skipped += 1;
                Ok(SettingValue::default_of(key))
            }
        },
    }
}

pub(crate) fn set(actor: &mut Actor, value: SettingValue) -> Result<(), StoreError> {
    value.validate()?;
    let now = crate::model::now_ms();
    actor.conn.execute(
        "INSERT INTO settings (key, value, updated_at_ms) VALUES (?1, ?2, ?3)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at_ms = excluded.updated_at_ms",
        params![value.key().as_str(), value.encode(), now],
    )?;
    Ok(())
}

pub(crate) fn list(actor: &mut Actor) -> Result<Vec<SettingValue>, StoreError> {
    let mut out = Vec::new();
    for key in SettingKey::ALL {
        out.push(get(actor, key)?);
    }
    Ok(out)
}

/// Back to defaults: forget every stored row. Returns rows removed.
pub(crate) fn reset(actor: &mut Actor) -> Result<u64, StoreError> {
    let changed = actor.conn.execute("DELETE FROM settings", [])?;
    Ok(changed as u64)
}

pub(crate) fn scan_malformed(actor: &mut Actor) -> Result<u64, StoreError> {
    let rows: Vec<(String, String)> = {
        let mut stmt = actor.conn.prepare("SELECT key, value FROM settings")?;
        let mapped =
            stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
        mapped.collect::<Result<Vec<_>, _>>()?
    };
    let mut bad = 0;
    for (key, value) in rows {
        match SettingKey::parse(&key) {
            Some(key) => {
                if SettingValue::decode(key, &value).is_err() {
                    bad += 1;
                }
            }
            None => bad += 1,
        }
    }
    Ok(bad)
}
