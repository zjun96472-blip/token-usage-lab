use std::fmt;

#[derive(Debug)]
pub enum AppError {
    Database(String),
    Message(String),
    Config(String),
}

impl fmt::Display for AppError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Database(value) | Self::Message(value) | Self::Config(value) => {
                f.write_str(value)
            }
        }
    }
}
impl std::error::Error for AppError {}
impl From<rusqlite::Error> for AppError {
    fn from(error: rusqlite::Error) -> Self {
        Self::Database(error.to_string())
    }
}
impl From<std::io::Error> for AppError {
    fn from(error: std::io::Error) -> Self {
        Self::Message(error.kind().to_string())
    }
}
impl From<serde_json::Error> for AppError {
    fn from(_: serde_json::Error) -> Self {
        Self::Message("Invalid JSON data".into())
    }
}
