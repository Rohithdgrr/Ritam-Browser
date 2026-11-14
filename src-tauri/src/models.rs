use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct Workspace {
    pub id: String,
    pub name: String,
    pub color: String,
    pub sort_order: i64,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct Tab {
    pub id: String,
    pub workspace_id: String,
    pub url: String,
    pub title: String,
    pub favicon_url: Option<String>,
    pub is_pinned: i64,
    pub group_name: Option<String>,
    pub sort_order: i64,
    pub created_at: i64,
    pub last_active_at: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct Bookmark {
    pub id: String,
    pub title: String,
    pub url: String,
    pub is_favorite: i64,
    pub sort_order: i64,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct HistoryEntry {
    pub id: String,
    pub url: String,
    pub title: String,
    pub visited_at: i64,
    pub visit_count: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct Note {
    pub id: String,
    pub workspace_id: Option<String>,
    pub content: String,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct Download {
    pub id: String,
    pub url: String,
    pub filename: String,
    pub destination: Option<String>,
    pub mime_type: Option<String>,
    pub total_bytes: Option<i64>,
    pub received_bytes: i64,
    pub status: String,
    pub created_at: i64,
    pub completed_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ReadingItem {
    pub id: String,
    pub url: String,
    pub title: String,
    pub snapshot_text: Option<String>,
    pub note: Option<String>,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct SitePermission {
    pub id: String,
    pub origin: String,
    pub permission: String,
    pub decision: String,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct CloseTabResult {
    pub closed_id: String,
    pub active_tab_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct DeleteWorkspaceResult {
    pub deleted_id: String,
    pub active_workspace_id: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ClearDataResult {
    pub history: i64,
    pub downloads: i64,
    pub site_permissions: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct AppInfo {
    pub name: String,
    pub version: String,
    pub milestone: String,
    pub engine: String,
    pub storage: String,
    pub telemetry: String,
}
