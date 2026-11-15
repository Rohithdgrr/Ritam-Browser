use thiserror::Error;

#[derive(Debug, Error)]
pub enum AppError {
    #[error("database error: {0}")]
    Db(#[from] rusqlite::Error),
    #[error("{0}")]
    InvalidInput(String),
    #[error("{0}")]
    NotFound(String),
    #[error("{0}")]
    Generation(String),
    #[error("window error: {0}")]
    Window(String),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}

/// IPC requires Serialize for error returns; flatten to the message string.
impl serde::Serialize for AppError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}
