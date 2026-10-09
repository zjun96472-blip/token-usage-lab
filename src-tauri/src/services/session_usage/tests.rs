use super::*;
use serde_json::{json, Value};
use std::io::Write;
use tempfile::TempDir;

fn wb(message: &str, output: u32) -> Value {
    json!({"type":"function_call","id":message,"sessionId":"session-a",
        "timestamp":"2026-10-01T04:00:00Z", "body":"PRIVATE_BODY_DO_NOT_STORE",
        "providerData":{"messageId":message,"conversationRequestId":"same-turn",
            "model":"synthetic-model","secret":"sk-PRIVATE_DO_NOT_STORE",
            "usage":{"inputTokens":100,"outputTokens":output,"totalTokens":100+output,"requests":1,
                "inputTokensDetails":[{"cached_tokens":60}]},
            "rawUsage":{"prompt_tokens":100,"completion_tokens":output,"total_tokens":100+output,
                "cache_read_input_tokens":0,"cached_tokens":0,"cache_creation_input_tokens":0,"credit":9.5,
                "prompt_cache_hit_tokens":60,"prompt_cache_miss_tokens":40,"prompt_cache_write_tokens":0,
                "prompt_tokens_details":{"cached_tokens":60}}},
        "message":{"usage":{"input_tokens":100,"output_tokens":output,"total_tokens":100+output,
            "cache_read_input_tokens":60}}})
}

fn record(value: &Value) -> UsageRecord {
    match session_usage_workbuddy::parse(value) {
        Parsed::Record(record) => record,
        _ => panic!("expected record"),
    }
}

struct Fixture {
    _temp: TempDir,
    roots: SourceRoots,
    data: PathBuf,
    path: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let roots = SourceRoots::from_home(temp.path());
        let data = temp.path().join("lab");
        let projects = roots.workbuddy.join("projects").join("synthetic");
        fs::create_dir_all(&projects).unwrap();
        Self {
            path: projects.join("session.jsonl"),
            _temp: temp,
            roots,
            data,
        }
    }
    fn write(&self, rows: &[Value]) {
        fs::write(
            &self.path,
            rows.iter()
                .map(|row| format!("{row}\n"))
                .collect::<String>(),
        )
        .unwrap();
    }
    fn append(&self, text: &str) {
        fs::OpenOptions::new()
            .append(true)
            .open(&self.path)
            .unwrap()
            .write_all(text.as_bytes())
            .unwrap();
    }
    fn db(&self) -> Database {
        Database::open(&self.data).unwrap()
    }
    fn scan(&self, db: &Database) -> SessionSyncResult {
        sync_all_unlocked(db, &self.roots).unwrap()
    }
}

fn totals(db: &Database) -> (u64, u64) {
    let summary = db.get_usage_summary(None, None, None, None, None).unwrap();
    (summary.total_requests, summary.real_total_tokens)
}

#[test]
fn workbuddy_mirrors_count_once_and_input_includes_cache() {
    let result = record(&wb("m1", 20));
    assert_eq!(
        (
            result.input,
            result.output,
            result.cache_read,
            result.cache_write,
            result.total()
        ),
        (40, 20, 60, 0, 120)
    );
    assert_eq!(result.execution_kind, "unknown");
    assert_eq!(result.request_id.len(), 64);
}

#[test]
fn workbuddy_multiple_calls_in_one_agent_turn_are_distinct() {
    assert_ne!(
        record(&wb("m1", 20)).request_id,
        record(&wb("m2", 20)).request_id
    );
    let mut next = wb("m1", 20);
    next["sessionId"] = json!("different-session");
    assert_ne!(record(&wb("m1", 20)).request_id, record(&next).request_id);
}

#[test]
fn workbuddy_conflicts_missing_fields_and_unknown_formats_fail_closed() {
    for pointer in [
        "/providerData/usage/inputTokens",
        "/providerData/usage/requests",
        "/providerData/rawUsage/cache_creation_input_tokens",
        "/providerData/messageId",
        "/sessionId",
    ] {
        let mut value = wb("m", 20);
        *value.pointer_mut(pointer).unwrap() = Value::Null;
        assert!(
            matches!(session_usage_workbuddy::parse(&value), Parsed::Unsupported),
            "{pointer}"
        );
    }
    for (pointer, value) in [
        ("/message/usage/total_tokens", json!(999)),
        ("/providerData/usage/requests", json!(2)),
        ("/providerData/usage/inputTokens", json!(-1)),
        ("/providerData/rawUsage/cache_read_input_tokens", json!(101)),
        (
            "/providerData/rawUsage/cache_creation_input_tokens",
            json!(5),
        ),
        ("/providerData/rawUsage/prompt_cache_hit_tokens", json!(10)),
        (
            "/providerData/model",
            json!("https://secret.invalid/api?key=private"),
        ),
    ] {
        let mut row = wb("m", 20);
        *row.pointer_mut(pointer).unwrap() = value;
        assert!(matches!(
            session_usage_workbuddy::parse(&row),
            Parsed::Unsupported
        ));
    }
    assert!(matches!(
        session_usage_workbuddy::parse(&json!({"type":"function_call"})),
        Parsed::Unmetered
    ));
    assert!(matches!(
        session_usage_workbuddy::parse(&json!({"type":"user"})),
        Parsed::Ignore
    ));
}

#[test]
fn background_does_not_imply_human_initiator() {
    let mut row = wb("background", 20);
    row["isBackground"] = json!(true);
    assert_eq!(record(&row).execution_kind, "background");
    let f = Fixture::new();
    f.write(&[row]);
    let db = f.db();
    f.scan(&db);
    let conn = db.conn.lock().unwrap();
    let actor: String = conn
        .query_row("SELECT actor_kind FROM proxy_request_logs", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(actor, "unattributed");
}

#[test]
fn repeated_scan_restart_copy_append_and_message_update_are_idempotent() {
    let f = Fixture::new();
    f.write(&[wb("m1", 20), wb("m2", 30)]);
    let db = f.db();
    assert_eq!(f.scan(&db).imported, 2);
    assert_eq!(totals(&db), (2, 250));
    assert_eq!(f.scan(&db).imported, 0);
    drop(db);
    let db = f.db();
    assert_eq!(f.scan(&db).imported, 0);
    fs::copy(&f.path, f.path.with_file_name("copy.jsonl")).unwrap();
    assert_eq!(f.scan(&db).imported, 0);
    assert_eq!(totals(&db), (2, 250));
    f.append(&format!("{}\n", wb("m3", 40)));
    assert_eq!(f.scan(&db).imported, 1);
    assert_eq!(totals(&db), (3, 390));
    f.append(&format!("{}\n", wb("m1", 50)));
    assert_eq!(f.scan(&db).updated, 1);
    assert_eq!(totals(&db), (3, 420));
    f.scan(&db);
    assert_eq!(totals(&db), (3, 420));
}

#[test]
fn partial_tail_waits_for_newline_and_survives_restart() {
    let f = Fixture::new();
    f.write(&[wb("m1", 20)]);
    let row = wb("m2", 30).to_string();
    f.append(&row[..row.len() / 2]);
    let db = f.db();
    assert_eq!(f.scan(&db).deferred_files, 1);
    assert_eq!(totals(&db), (1, 120));
    drop(db);
    let db = f.db();
    f.append(&row[row.len() / 2..]);
    assert_eq!(f.scan(&db).deferred_files, 1);
    assert_eq!(totals(&db), (1, 120));
    f.append("\n");
    assert_eq!(f.scan(&db).imported, 1);
    assert_eq!(totals(&db), (2, 250));
}

#[test]
fn rewrite_truncate_and_stale_copy_never_accumulate() {
    let f = Fixture::new();
    f.write(&[wb("m1", 20), wb("m2", 30)]);
    let db = f.db();
    f.scan(&db);
    let mut corrected = wb("m1", 50);
    corrected["timestamp"] = json!("2026-10-02T04:00:00Z");
    f.write(&[corrected.clone(), wb("m2", 30)]);
    assert_eq!(f.scan(&db).updated, 1);
    assert_eq!(totals(&db), (2, 280));
    f.write(&[corrected]);
    f.scan(&db);
    assert_eq!(totals(&db), (2, 280));
    f.append(&format!("{}\n", wb("m1", 99)));
    f.scan(&db);
    assert_eq!(totals(&db), (2, 280));
    let day2 = chrono::DateTime::parse_from_rfc3339("2026-10-02T00:00:00Z")
        .unwrap()
        .timestamp();
    assert_eq!(
        db.get_usage_summary(Some(day2), None, None, None, None)
            .unwrap()
            .total_requests,
        1
    );
}

#[test]
fn malformed_unsupported_and_unmetered_counts_survive_incremental_scan() {
    let f = Fixture::new();
    f.write(&[wb("m1", 20), json!({"type":"function_call"})]);
    f.append("{invalid}\n");
    let mut unknown = wb("m2", 20);
    unknown["providerData"]["usage"]["requests"] = json!(2);
    f.append(&format!("{unknown}\n"));
    let db = f.db();
    for _ in 0..2 {
        let scan = f.scan(&db);
        let s = &scan.sources[0];
        assert_eq!(
            (&s.state, s.malformed, s.unsupported, s.unmetered),
            (&"partial".to_string(), 1, 1, 1)
        );
        assert_eq!(totals(&db), (1, 120));
    }
}

#[test]
fn missing_and_empty_sources_are_not_reported_as_complete() {
    let f = Fixture::new();
    let scan = f.scan(&f.db());
    assert_eq!(scan.sources[0].state, "empty");
    assert_eq!(scan.sources[1].state, "missing");
    assert_eq!(scan.sources[1].validation, "fixtures-only");
}

#[test]
fn bounded_reader_does_not_retain_oversized_lines() {
    let bytes = vec![b'x'; MAX_LINE_BYTES * 2];
    let mut reader = BufReader::new(bytes.as_slice());
    let mut buffer = Vec::new();
    let (length, complete) = bounded_line(&mut reader, &mut buffer, &mut Sha256::new()).unwrap();
    assert_eq!(length, bytes.len() as u64);
    assert!(!complete);
    assert!(buffer.len() <= MAX_LINE_BYTES + 1);
}

#[test]
fn failed_file_does_not_block_other_files_or_mutate_sources() {
    let f = Fixture::new();
    f.write(&[wb("m1", 20)]);
    let before = fs::read(&f.path).unwrap();
    let large = File::create(f.path.with_file_name("too-large.jsonl")).unwrap();
    large.set_len(MAX_FILE_BYTES + 1).unwrap();
    let db = f.db();
    let scan = f.scan(&db);
    assert_eq!(scan.sources[0].file_errors, 1);
    assert_eq!(scan.sources[0].state, "partial");
    assert_eq!(totals(&db), (1, 120));
    assert_eq!(fs::read(&f.path).unwrap(), before);
}

#[test]
fn openclaw_synthetic_caches_tool_results_and_background_compaction() {
    let f = Fixture::new();
    let sessions = f
        .roots
        .openclaw
        .join("agents")
        .join("worker")
        .join("sessions");
    fs::create_dir_all(&sessions).unwrap();
    let header = json!({"type":"session","id":"session-pi"});
    let first = json!({"type":"message","id":"pi1","timestamp":"2026-10-01T04:00:00Z",
        "message":{"role":"assistant","model":"pi-model","usage":{
            "input":10,"output":20,"cacheRead":30,"cacheWrite":40,"totalTokens":100}}});
    let tool =
        json!({"type":"message","id":"tool","message":{"role":"toolResult","usage":{"input":99}}});
    let compact = json!({"type":"compaction","id":"compact","timestamp":"2026-10-01T05:00:00Z",
        "model":"pi-model","isBackground":true,"usage":{"input":1,"output":2,"cacheRead":3,"cacheWrite":4}});
    fs::write(
        sessions.join("one.jsonl"),
        format!("{header}\n{first}\n{tool}\n{compact}\n"),
    )
    .unwrap();
    let db = f.db();
    assert_eq!(f.scan(&db).imported, 2);
    assert_eq!(totals(&db), (2, 110));
    fs::copy(sessions.join("one.jsonl"), sessions.join("copy.jsonl")).unwrap();
    f.scan(&db);
    assert_eq!(totals(&db), (2, 110));
    let mut bad = first.clone();
    bad["message"]["usage"]["totalTokens"] = json!(60);
    assert!(matches!(
        session_usage_openclaw::parse(&bad, Some("hashed-session"), "a"),
        Parsed::Unsupported
    ));
    bad = first;
    bad["message"]["usage"]["cacheRead"] = Value::Null;
    assert!(matches!(
        session_usage_openclaw::parse(&bad, Some("hashed-session"), "a"),
        Parsed::Unsupported
    ));
}

#[test]
fn summaries_models_sources_trends_and_details_reconcile() {
    let f = Fixture::new();
    let mut second = wb("m2", 30);
    second["providerData"]["model"] = json!("second-model");
    second["timestamp"] = json!("2026-10-02T04:00:00Z");
    f.write(&[wb("m1", 20), second]);
    let db = f.db();
    f.scan(&db);
    let start = chrono::DateTime::parse_from_rfc3339("2026-09-30T00:00:00Z")
        .unwrap()
        .timestamp();
    let end = start + 4 * 86400;
    let summary = db
        .get_usage_summary(Some(start), Some(end), None, None, None)
        .unwrap();
    assert_eq!(summary.real_total_tokens, 250);
    let sources = db
        .get_usage_summary_by_app(Some(start), Some(end), None, None)
        .unwrap();
    assert_eq!(sources[0].summary.real_total_tokens, 250);
    let models = db
        .get_model_stats(Some(start), Some(end), None, None, None)
        .unwrap();
    assert_eq!(models.iter().map(|m| m.total_tokens).sum::<u64>(), 250);
    let trends = db
        .get_daily_trends(Some(start), Some(end), None, None, None)
        .unwrap();
    assert_eq!(trends.iter().map(|t| t.total_tokens).sum::<u64>(), 250);
    assert_eq!(
        trends
            .iter()
            .map(|t| t.total_input_tokens
                + t.total_output_tokens
                + t.total_cache_read_tokens
                + t.total_cache_creation_tokens)
            .sum::<u64>(),
        250
    );
    assert_eq!(
        db.get_provider_stats(Some(start), Some(end), None, None, None)
            .unwrap()[0]
            .total_tokens,
        250
    );
    let filtered = db
        .get_usage_summary(
            Some(start),
            Some(end),
            Some("workbuddy"),
            None,
            Some("second-model"),
        )
        .unwrap();
    assert_eq!(
        (filtered.total_requests, filtered.real_total_tokens),
        (1, 130)
    );
    let logs = db.get_request_logs(&Default::default(), 0, 20).unwrap();
    assert_eq!(logs.total, 2);
    let detail = db
        .get_request_detail(&logs.data[0].request_id)
        .unwrap()
        .unwrap();
    let safe = serde_json::to_string(&detail).unwrap();
    assert!(!safe.contains("PRIVATE"));
    assert!(!safe.contains("same-turn"));
    assert!(!safe.contains("session-a"));
}

#[test]
fn hourly_inclusive_end_boundary_keeps_every_call() {
    let f = Fixture::new();
    let first = wb("m1", 20);
    let mut last = wb("m2", 30);
    last["timestamp"] = json!("2026-10-01T05:00:00Z");
    f.write(&[first, last]);
    let db = f.db();
    f.scan(&db);
    let start = chrono::DateTime::parse_from_rfc3339("2026-10-01T04:00:00Z")
        .unwrap()
        .timestamp();
    let trends = db
        .get_daily_trends(Some(start), Some(start + 3600), None, None, None)
        .unwrap();
    assert_eq!(trends.iter().map(|t| t.request_count).sum::<u64>(), 2);
    assert_eq!(trends.iter().map(|t| t.total_tokens).sum::<u64>(), 250);
}
