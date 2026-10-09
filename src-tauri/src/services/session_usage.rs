use super::{
    session_usage_claude, session_usage_codex, session_usage_gemini, session_usage_openclaw,
    session_usage_qwen, session_usage_workbuddy,
    usage_record::{self, Parsed, UsageRecord, ADAPTER_VERSION},
};
use crate::{
    database::{lock_conn, Database},
    error::AppError,
};
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File},
    io::{BufRead, BufReader, Read, Seek, SeekFrom},
    path::{Path, PathBuf},
};

const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const MAX_LINE_BYTES: usize = 4 * 1024 * 1024;
const MAX_FILES: usize = 20_000;

mod sqlite;

#[derive(Clone, Debug)]
pub struct SourceRoots {
    pub workbuddy: PathBuf,
    pub openclaw: PathBuf,
    pub codex: PathBuf,
    pub claude: PathBuf,
    pub gemini: PathBuf,
    pub pi: PathBuf,
    pub opencode: PathBuf,
    pub kilo: PathBuf,
    pub qwen: PathBuf,
}
impl SourceRoots {
    pub fn from_home(home: &Path) -> Self {
        Self {
            workbuddy: home.join(".workbuddy"),
            openclaw: home.join(".openclaw"),
            codex: home.join(".codex"),
            claude: home.join(".claude"),
            gemini: home.join(".gemini"),
            pi: home.join(".pi"),
            opencode: home.join(".local/share/opencode"),
            kilo: home.join(".local/share/kilo"),
            qwen: home.join(".qwen"),
        }
    }
}

#[derive(Default, Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceStatus {
    pub source: String,
    pub state: String,
    pub files_scanned: u64,
    pub observed_requests: u64,
    pub imported: u64,
    pub updated: u64,
    pub skipped: u64,
    pub malformed: u64,
    pub unsupported: u64,
    pub unmetered: u64,
    pub deferred_files: u64,
    pub file_errors: u64,
    pub last_scan_at: i64,
    pub validation: String,
}

#[derive(Default, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSyncResult {
    pub imported: u64,
    pub updated: u64,
    pub skipped: u64,
    pub files_scanned: u64,
    pub suspected_duplicates: u64,
    pub deferred_files: u64,
    pub errors: Vec<String>,
    pub sources: Vec<SourceStatus>,
}

#[derive(Default)]
struct Cursor {
    offset: u64,
    prefix_hash: String,
    version: i64,
    session: Option<String>,
    malformed: u64,
    unsupported: u64,
    unmetered: u64,
    modified_ns: String,
    codex: session_usage_codex::State,
}

#[derive(Default)]
struct FileResult {
    imported: u64,
    updated: u64,
    skipped: u64,
    malformed: u64,
    unsupported: u64,
    unmetered: u64,
    deferred: bool,
}

pub fn sync_all_unlocked(
    db: &Database,
    roots: &SourceRoots,
) -> Result<SessionSyncResult, AppError> {
    let mut result = SessionSyncResult::default();
    let mut conn = lock_conn!(db.conn);
    for (source, root) in [
        ("workbuddy", &roots.workbuddy),
        ("openclaw", &roots.openclaw),
        ("codex", &roots.codex),
        ("claude", &roots.claude),
        ("gemini", &roots.gemini),
        ("pi", &roots.pi),
        ("opencode", &roots.opencode),
        ("kilo", &roots.kilo),
        ("qwen", &roots.qwen),
    ] {
        let mut status = SourceStatus {
            source: source.into(),
            state: "ready".into(),
            last_scan_at: chrono::Utc::now().timestamp_millis(),
            validation: if matches!(
                source,
                "openclaw" | "gemini" | "pi" | "opencode" | "kilo" | "qwen"
            ) {
                "fixtures-only"
            } else {
                "sample-format"
            }
            .into(),
            ..Default::default()
        };
        match discover(source, root) {
            Ok(None) => status.state = "missing".into(),
            Err(_) => {
                status.state = "error".into();
                status.file_errors = 1;
            }
            Ok(Some(files)) => {
                status.files_scanned = files.len() as u64;
                for (path, agent) in files {
                    let scan = if matches!(source, "opencode" | "kilo") {
                        sqlite::sync(&mut conn, source, &path)
                    } else if source == "gemini" && path.extension().is_some_and(|v| v == "json") {
                        sync_gemini_document(&mut conn, &path)
                    } else {
                        sync_file(&mut conn, source, &path, &agent)
                    };
                    match scan {
                        Ok(file) => {
                            status.imported += file.imported;
                            status.updated += file.updated;
                            status.skipped += file.skipped;
                            status.malformed += file.malformed;
                            status.unsupported += file.unsupported;
                            status.unmetered += file.unmetered;
                            status.deferred_files += u64::from(file.deferred);
                        }
                        Err(_) => status.file_errors += 1,
                    }
                }
                status.state = if status.file_errors > 0
                    || status.unsupported > 0
                    || status.malformed > 0
                    || status.deferred_files > 0
                    || status.unmetered > 0
                {
                    "partial"
                } else if status.files_scanned == 0 {
                    "empty"
                } else {
                    "ready"
                }
                .into();
            }
        }
        status.observed_requests = conn.query_row(
            "SELECT COUNT(*) FROM proxy_request_logs WHERE app_type=?1",
            [source],
            |row| row.get(0),
        )?;
        if status.state == "ready" && status.observed_requests == 0 {
            status.state = "empty".into();
        }
        conn.execute(
            "INSERT INTO source_status(source,value) VALUES (?1,?2)
            ON CONFLICT(source) DO UPDATE SET value=excluded.value",
            params![source, serde_json::to_string(&status)?],
        )?;
        result.imported += status.imported;
        result.updated += status.updated;
        result.skipped += status.skipped;
        result.files_scanned += status.files_scanned;
        result.deferred_files += status.deferred_files;
        if status.file_errors > 0 {
            result.errors.push(format!("{source}: source_read_failed"));
        }
        result.sources.push(status);
    }
    Ok(result)
}

pub fn statuses(db: &Database) -> Result<Vec<SourceStatus>, AppError> {
    let conn = lock_conn!(db.conn);
    let mut stmt = conn.prepare("SELECT value FROM source_status ORDER BY source")?;
    let values = stmt
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    values
        .into_iter()
        .map(|value| serde_json::from_str(&value).map_err(Into::into))
        .collect()
}

fn discover(source: &str, root: &Path) -> Result<Option<Vec<(PathBuf, String)>>, AppError> {
    match fs::symlink_metadata(root) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
        Ok(meta) if !meta.is_dir() || meta.file_type().is_symlink() => {
            return Err(AppError::Config("Unsafe source root".into()))
        }
        _ => (),
    }
    let mut files = Vec::new();
    if matches!(source, "workbuddy" | "claude") {
        let projects = root.join("projects");
        if projects.exists() {
            walk(&projects, "", 0, 8, &mut files)?;
        }
    } else if source == "codex" {
        for dir in ["sessions", "archived_sessions"] {
            let dir = root.join(dir);
            if dir.exists() {
                walk(&dir, "", 0, 6, &mut files)?;
            }
        }
    } else if source == "pi" {
        let dir = root.join("agent").join("sessions");
        if dir.exists() {
            walk(&dir, "", 0, 4, &mut files)?;
        }
    } else if matches!(source, "opencode" | "kilo") {
        let path = root.join(format!("{source}.db"));
        if path.exists() {
            let meta = fs::symlink_metadata(&path)?;
            if !meta.is_file() || meta.file_type().is_symlink() {
                return Err(AppError::Config("Unsafe source database".into()));
            }
            files.push((path, String::new()));
        }
    } else if matches!(source, "gemini" | "qwen") {
        let tmp = root.join("tmp");
        if tmp.exists() {
            if fs::symlink_metadata(&tmp)?.file_type().is_symlink() {
                return Err(AppError::Config("Linked source directory".into()));
            }
            for project in fs::read_dir(&tmp)? {
                let project = project?;
                if !project.file_type()?.is_dir() {
                    continue;
                }
                let chats = project.path().join("chats");
                if !chats.exists() {
                    continue;
                }
                if fs::symlink_metadata(&chats)?.file_type().is_symlink() {
                    return Err(AppError::Config("Linked source directory".into()));
                }
                for entry in fs::read_dir(chats)? {
                    let entry = entry?;
                    let path = entry.path();
                    if entry.file_type()?.is_file()
                        && if source == "qwen" {
                            path.extension().and_then(|v| v.to_str()) == Some("jsonl")
                        } else {
                            entry.file_name().to_string_lossy().starts_with("session-")
                                && matches!(
                                    path.extension().and_then(|v| v.to_str()),
                                    Some("json" | "jsonl")
                                )
                        }
                    {
                        files.push((path, String::new()));
                        if files.len() > MAX_FILES {
                            return Err(AppError::Config("Source file limit reached".into()));
                        }
                    }
                }
            }
        }
    } else if source == "openclaw" {
        let agents = root.join("agents");
        if agents.exists() {
            if fs::symlink_metadata(&agents)?.file_type().is_symlink() {
                return Err(AppError::Config(
                    "Linked source directories are unsupported".into(),
                ));
            }
            for entry in fs::read_dir(agents)? {
                let entry = entry?;
                if !entry.file_type()?.is_dir() || entry.file_type()?.is_symlink() {
                    continue;
                }
                let sessions = entry.path().join("sessions");
                if sessions.exists() {
                    walk(
                        &sessions,
                        &entry.file_name().to_string_lossy(),
                        0,
                        0,
                        &mut files,
                    )?;
                }
            }
        }
    }
    files.sort_by(|left, right| left.0.cmp(&right.0));
    Ok(Some(files))
}

fn walk(
    dir: &Path,
    agent: &str,
    depth: usize,
    max_depth: usize,
    files: &mut Vec<(PathBuf, String)>,
) -> Result<(), AppError> {
    if fs::symlink_metadata(dir)?.file_type().is_symlink() {
        return Err(AppError::Config(
            "Linked source directories are unsupported".into(),
        ));
    }
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        if kind.is_symlink() {
            continue;
        }
        if kind.is_dir() {
            if depth < max_depth {
                walk(&entry.path(), agent, depth + 1, max_depth, files)?;
            }
        } else if kind.is_file()
            && entry.path().extension().and_then(|s| s.to_str()) == Some("jsonl")
        {
            files.push((entry.path(), agent.to_owned()));
            if files.len() > MAX_FILES {
                return Err(AppError::Config("Source file limit reached".into()));
            }
        }
    }
    Ok(())
}

fn hash_prefix(file: &mut File, length: u64) -> Result<Sha256, AppError> {
    file.seek(SeekFrom::Start(0))?;
    let mut reader = file.take(length);
    let mut state = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    let mut read = 0;
    loop {
        let n = reader.read(&mut buffer)?;
        if n == 0 {
            break;
        }
        state.update(&buffer[..n]);
        read += n as u64;
    }
    if read != length {
        return Err(AppError::Message("Source changed during scan".into()));
    }
    Ok(state)
}

fn bounded_line(
    reader: &mut impl BufRead,
    buffer: &mut Vec<u8>,
    digest: &mut Sha256,
) -> Result<(u64, bool), AppError> {
    let mut length = 0;
    loop {
        let available = reader.fill_buf()?;
        if available.is_empty() {
            return Ok((length, false));
        }
        let end = available.iter().position(|byte| *byte == b'\n');
        let n = end.map_or(available.len(), |index| index + 1);
        digest.update(&available[..n]);
        let keep = n.min((MAX_LINE_BYTES + 1).saturating_sub(buffer.len()));
        buffer.extend_from_slice(&available[..keep]);
        reader.consume(n);
        length += n as u64;
        if end.is_some() {
            return Ok((length, true));
        }
    }
}

fn load_cursor(conn: &Connection, key: &str) -> Result<Cursor, AppError> {
    let mut cursor = conn.query_row("SELECT byte_offset,prefix_hash,adapter_version,session_key,malformed,unsupported,unmetered,modified_ns
        FROM session_log_sync WHERE file_key=?1", [key], |row| Ok(Cursor {
        offset: row.get(0)?, prefix_hash: row.get(1)?, version: row.get(2)?, session: row.get(3)?,
        malformed: row.get(4)?, unsupported: row.get(5)?, unmetered: row.get(6)?,
        modified_ns: row.get(7)?, ..Default::default()
    })).optional()?.unwrap_or_default();
    let state: Option<String> = conn
        .query_row(
            "SELECT parser_state FROM session_log_sync WHERE file_key=?1",
            [key],
            |r| r.get(0),
        )
        .optional()?;
    if let Some(state) = state {
        cursor.codex = serde_json::from_str(&state)?;
    }
    Ok(cursor)
}

fn sync_file(
    conn: &mut Connection,
    source: &'static str,
    path: &Path,
    agent: &str,
) -> Result<FileResult, AppError> {
    let mut file = File::open(path)?;
    let metadata = file.metadata()?;
    let size = metadata.len();
    let modified_ns = modified_stamp(&metadata);
    if size > MAX_FILE_BYTES {
        return Err(AppError::Message(
            "Source file exceeds bounded scan size".into(),
        ));
    }
    let key = usage_record::hash(&[source, &path.to_string_lossy()]);
    let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    let mut cursor = load_cursor(&tx, &key)?;
    // Unchanged historical rollouts can be gigabytes. Hash only when metadata changes.
    if cursor.version == ADAPTER_VERSION
        && cursor.offset == size
        && !modified_ns.is_empty()
        && cursor.modified_ns == modified_ns
    {
        return Ok(FileResult {
            malformed: cursor.malformed,
            unsupported: cursor.unsupported,
            unmetered: cursor.unmetered,
            ..Default::default()
        });
    }
    let mut digest = if cursor.offset <= size {
        hash_prefix(&mut file, cursor.offset)?
    } else {
        Sha256::new()
    };
    if cursor.version != ADAPTER_VERSION
        || cursor.offset > size
        || format!("{:x}", digest.clone().finalize()) != cursor.prefix_hash
    {
        cursor = Cursor::default();
        digest = Sha256::new();
    }
    file.seek(SeekFrom::Start(cursor.offset))?;
    let mut reader = BufReader::new(file.take(size - cursor.offset));
    let mut result = FileResult {
        malformed: cursor.malformed,
        unsupported: cursor.unsupported,
        unmetered: cursor.unmetered,
        ..Default::default()
    };
    let mut buffer = Vec::new();
    loop {
        buffer.clear();
        let mut next_digest = digest.clone();
        let (n, complete) = bounded_line(&mut reader, &mut buffer, &mut next_digest)?;
        if n == 0 {
            break;
        }
        if !complete {
            result.deferred = true;
            break;
        }
        digest = next_digest;
        cursor.offset += n;
        if n > MAX_LINE_BYTES as u64 {
            result.unsupported += 1;
            if source == "codex" {
                cursor.codex.invalidate_context();
            }
            continue;
        }
        if buffer.iter().all(u8::is_ascii_whitespace) {
            continue;
        }
        let value: serde_json::Value = match serde_json::from_slice(&buffer) {
            Ok(value) => value,
            Err(_) => {
                result.malformed += 1;
                if source == "codex" {
                    cursor.codex.invalidate_context();
                }
                continue;
            }
        };
        if matches!(source, "openclaw" | "pi") && value["type"] == "session" {
            cursor.session =
                usage_record::id(&value["id"]).map(|id| usage_record::hash(&[source, id]));
        }
        let parsed = match source {
            "workbuddy" => vec![session_usage_workbuddy::parse(&value)],
            "claude" => vec![session_usage_claude::parse(&value)],
            "codex" => vec![session_usage_codex::parse(&value, &mut cursor.codex)],
            "gemini" => session_usage_gemini::parse_entries(&value, &mut cursor.session),
            "qwen" => vec![session_usage_qwen::parse(&value)],
            "openclaw" => vec![session_usage_openclaw::parse(
                &value,
                cursor.session.as_deref(),
                agent,
            )],
            "pi" => vec![session_usage_openclaw::parse_source(
                &value,
                cursor.session.as_deref(),
                agent,
                "pi",
            )],
            _ => vec![Parsed::Unsupported],
        };
        for parsed in parsed {
            collect_parsed(&tx, parsed, &mut result)?;
        }
    }
    let mut file = reader.into_inner().into_inner();
    // Reject a concurrent rewrite before committing either the cursor or the records.
    let prefix_hash = format!("{:x}", digest.finalize());
    if prefix_hash != format!("{:x}", hash_prefix(&mut file, cursor.offset)?.finalize()) {
        return Err(AppError::Message("Source changed during scan".into()));
    }
    tx.execute("INSERT INTO session_log_sync
        (file_key,source,byte_offset,prefix_hash,adapter_version,session_key,malformed,unsupported,unmetered,last_synced_at,modified_ns,parser_state)
        VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)
        ON CONFLICT(file_key) DO UPDATE SET byte_offset=excluded.byte_offset,prefix_hash=excluded.prefix_hash,
        adapter_version=excluded.adapter_version,session_key=excluded.session_key,malformed=excluded.malformed,
        unsupported=excluded.unsupported,unmetered=excluded.unmetered,last_synced_at=excluded.last_synced_at,
        modified_ns=excluded.modified_ns,parser_state=excluded.parser_state",
        params![key,source,cursor.offset,prefix_hash,ADAPTER_VERSION,cursor.session,result.malformed,
            result.unsupported,result.unmetered,chrono::Utc::now().timestamp_millis(),
            if file.metadata()?.len() == size && modified_stamp(&file.metadata()?) == modified_ns { &modified_ns } else { "" },
            serde_json::to_string(&cursor.codex)?])?;
    tx.commit()?;
    Ok(result)
}

fn upsert(
    tx: &Transaction<'_>,
    record: &UsageRecord,
    revision: Option<i64>,
) -> Result<u8, AppError> {
    let authoritative = if let Some(revision) = revision {
        let previous: Option<i64> = tx
            .query_row(
                "SELECT revision_ms FROM usage_revisions WHERE request_id=?1",
                [&record.request_id],
                |row| row.get(0),
            )
            .optional()?;
        if previous.is_some_and(|old| old > revision) {
            return Ok(0);
        }
        tx.execute(
            "INSERT INTO usage_revisions(request_id,revision_ms) VALUES (?1,?2)
            ON CONFLICT(request_id) DO UPDATE SET revision_ms=excluded.revision_ms",
            params![record.request_id, revision],
        )?;
        previous.is_none_or(|old| old < revision)
    } else {
        false
    };
    let old: Option<(String,u32,u32,u32,u32,i64)> = tx.query_row(
        "SELECT model,input_tokens,output_tokens,cache_read_tokens,cache_creation_tokens,event_time_ms
         FROM proxy_request_logs WHERE request_id=?1", [&record.request_id], |row|
        Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?,row.get(5)?))).optional()?;
    let is_update = old.is_some();
    if let Some((model, input, output, read, write, time)) = old {
        if !authoritative && time > record.event_time_ms {
            return Ok(0);
        }
        if time == record.event_time_ms
            && (model.as_str(), input, output, read, write)
                == (
                    record.model.as_str(),
                    record.input,
                    record.output,
                    record.cache_read,
                    record.cache_write,
                )
        {
            return Ok(0);
        }
        if !authoritative && time == record.event_time_ms {
            if model != record.model {
                return Ok(3);
            }
            let pairs = [
                (input, record.input),
                (output, record.output),
                (read, record.cache_read),
                (write, record.cache_write),
            ];
            if pairs.iter().all(|(old, new)| old >= new) {
                return Ok(0);
            }
            if !pairs.iter().all(|(old, new)| old <= new) {
                return Ok(3);
            }
        }
    }
    let provider = format!("_{}_session", record.source);
    let provider_name = match record.source {
        "workbuddy" => "WorkBuddy (Local)",
        "openclaw" => "OpenClaw (Local)",
        "codex" => "Codex (Session)",
        "claude" => "Claude (Session)",
        "gemini" => "Gemini (Session)",
        "pi" => "Pi (Session)",
        "opencode" => "OpenCode (Session)",
        "kilo" => "Kilo Code (Session)",
        "qwen" => "Qwen Code (Session)",
        _ => return Err(AppError::Config("Unknown usage source".into())),
    };
    tx.execute(
        "INSERT OR IGNORE INTO providers(id,app_type,name) VALUES (?1,?2,?3)",
        params![provider, record.source, provider_name],
    )?;
    tx.execute("INSERT INTO proxy_request_logs
        (request_id,provider_id,app_type,model,input_tokens,output_tokens,cache_read_tokens,cache_creation_tokens,
         session_id,created_at,event_time_ms,data_source,execution_kind,agent_key,adapter_version)
        VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)
        ON CONFLICT(request_id) DO UPDATE SET model=excluded.model,input_tokens=excluded.input_tokens,
        output_tokens=excluded.output_tokens,cache_read_tokens=excluded.cache_read_tokens,
        cache_creation_tokens=excluded.cache_creation_tokens,event_time_ms=excluded.event_time_ms,created_at=excluded.created_at,
        execution_kind=excluded.execution_kind,adapter_version=excluded.adapter_version",
        params![record.request_id,provider,record.source,record.model,record.input,record.output,
            record.cache_read,record.cache_write,record.session_key,record.event_time_ms/1000,
            record.event_time_ms,format!("{}_session",record.source),record.execution_kind,record.agent_key,ADAPTER_VERSION])?;
    Ok(if is_update { 2 } else { 1 })
}

#[cfg(test)]
mod tests;

#[cfg(test)]
mod extended_tests;

#[cfg(test)]
mod market_tests;

fn modified_stamp(metadata: &fs::Metadata) -> String {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|time| time.as_nanos().to_string())
        .unwrap_or_default()
}

fn collect_parsed(
    tx: &Transaction<'_>,
    parsed: Parsed,
    result: &mut FileResult,
) -> Result<(), AppError> {
    collect_revision(tx, parsed, None, result)
}

fn collect_revision(
    tx: &Transaction<'_>,
    parsed: Parsed,
    revision: Option<i64>,
    result: &mut FileResult,
) -> Result<(), AppError> {
    match parsed {
        Parsed::Ignore => (),
        Parsed::Unmetered => result.unmetered += 1,
        Parsed::Unsupported => result.unsupported += 1,
        Parsed::Record(record) => match upsert(tx, &record, revision)? {
            1 => result.imported += 1,
            2 => result.updated += 1,
            3 => result.unsupported += 1,
            _ => result.skipped += 1,
        },
    }
    Ok(())
}

fn sync_gemini_document(conn: &mut Connection, path: &Path) -> Result<FileResult, AppError> {
    let mut result = FileResult::default();
    let file = File::open(path)?;
    if file.metadata()?.len() > 64 * 1024 * 1024 {
        return Err(AppError::Message(
            "Session document exceeds scan limit".into(),
        ));
    }
    let mut bytes = Vec::new();
    file.take(64 * 1024 * 1024 + 1).read_to_end(&mut bytes)?;
    if bytes.len() > 64 * 1024 * 1024 {
        return Err(AppError::Message(
            "Session document exceeds scan limit".into(),
        ));
    }
    let value = match serde_json::from_slice::<serde_json::Value>(&bytes) {
        Ok(value) => value,
        Err(error) => {
            if error.is_eof() {
                result.deferred = true;
            } else {
                result.malformed = 1;
            }
            return Ok(result);
        }
    };
    let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    for parsed in session_usage_gemini::parse_entries(&value, &mut None) {
        collect_parsed(&tx, parsed, &mut result)?;
    }
    let mut after = Vec::new();
    File::open(path)?
        .take(64 * 1024 * 1024 + 1)
        .read_to_end(&mut after)?;
    if after != bytes {
        return Err(AppError::Message("Source changed during scan".into()));
    }
    tx.commit()?;
    Ok(result)
}
