use crate::error::AppError;
use rusqlite::Connection;
use std::{
    path::{Path, PathBuf},
    sync::Mutex,
};

macro_rules! lock_conn {
    ($mutex:expr) => {
        $mutex
            .lock()
            .map_err(|_| AppError::Database("Database lock unavailable".into()))?
    };
}
pub(crate) use lock_conn;

pub struct Database {
    pub(crate) conn: Mutex<Connection>,
    pub(crate) log_count_cache: Mutex<Option<crate::services::usage_stats::LogCountCache>>,
}

impl Database {
    pub fn open(directory: &Path) -> Result<Self, AppError> {
        // Never open or migrate a source tool's database, even with an explicit override.
        if directory.components().any(|part| {
            matches!(
                part.as_os_str().to_str().map(str::to_lowercase).as_deref(),
                Some(
                    ".cc-switch"
                        | ".workbuddy"
                        | ".openclaw"
                        | ".codex"
                        | ".claude"
                        | ".gemini"
                        | ".pi"
                        | ".qwen"
                        | ".opencode"
                        | "opencode"
                        | ".kilo"
                        | ".kilocode"
                        | "kilo"
                )
            )
        }) {
            return Err(AppError::Config(
                "A tool source directory cannot hold the lab database".into(),
            ));
        }
        std::fs::create_dir_all(directory)?;
        Self::from_connection(Connection::open(directory.join("token-usage-lab.sqlite3"))?)
    }

    pub fn memory() -> Result<Self, AppError> {
        Self::from_connection(Connection::open_in_memory()?)
    }

    fn from_connection(conn: Connection) -> Result<Self, AppError> {
        conn.busy_timeout(std::time::Duration::from_secs(10))?;
        let version: i64 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;
        if version > 3 {
            return Err(AppError::Database(
                "Database schema is newer than this application".into(),
            ));
        }
        if version == 0 {
            conn.execute_batch(include_str!("usage_schema.sql"))?;
        } else {
            conn.execute_batch("PRAGMA foreign_keys = ON;")?;
        }
        if version <= 1 {
            conn.execute_batch(
                "BEGIN IMMEDIATE;
                ALTER TABLE session_log_sync ADD COLUMN modified_ns TEXT NOT NULL DEFAULT '';
                ALTER TABLE session_log_sync ADD COLUMN parser_state TEXT NOT NULL DEFAULT '{}';
                PRAGMA user_version = 2;
                COMMIT;",
            )?;
        }
        if version <= 2 {
            conn.execute_batch(
                "BEGIN IMMEDIATE;
                CREATE TABLE usage_revisions (
                    request_id TEXT PRIMARY KEY REFERENCES proxy_request_logs(request_id) DEFERRABLE INITIALLY DEFERRED,
                    revision_ms INTEGER NOT NULL
                );
                PRAGMA user_version = 3;
                COMMIT;",
            )?;
        }
        Ok(Self {
            conn: Mutex::new(conn),
            log_count_cache: Mutex::new(None),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn opening_existing_ledger_for_concurrent_readers_does_not_write_schema() {
        let directory = tempfile::tempdir().unwrap();
        drop(Database::open(directory.path()).unwrap());
        std::thread::scope(|scope| {
            let readers: Vec<_> = (0..12)
                .map(|_| {
                    scope.spawn(|| {
                        let db = Database::open(directory.path()).unwrap();
                        assert_eq!(
                            db.get_usage_summary(None, None, None, None, None)
                                .unwrap()
                                .total_requests,
                            0
                        );
                        let conn = db.conn.lock().unwrap();
                        let writes: i64 = conn
                            .query_row("SELECT total_changes()", [], |row| row.get(0))
                            .unwrap();
                        assert_eq!(writes, 0);
                    })
                })
                .collect();
            for reader in readers {
                reader.join().unwrap();
            }
        });
    }
}

pub fn default_directory() -> Result<PathBuf, AppError> {
    dirs::data_local_dir()
        .map(|root| root.join("TokenUsageLab"))
        .ok_or_else(|| AppError::Config("Local application-data directory is unavailable".into()))
}
