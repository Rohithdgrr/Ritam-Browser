//! Per-site time ledger and the browsing statistics page.
//!
//! The shell reports a heartbeat every 30 seconds for the site in the active
//! tab; the ledger stores one row per profile/host/day so reports stay cheap.

use crate::commands::profiles::resolve_active_profile;
use crate::db::{now_ms, DbState};
use crate::error::AppError;
use rusqlite::params;
use serde::Serialize;
use tauri::State;

#[derive(Debug, Serialize)]
pub struct SiteTime {
    pub host: String,
    pub seconds: i64,
}

#[derive(Debug, Serialize)]
pub struct DayTime {
    pub day: String,
    pub seconds: i64,
}

#[derive(Debug, Serialize)]
pub struct BrowsingStats {
    pub days: i64,
    pub from_day: String,
    pub total_seconds: i64,
    pub visits: i64,
    pub sites: Vec<SiteTime>,
    /// One entry per day that has recorded time, oldest first.
    pub series: Vec<DayTime>,
}

/// `YYYY-MM-DD`, as computed by the shell in the user's local timezone.
fn valid_day(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 10 || bytes[4] != b'-' || bytes[7] != b'-' {
        return false;
    }
    if !bytes.iter().enumerate().all(|(index, byte)| {
        matches!(index, 4 | 7) || byte.is_ascii_digit()
    }) {
        return false;
    }
    let Ok(month) = value[5..7].parse::<u32>() else { return false };
    let Ok(day) = value[8..10].parse::<u32>() else { return false };
    (1..=12).contains(&month) && (1..=31).contains(&day)
}

/// Normalise a host reported by the shell: lowercase, no scheme, no `www.`,
/// no port. Returns `None` for anything that is not a plausible hostname.
pub fn clean_host(raw: &str) -> Option<String> {
    let trimmed = raw.trim().trim_end_matches('.').to_lowercase();
    if trimmed.is_empty() || trimmed.len() > 253 || trimmed.contains('/') {
        return None;
    }
    let without_www = trimmed.strip_prefix("www.").unwrap_or(&trimmed).to_string();
    let base = without_www.split(':').next().unwrap_or("").to_string();
    if base.is_empty() || base.len() > 253 {
        return None;
    }
    let valid = base
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_');
    if !valid || !(base.contains('.') || base == "localhost") {
        return None;
    }
    Some(base)
}

#[tauri::command]
pub fn record_site_time(
    db: State<'_, DbState>,
    host: String,
    seconds: i64,
    day: Option<String>,
) -> Result<(), AppError> {
    let host = clean_host(&host).ok_or_else(|| AppError::InvalidInput("invalid host".into()))?;
    // A heartbeat is 30 s; clamp so a sleeping machine cannot inflate a day.
    let seconds = seconds.clamp(1, 300);
    let conn = db.conn();
    let profile = resolve_active_profile(&conn)
        .ok_or_else(|| AppError::InvalidInput("no active profile".into()))?;
    let day = day
        .filter(|value| valid_day(value))
        .unwrap_or_else(|| crate::commands::downloads::date_stamp(now_ms()));
    conn.execute(
        "INSERT INTO site_time (profile_id, host, day, seconds) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(profile_id, host, day) DO UPDATE SET seconds = seconds + excluded.seconds",
        params![profile, host, day, seconds],
    )?;
    Ok(())
}

/// Totals for the last `days` days plus the busiest sites.
#[tauri::command]
pub fn site_time_summary(
    db: State<'_, DbState>,
    days: Option<i64>,
    from_day: Option<String>,
    from_ms: Option<i64>,
) -> Result<BrowsingStats, AppError> {
    let days = days.unwrap_or(7).clamp(1, 365);
    // The shell sends its local calendar day. The fallback (UTC) still counts
    // the requested number of days instead of one extra.
    let from_day = from_day
        .filter(|value| valid_day(value))
        .unwrap_or_else(|| {
            crate::commands::downloads::date_stamp(now_ms() - (days - 1) * 86_400_000)
        });
    let conn = db.conn();
    let profile = resolve_active_profile(&conn)
        .ok_or_else(|| AppError::InvalidInput("no active profile".into()))?;

    let total_seconds: i64 = conn.query_row(
        "SELECT COALESCE(SUM(seconds), 0) FROM site_time WHERE profile_id = ?1 AND day >= ?2",
        params![profile, from_day],
        |row| row.get(0),
    )?;
    let mut stmt = conn.prepare(
        "SELECT host, SUM(seconds) FROM site_time
         WHERE profile_id = ?1 AND day >= ?2
         GROUP BY host ORDER BY SUM(seconds) DESC LIMIT 12",
    )?;
    let sites = stmt
        .query_map(params![profile, from_day], |row| {
            Ok(SiteTime { host: row.get(0)?, seconds: row.get(1)? })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    drop(stmt);

    let from_ms = from_ms
        .filter(|value| *value > 0)
        .unwrap_or_else(|| now_ms() - days * 86_400_000);
    let visits: i64 = conn.query_row(
        "SELECT COUNT(*) FROM history WHERE profile_id = ?1 AND visited_at >= ?2",
        params![profile, from_ms],
        |row| row.get(0),
    )?;
    let mut daily = conn.prepare(
        "SELECT day, SUM(seconds) FROM site_time
         WHERE profile_id = ?1 AND day >= ?2
         GROUP BY day ORDER BY day ASC",
    )?;
    let series = daily
        .query_map(params![profile, from_day], |row| {
            Ok(DayTime { day: row.get(0)?, seconds: row.get(1)? })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    drop(daily);

    Ok(BrowsingStats { days, from_day, total_seconds, visits, sites, series })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hosts_are_normalised_and_junk_is_rejected() {
        assert_eq!(clean_host("WWW.Example.com."), Some("example.com".into()));
        assert_eq!(clean_host("example.com:8443"), Some("example.com".into()));
        assert_eq!(clean_host("localhost"), Some("localhost".into()));
        assert_eq!(clean_host("https://example.com"), None);
        assert_eq!(clean_host("not a host"), None);
        assert_eq!(clean_host(""), None);
    }

    #[test]
    fn local_day_strings_are_validated() {
        assert!(valid_day("2026-11-15"));
        assert!(!valid_day("2026-13-15"));
        assert!(!valid_day("2026-11-32"));
        assert!(!valid_day("2026-1-5"));
        assert!(!valid_day("today"));
        assert!(!valid_day("2026/11/15"));
        assert!(!valid_day(""));
    }
}
