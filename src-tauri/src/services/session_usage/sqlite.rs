use super::*;
use crate::services::session_usage_opencode::{self, Message};
use rusqlite::OpenFlags;
use serde_json::Value;
use std::time::Duration;

const MAX_ROWS: usize = 250_000;

fn stamp(path: &Path) -> Result<String, AppError> {
    let mut parts = Vec::new();
    // WAL-only commits do not change the main database's modification time.
    for suffix in ["", "-wal", "-journal"] {
        let file = PathBuf::from(format!("{}{suffix}", path.to_string_lossy()));
        match fs::symlink_metadata(file) {
            Ok(meta) if meta.is_file() && !meta.file_type().is_symlink() => {
                if meta.len() > MAX_FILE_BYTES {
                    return Err(AppError::Config(
                        "Source database exceeds scan limit".into(),
                    ));
                }
                parts.push(format!("{}:{}", meta.len(), modified_stamp(&meta)));
            }
            Err(error) if !suffix.is_empty() && error.kind() == std::io::ErrorKind::NotFound => {
                parts.push("absent".into());
            }
            _ => return Err(AppError::Config("Unsafe source database".into())),
        }
    }
    let shm = PathBuf::from(format!("{}-shm", path.to_string_lossy()));
    if let Ok(meta) = fs::symlink_metadata(shm) {
        if !meta.is_file() || meta.file_type().is_symlink() {
            return Err(AppError::Config("Unsafe source database sidecar".into()));
        }
    }
    Ok(usage_record::hash(
        &parts.iter().map(String::as_str).collect::<Vec<_>>(),
    ))
}

fn table_exists(conn: &Connection, name: &str) -> Result<bool, AppError> {
    Ok(conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
        [name],
        |r| r.get(0),
    )?)
}

pub(super) fn sync(
    conn: &mut Connection,
    source: &'static str,
    path: &Path,
) -> Result<FileResult, AppError> {
    let before = stamp(path)?;
    let key = usage_record::hash(&[source, &path.to_string_lossy()]);
    let cursor = load_cursor(conn, &key)?;
    if cursor.version == ADAPTER_VERSION && cursor.modified_ns == before {
        return Ok(FileResult {
            malformed: cursor.malformed,
            unsupported: cursor.unsupported,
            unmetered: cursor.unmetered,
            ..Default::default()
        });
    }
    let db = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    db.busy_timeout(Duration::from_millis(25))?;
    db.execute_batch("PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; BEGIN DEFERRED;")?;
    let v2 = table_exists(&db, "session_message")?;
    let messages = if v2 { "session_message" } else { "message" };
    let sessions = if v2 && table_exists(&db, "session_v2")? {
        "session_v2"
    } else {
        "session"
    };
    if !table_exists(&db, messages)? || !table_exists(&db, sessions)? {
        return Ok(FileResult {
            unsupported: 1,
            ..Default::default()
        });
    }
    // Only literal, verified table names enter this query; source schemas are never migrated.
    let kind = if v2 { "m.type" } else { "NULL" };
    let mut stmt = db.prepare(&format!(
        "SELECT m.id,m.session_id,m.data,m.time_updated,s.time_created,s.parent_id,{kind}
        FROM {messages} m LEFT JOIN {sessions} s ON s.id=m.session_id LIMIT {}",
        MAX_ROWS + 1
    ))?;
    let mut rows = stmt.query([])?;
    let mut result = FileResult::default();
    let mut parsed = Vec::new();
    let mut row_count = 0;
    while let Some(row) = rows.next()? {
        row_count += 1;
        if row_count > MAX_ROWS {
            return Err(AppError::Config("Source message limit reached".into()));
        }
        let raw = match row.get_ref(2)? {
            rusqlite::types::ValueRef::Text(bytes) => bytes,
            _ => {
                result.unsupported += 1;
                continue;
            }
        };
        if raw.len() > MAX_LINE_BYTES {
            result.unsupported += 1;
            continue;
        }
        let value: Value = match serde_json::from_slice(raw) {
            Ok(value) => value,
            Err(_) => {
                result.malformed += 1;
                continue;
            }
        };
        let kind: Option<String> = row.get(6)?;
        let kind = kind.as_deref().or_else(|| value["role"].as_str());
        let Some(kind) = kind else {
            result.unsupported += 1;
            continue;
        };
        if !matches!(kind, "assistant" | "compaction") {
            continue;
        }
        let session_created: Option<i64> = row.get(4)?;
        let revision: Option<i64> = row.get(3)?;
        let (Some(session_created), Some(revision)) = (session_created, revision) else {
            result.unsupported += 1;
            continue;
        };
        if !(0..=253_402_300_799_000).contains(&session_created)
            || !(0..=253_402_300_799_000).contains(&revision)
        {
            result.unsupported += 1;
            continue;
        }
        let message = Message {
            source,
            session: &row.get::<_, String>(1)?,
            message: &row.get::<_, String>(0)?,
            kind,
            session_created,
            revision,
            child_session: row.get::<_, Option<String>>(5)?.is_some(),
        };
        let complete = if kind == "assistant" {
            usage_record::timestamp(&value["time"]["completed"]).is_some()
        } else {
            matches!(value["status"].as_str(), Some("completed" | "failed"))
        };
        if !complete && !value["tokens"].is_null() {
            result.deferred = true;
            continue;
        }
        parsed.push((session_usage_opencode::parse(&value, &message), revision));
    }
    drop(rows);
    drop(stmt);
    db.execute_batch("ROLLBACK;")?;
    drop(db);
    if stamp(path)? != before {
        return Ok(FileResult {
            deferred: true,
            ..Default::default()
        });
    }
    let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    for (record, revision) in parsed {
        collect_revision(&tx, record, Some(revision), &mut result)?;
    }
    tx.execute("INSERT INTO session_log_sync
        (file_key,source,byte_offset,prefix_hash,adapter_version,malformed,unsupported,unmetered,last_synced_at,modified_ns)
        VALUES (?1,?2,0,'',?3,?4,?5,?6,?7,?8)
        ON CONFLICT(file_key) DO UPDATE SET adapter_version=excluded.adapter_version,
        malformed=excluded.malformed,unsupported=excluded.unsupported,unmetered=excluded.unmetered,
        last_synced_at=excluded.last_synced_at,modified_ns=excluded.modified_ns",
        params![key,source,ADAPTER_VERSION,result.malformed,result.unsupported,result.unmetered,
            chrono::Utc::now().timestamp_millis(), if result.deferred { "" } else { &before }])?;
    tx.commit()?;
    Ok(result)
}
