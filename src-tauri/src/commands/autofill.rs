//! Per-profile auto-fill entries (identities and addresses).
//!
//! Stored as `{app data}/profiles/{id}/autofill.json`, 0600 on Unix. The file is
//! **not** encrypted and the UI says so. Passwords are not stored at all.
//!
//! Saved values never ride along with a page: they are pushed into one tab only
//! when the user asks for them, tagged with the origin Rust reads from that
//! webview, and the in-page script refuses a payload whose origin differs from
//! the document it is running in.

use crate::commands::profiles::{profile_dir, resolve_active_profile};
use crate::db::DbState;
use crate::error::AppError;
use crate::webview::TabWebviewManager;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, State};

const MAX_ENTRIES: usize = 50;
const MAX_FILE_BYTES: u64 = 200_000;

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Identity {
    pub id: String,
    pub label: String,
    pub full_name: String,
    pub email: String,
    pub phone: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Address {
    pub id: String,
    pub label: String,
    pub line1: String,
    pub line2: String,
    pub city: String,
    pub region: String,
    pub postal_code: String,
    pub country: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct AutofillData {
    pub identities: Vec<Identity>,
    pub addresses: Vec<Address>,
}

fn clean(value: &str, max: usize) -> String {
    value.trim().chars().take(max).collect()
}

fn valid_email(email: &str) -> bool {
    email.is_empty()
        || (email.split_whitespace().count() == 1
            && email.matches('@').count() == 1
            && !email.starts_with('@')
            && !email.ends_with('@'))
}

fn validate_identity(input: Identity) -> Result<Identity, AppError> {
    let identity = Identity {
        id: clean(&input.id, 64),
        label: clean(&input.label, 80),
        full_name: clean(&input.full_name, 120),
        email: clean(&input.email, 254),
        phone: clean(&input.phone, 40),
    };
    if identity.full_name.is_empty() && identity.email.is_empty() && identity.phone.is_empty() {
        return Err(AppError::InvalidInput(
            "an identity needs a name, email or phone".into(),
        ));
    }
    if !valid_email(&identity.email) {
        return Err(AppError::InvalidInput("identity email is not a valid address".into()));
    }
    Ok(identity)
}

fn validate_address(input: Address) -> Result<Address, AppError> {
    let address = Address {
        id: clean(&input.id, 64),
        label: clean(&input.label, 80),
        line1: clean(&input.line1, 200),
        line2: clean(&input.line2, 200),
        city: clean(&input.city, 120),
        region: clean(&input.region, 120),
        postal_code: clean(&input.postal_code, 32),
        country: clean(&input.country, 80),
    };
    if address.line1.is_empty() && address.city.is_empty() {
        return Err(AppError::InvalidInput(
            "an address needs a street line or a city".into(),
        ));
    }
    Ok(address)
}

/// Missing file means "nothing saved yet" — not an error.
pub fn read_data(path: &Path) -> Result<AutofillData, AppError> {
    if !path.exists() {
        return Ok(AutofillData::default());
    }
    let size = std::fs::metadata(path)?.len();
    if size > MAX_FILE_BYTES {
        return Err(AppError::InvalidInput("autofill file is too large".into()));
    }
    let raw = std::fs::read_to_string(path)?;
    serde_json::from_str(&raw)
        .map_err(|_| AppError::InvalidInput("autofill file is not valid JSON".into()))
}

/// Write through a temp file so a crash cannot leave a half-written store.
pub fn write_data(path: &Path, data: &AutofillData) -> Result<(), AppError> {
    let json = serde_json::to_string_pretty(data)
        .map_err(|e| AppError::InvalidInput(format!("could not serialize autofill: {e}")))?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600));
    }
    if path.exists() {
        let _ = std::fs::remove_file(path);
    }
    std::fs::rename(&tmp, path)?;
    Ok(())
}

fn upsert_identity_in(data: &mut AutofillData, input: Identity) -> Result<Identity, AppError> {
    let mut identity = validate_identity(input)?;
    if identity.id.is_empty() {
        if data.identities.len() >= MAX_ENTRIES {
            return Err(AppError::InvalidInput("too many saved identities".into()));
        }
        identity.id = uuid::Uuid::new_v4().to_string();
    }
    match data.identities.iter_mut().find(|entry| entry.id == identity.id) {
        Some(existing) => *existing = identity.clone(),
        None => data.identities.push(identity.clone()),
    }
    Ok(identity)
}

fn upsert_address_in(data: &mut AutofillData, input: Address) -> Result<Address, AppError> {
    let mut address = validate_address(input)?;
    if address.id.is_empty() {
        if data.addresses.len() >= MAX_ENTRIES {
            return Err(AppError::InvalidInput("too many saved addresses".into()));
        }
        address.id = uuid::Uuid::new_v4().to_string();
    }
    match data.addresses.iter_mut().find(|entry| entry.id == address.id) {
        Some(existing) => *existing = address.clone(),
        None => data.addresses.push(address.clone()),
    }
    Ok(address)
}

fn delete_identity_in(data: &mut AutofillData, id: &str) -> bool {
    let before = data.identities.len();
    data.identities.retain(|entry| entry.id != id);
    data.identities.len() != before
}

fn delete_address_in(data: &mut AutofillData, id: &str) -> bool {
    let before = data.addresses.len();
    data.addresses.retain(|entry| entry.id != id);
    data.addresses.len() != before
}

fn data_path(app: &AppHandle, db: &DbState) -> Result<(String, PathBuf), AppError> {
    let profile = {
        let conn = db.conn();
        resolve_active_profile(&conn)
    }
    .ok_or_else(|| AppError::InvalidInput("no active profile".into()))?;
    let path = profile_dir(app, &profile)?.join("autofill.json");
    Ok((profile, path))
}

#[tauri::command]
pub fn list_autofill(app: AppHandle, db: State<'_, DbState>) -> Result<AutofillData, AppError> {
    let (_, path) = data_path(&app, &db)?;
    read_data(&path)
}

#[tauri::command]
pub fn upsert_identity(
    app: AppHandle,
    db: State<'_, DbState>,
    identity: Identity,
) -> Result<Identity, AppError> {
    let (_, path) = data_path(&app, &db)?;
    let mut data = read_data(&path)?;
    let saved = upsert_identity_in(&mut data, identity)?;
    write_data(&path, &data)?;
    Ok(saved)
}

#[tauri::command]
pub fn upsert_address(
    app: AppHandle,
    db: State<'_, DbState>,
    address: Address,
) -> Result<Address, AppError> {
    let (_, path) = data_path(&app, &db)?;
    let mut data = read_data(&path)?;
    let saved = upsert_address_in(&mut data, address)?;
    write_data(&path, &data)?;
    Ok(saved)
}

#[tauri::command]
pub fn delete_identity(
    app: AppHandle,
    db: State<'_, DbState>,
    id: String,
) -> Result<bool, AppError> {
    let (_, path) = data_path(&app, &db)?;
    let mut data = read_data(&path)?;
    let removed = delete_identity_in(&mut data, &id);
    if removed {
        write_data(&path, &data)?;
    }
    Ok(removed)
}

#[tauri::command]
pub fn delete_address(
    app: AppHandle,
    db: State<'_, DbState>,
    id: String,
) -> Result<bool, AppError> {
    let (_, path) = data_path(&app, &db)?;
    let mut data = read_data(&path)?;
    let removed = delete_address_in(&mut data, &id);
    if removed {
        write_data(&path, &data)?;
    }
    Ok(removed)
}

/// Called by the shell (Ctrl+Shift+L) for the tab that has focus. Rust reads the
/// tab's own URL, so the origin in the payload is the one the page is really on.
#[tauri::command]
pub fn request_autofill(
    app: AppHandle,
    db: State<'_, DbState>,
    manager: State<'_, TabWebviewManager>,
    tab_id: String,
) -> Result<serde_json::Value, AppError> {
    let (_, path) = data_path(&app, &db)?;
    let data = read_data(&path)?;
    if data.identities.is_empty() && data.addresses.is_empty() {
        return Ok(serde_json::json!({
            "filled": false,
            "reason": "no saved auto-fill data for this profile"
        }));
    }
    let payload = serde_json::to_value(&data)
        .map_err(|e| AppError::InvalidInput(format!("could not serialize autofill: {e}")))?;
    let origin = manager.push_autofill(&tab_id, &payload)?;
    Ok(serde_json::json!({
        "filled": true,
        "origin": origin,
        "identities": data.identities.len(),
        "addresses": data.addresses.len(),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_path(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ritam-autofill-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir.join(name)
    }

    fn identity(full_name: &str, email: &str) -> Identity {
        Identity {
            id: String::new(),
            label: "Home".into(),
            full_name: full_name.into(),
            email: email.into(),
            phone: String::new(),
        }
    }

    #[test]
    fn missing_file_reads_as_empty_and_round_trips() {
        let path = temp_path("autofill.json");
        let empty = read_data(&path).unwrap();
        assert!(empty.identities.is_empty() && empty.addresses.is_empty());

        let mut data = AutofillData::default();
        upsert_identity_in(&mut data, identity("Ada Lovelace", "ada@example.com")).unwrap();
        write_data(&path, &data).unwrap();
        let loaded = read_data(&path).unwrap();
        assert_eq!(loaded.identities.len(), 1);
        assert_eq!(loaded.identities[0].full_name, "Ada Lovelace");
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn upsert_assigns_an_id_then_updates_in_place() {
        let mut data = AutofillData::default();
        let saved = upsert_identity_in(&mut data, identity("Ada", "ada@example.com")).unwrap();
        assert!(!saved.id.is_empty());
        let mut edited = saved.clone();
        edited.phone = "+1 555 0100".into();
        let updated = upsert_identity_in(&mut data, edited).unwrap();
        assert_eq!(updated.id, saved.id);
        assert_eq!(data.identities.len(), 1);
        assert_eq!(data.identities[0].phone, "+1 555 0100");
    }

    #[test]
    fn identity_validation_rejects_empty_and_bad_email() {
        assert!(validate_identity(identity("", "")).is_err());
        assert!(validate_identity(identity("Ada", "not-an-email")).is_err());
        assert!(validate_identity(identity("Ada", "a@b@c")).is_err());
        assert!(validate_identity(identity("Ada", "")).is_ok());
    }

    #[test]
    fn deleting_one_address_leaves_identities_and_other_addresses() {
        let mut data = AutofillData::default();
        let first = upsert_address_in(
            &mut data,
            Address {
                id: String::new(),
                label: "Home".into(),
                line1: "1 Main St".into(),
                ..Default::default()
            },
        )
        .unwrap();
        upsert_address_in(
            &mut data,
            Address {
                id: String::new(),
                label: "Work".into(),
                line1: "2 Office Rd".into(),
                ..Default::default()
            },
        )
        .unwrap();
        upsert_identity_in(&mut data, identity("Ada", "ada@example.com")).unwrap();

        assert!(delete_address_in(&mut data, &first.id));
        assert!(!delete_address_in(&mut data, &first.id));
        assert_eq!(data.addresses.len(), 1);
        assert_eq!(data.identities.len(), 1);
    }

    #[test]
    fn address_needs_a_street_or_city() {
        assert!(validate_address(Address::default()).is_err());
        assert!(validate_address(Address {
            postal_code: "560001".into(),
            ..Default::default()
        })
        .is_err());
        assert!(validate_address(Address {
            city: "Bengaluru".into(),
            ..Default::default()
        })
        .is_ok());
    }
}
