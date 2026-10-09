use super::*;
use serde_json::{json, Value};
use std::io::Write;

const START: i64 = 1_790_812_800_000;

fn totals(db: &Database, source: &str) -> (u64, u64) {
    let v = db
        .get_usage_summary(None, None, Some(source), None, None)
        .unwrap();
    (v.total_requests, v.real_total_tokens)
}

fn status(result: &SessionSyncResult, source: &str) -> SourceStatus {
    result
        .sources
        .iter()
        .find(|s| s.source == source)
        .unwrap()
        .clone()
}

fn qwen(id: &str) -> Value {
    json!({"type":"assistant","uuid":id,"sessionId":"q-session","timestamp":"2026-10-01T01:00:00Z",
        "model":"qwen-test","usageMetadata":{"promptTokenCount":100,"candidatesTokenCount":20,
            "cachedContentTokenCount":60,"thoughtsTokenCount":5,"totalTokenCount":120},
        "message":"PRIVATE_DO_NOT_STORE","apiKey":"sk-PRIVATE_DO_NOT_STORE"})
}

fn put(path: &Path, values: &[Value]) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(
        path,
        values.iter().map(|v| format!("{v}\n")).collect::<String>(),
    )
    .unwrap();
}

#[test]
fn qwen_total_proves_reasoning_containment_and_cache_is_not_counted_twice() {
    let mut row = qwen("m1");
    assert!(
        matches!(session_usage_qwen::parse(&row), Parsed::Record(r) if
        (r.input,r.output,r.cache_read,r.total()) == (40,20,60,120))
    );
    row["usageMetadata"]["totalTokenCount"] = json!(125);
    assert!(
        matches!(session_usage_qwen::parse(&row), Parsed::Record(r) if r.output==25 && r.total()==125)
    );
    row["usageMetadata"]["totalTokenCount"] = json!(126);
    assert!(matches!(
        session_usage_qwen::parse(&row),
        Parsed::Unsupported
    ));
    for field in [
        "promptTokenCount",
        "candidatesTokenCount",
        "cachedContentTokenCount",
        "totalTokenCount",
    ] {
        let mut row = qwen("m1");
        row["usageMetadata"].as_object_mut().unwrap().remove(field);
        assert!(matches!(
            session_usage_qwen::parse(&row),
            Parsed::Unsupported
        ));
    }
    let mut row = qwen("m1");
    row["usageMetadata"]["cachedContentTokenCount"] = json!(101);
    assert!(matches!(
        session_usage_qwen::parse(&row),
        Parsed::Unsupported
    ));
    row["usageMetadata"] = Value::Null;
    assert!(matches!(session_usage_qwen::parse(&row), Parsed::Unmetered));
}

#[test]
fn qwen_nested_branches_copies_restart_partial_tail_and_multiple_calls() {
    let temp = tempfile::tempdir().unwrap();
    let roots = SourceRoots::from_home(temp.path());
    let path = roots.qwen.join("tmp/project/chats/arbitrary-name.jsonl");
    let mut branch = qwen("m1");
    branch["sessionId"] = json!("child");
    branch["forkedFrom"] = json!({"sessionId":"q-session","messageUuid":"m1"});
    let mut nested = branch.clone();
    nested["sessionId"] = json!("grandchild");
    nested["forkedFrom"]["sessionId"] = json!("child");
    put(&path, &[qwen("m1"), branch, nested]);
    let db = Database::open(&temp.path().join("ledger")).unwrap();
    sync_all_unlocked(&db, &roots).unwrap();
    assert_eq!(totals(&db, "qwen"), (1, 120));
    let text = qwen("m2").to_string();
    let mid = text.len() / 2;
    let mut file = fs::OpenOptions::new().append(true).open(&path).unwrap();
    file.write_all(text[..mid].as_bytes()).unwrap();
    assert_eq!(
        status(&sync_all_unlocked(&db, &roots).unwrap(), "qwen").deferred_files,
        1
    );
    drop(db);
    let db = Database::open(&temp.path().join("ledger")).unwrap();
    file.write_all(format!("{}\n", &text[mid..]).as_bytes())
        .unwrap();
    drop(file);
    fs::copy(&path, path.with_file_name("copy.jsonl")).unwrap();
    sync_all_unlocked(&db, &roots).unwrap();
    assert_eq!(totals(&db, "qwen"), (2, 240));
    assert_eq!(sync_all_unlocked(&db, &roots).unwrap().imported, 0);
    drop(db);
    let bytes = fs::read(temp.path().join("ledger/token-usage-lab.sqlite3")).unwrap();
    let text = String::from_utf8_lossy(&bytes);
    assert!(!text.contains("PRIVATE_DO_NOT_STORE"));
    assert!(!text.contains("q-session"));
}

#[test]
fn qwen_background_and_subagents_are_explicit_and_never_assigned_to_the_device_owner() {
    let temp = tempfile::tempdir().unwrap();
    let roots = SourceRoots::from_home(temp.path());
    let mut sub = qwen("sub");
    sub["isSidechain"] = json!(true);
    sub["agentId"] = json!("private-agent");
    let mut background = qwen("background");
    background["backgroundTurn"] = json!({"id":"background-turn"});
    put(&roots.qwen.join("tmp/a/chats/a.jsonl"), &[sub, background]);
    let db = Database::memory().unwrap();
    sync_all_unlocked(&db, &roots).unwrap();
    let conn = db.conn.lock().unwrap();
    let count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM proxy_request_logs WHERE
        execution_kind IN ('subagent','background') AND actor_kind='unattributed'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(count, 2);
}

fn message(output: u32) -> Value {
    json!({"role":"assistant","modelID":"model-one","time":{"created":START+1000,"completed":START+2000},
        "tokens":{"input":10,"output":output,"reasoning":5,"cache":{"read":30,"write":40}},
        "content":"PRIVATE_DO_NOT_STORE","apiKey":"sk-PRIVATE_DO_NOT_STORE"})
}

fn make_db(root: &Path, source: &str, v2: bool, old_v2_sessions: bool) -> Connection {
    fs::create_dir_all(root).unwrap();
    let db = Connection::open(root.join(format!("{source}.db"))).unwrap();
    let session_table = if old_v2_sessions {
        "session_v2"
    } else {
        "session"
    };
    db.execute_batch(&format!(
        "CREATE TABLE {session_table}(id TEXT PRIMARY KEY,time_created INTEGER,parent_id TEXT);
        INSERT INTO {session_table} VALUES ('s1',{START},NULL);"
    ))
    .unwrap();
    if v2 {
        db.execute_batch("CREATE TABLE session_message(id TEXT PRIMARY KEY,session_id TEXT,type TEXT,time_updated INTEGER,data TEXT);").unwrap();
    } else {
        db.execute_batch("CREATE TABLE message(id TEXT PRIMARY KEY,session_id TEXT,time_updated INTEGER,data TEXT);").unwrap();
    }
    db
}

fn insert(
    db: &Connection,
    v2: bool,
    id: &str,
    session: &str,
    kind: &str,
    revision: i64,
    value: &Value,
) {
    if v2 {
        db.execute(
            "INSERT OR REPLACE INTO session_message VALUES (?1,?2,?3,?4,?5)",
            params![id, session, kind, revision, value.to_string()],
        )
        .unwrap();
    } else {
        db.execute(
            "INSERT OR REPLACE INTO message VALUES (?1,?2,?3,?4)",
            params![id, session, revision, value.to_string()],
        )
        .unwrap();
    }
}

#[test]
fn sqlite_revisions_replace_counts_without_moving_the_call_date_and_stale_copies_never_overwrite() {
    let temp = tempfile::tempdir().unwrap();
    let mut roots = SourceRoots::from_home(temp.path());
    let writer = make_db(&roots.opencode, "opencode", false, false);
    insert(
        &writer,
        false,
        "m1",
        "s1",
        "assistant",
        START + 3000,
        &message(20),
    );
    insert(
        &writer,
        false,
        "m2",
        "s1",
        "assistant",
        START + 3000,
        &message(20),
    );
    let copy = temp.path().join("copy");
    fs::create_dir_all(&copy).unwrap();
    fs::copy(roots.opencode.join("opencode.db"), copy.join("opencode.db")).unwrap();
    let db = Database::open(&temp.path().join("ledger")).unwrap();
    let first = sync_all_unlocked(&db, &roots).unwrap();
    assert_eq!(status(&first, "opencode").file_errors, 0);
    assert_eq!(totals(&db, "opencode"), (2, 210));
    assert_eq!(sync_all_unlocked(&db, &roots).unwrap().imported, 0);
    insert(
        &writer,
        false,
        "m1",
        "s1",
        "assistant",
        START + 86_400_000,
        &message(10),
    );
    let update = sync_all_unlocked(&db, &roots).unwrap();
    assert_eq!(status(&update, "opencode").updated, 1);
    assert_eq!(totals(&db, "opencode"), (2, 200));
    {
        let conn = db.conn.lock().unwrap();
        let min_time: i64 = conn
            .query_row(
                "SELECT MIN(event_time_ms) FROM proxy_request_logs",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let max_time: i64 = conn
            .query_row(
                "SELECT MAX(event_time_ms) FROM proxy_request_logs",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!((min_time, max_time), (START + 1000, START + 1000));
    }
    drop(db);
    let db = Database::open(&temp.path().join("ledger")).unwrap();
    roots.opencode = copy;
    sync_all_unlocked(&db, &roots).unwrap();
    assert_eq!(totals(&db, "opencode"), (2, 200));
}

#[test]
fn sqlite_reads_wal_only_appends_and_never_writes_database_or_wal_contents() {
    let temp = tempfile::tempdir().unwrap();
    let roots = SourceRoots::from_home(temp.path());
    let writer = make_db(&roots.opencode, "opencode", false, false);
    writer
        .execute_batch("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;")
        .unwrap();
    insert(
        &writer,
        false,
        "m1",
        "s1",
        "assistant",
        START + 3000,
        &message(20),
    );
    let path = roots.opencode.join("opencode.db");
    let main = fs::read(&path).unwrap();
    let wal_path = path.with_extension("db-wal");
    let wal = fs::read(&wal_path).unwrap();
    let db = Database::memory().unwrap();
    sync_all_unlocked(&db, &roots).unwrap();
    assert_eq!(totals(&db, "opencode"), (1, 105));
    assert_eq!(fs::read(&path).unwrap(), main);
    assert_eq!(fs::read(&wal_path).unwrap(), wal);
    insert(
        &writer,
        false,
        "m2",
        "s1",
        "assistant",
        START + 4000,
        &message(20),
    );
    assert_eq!(fs::read(&path).unwrap(), main);
    sync_all_unlocked(&db, &roots).unwrap();
    assert_eq!(totals(&db, "opencode"), (2, 210));
    writer
        .execute(
            "UPDATE message SET time_updated=time_updated+1 WHERE id='m2'",
            [],
        )
        .unwrap();
}

#[test]
fn sqlite_v2_prefers_active_table_for_both_session_table_layouts_and_counts_compaction_once() {
    for old_v2 in [false, true] {
        let temp = tempfile::tempdir().unwrap();
        let roots = SourceRoots::from_home(temp.path());
        let writer = make_db(&roots.opencode, "opencode", true, old_v2);
        writer
            .execute_batch(
                "CREATE TABLE message(id TEXT,session_id TEXT,time_updated INTEGER,data TEXT);",
            )
            .unwrap();
        insert(
            &writer,
            false,
            "legacy",
            "s1",
            "assistant",
            START + 3000,
            &message(999),
        );
        let mut row = message(20);
        row.as_object_mut().unwrap().remove("role");
        row.as_object_mut().unwrap().remove("modelID");
        row["model"] = json!({"id":"v2-model"});
        insert(&writer, true, "m1", "s1", "assistant", START + 3000, &row);
        row["status"] = json!("failed");
        row["time"].as_object_mut().unwrap().remove("completed");
        insert(&writer, true, "c1", "s1", "compaction", START + 3000, &row);
        let db = Database::memory().unwrap();
        sync_all_unlocked(&db, &roots).unwrap();
        assert_eq!(totals(&db, "opencode"), (2, 210));
    }
}

#[test]
fn sqlite_incomplete_missing_invalid_and_copied_pre_session_events_are_not_guessed() {
    let temp = tempfile::tempdir().unwrap();
    let roots = SourceRoots::from_home(temp.path());
    let writer = make_db(&roots.opencode, "opencode", false, false);
    let mut incomplete = message(20);
    incomplete["time"]
        .as_object_mut()
        .unwrap()
        .remove("completed");
    insert(
        &writer,
        false,
        "pending",
        "s1",
        "assistant",
        START + 3000,
        &incomplete,
    );
    let mut missing = message(20);
    missing["tokens"]["cache"]
        .as_object_mut()
        .unwrap()
        .remove("read");
    insert(
        &writer,
        false,
        "missing",
        "s1",
        "assistant",
        START + 3000,
        &missing,
    );
    let mut unmetered = message(20);
    unmetered.as_object_mut().unwrap().remove("tokens");
    insert(
        &writer,
        false,
        "unmetered",
        "s1",
        "assistant",
        START + 3000,
        &unmetered,
    );
    writer
        .execute(
            "INSERT INTO session VALUES ('fork',?1,NULL)",
            [START + 5000],
        )
        .unwrap();
    insert(
        &writer,
        false,
        "fork-copy",
        "fork",
        "assistant",
        START + 6000,
        &message(20),
    );
    writer
        .execute(
            "INSERT INTO message VALUES ('broken','s1',?1,'{broken}')",
            [START + 3000],
        )
        .unwrap();
    let db = Database::memory().unwrap();
    let scan = status(&sync_all_unlocked(&db, &roots).unwrap(), "opencode");
    assert_eq!(totals(&db, "opencode"), (0, 0));
    assert_eq!(
        (
            scan.unsupported,
            scan.unmetered,
            scan.deferred_files,
            scan.malformed
        ),
        (2, 1, 1, 1)
    );
    assert_eq!(scan.state, "partial");
    insert(
        &writer,
        false,
        "pending",
        "s1",
        "assistant",
        START + 3001,
        &message(20),
    );
    sync_all_unlocked(&db, &roots).unwrap();
    assert_eq!(totals(&db, "opencode"), (1, 105));
}

#[test]
fn kilo_and_opencode_are_distinct_sources_with_private_labels_and_no_body_persistence() {
    let temp = tempfile::tempdir().unwrap();
    let roots = SourceRoots::from_home(temp.path());
    for (source, root) in [("opencode", &roots.opencode), ("kilo", &roots.kilo)] {
        let writer = make_db(root, source, false, false);
        insert(
            &writer,
            false,
            "m1",
            "s1",
            "assistant",
            START + 3000,
            &message(20),
        );
        writer
            .execute("UPDATE session SET parent_id='parent'", [])
            .unwrap();
    }
    let db = Database::open(&temp.path().join("ledger")).unwrap();
    let sync = sync_all_unlocked(&db, &roots).unwrap();
    assert_eq!(sync.sources.len(), 9);
    for source in ["kilo", "opencode"] {
        assert_eq!(totals(&db, source), (1, 105));
        assert_eq!(status(&sync, source).validation, "fixtures-only");
    }
    drop(db);
    let bytes = fs::read(temp.path().join("ledger/token-usage-lab.sqlite3")).unwrap();
    assert!(!String::from_utf8_lossy(&bytes).contains("PRIVATE_DO_NOT_STORE"));
}

#[test]
fn corrupt_sqlite_is_isolated_from_other_sources_and_source_directories_cannot_hold_the_ledger() {
    let temp = tempfile::tempdir().unwrap();
    let roots = SourceRoots::from_home(temp.path());
    fs::create_dir_all(&roots.opencode).unwrap();
    fs::write(roots.opencode.join("opencode.db"), "not sqlite").unwrap();
    put(&roots.qwen.join("tmp/a/chats/a.jsonl"), &[qwen("m1")]);
    let db = Database::memory().unwrap();
    let result = sync_all_unlocked(&db, &roots).unwrap();
    assert_eq!(status(&result, "opencode").file_errors, 1);
    assert_eq!(totals(&db, "qwen"), (1, 120));
    for directory in [&roots.opencode, &roots.kilo, &roots.qwen] {
        assert!(Database::open(directory).is_err());
    }
}

#[test]
fn incomplete_input_breakdown_follows_api_filter_scope_without_hiding_known_totals() {
    use crate::api::{dispatch, Request};
    let temp = tempfile::tempdir().unwrap();
    let roots = SourceRoots::from_home(temp.path());
    put(&roots.qwen.join("tmp/a/chats/a.jsonl"), &[qwen("m1")]);
    let writer = make_db(&roots.opencode, "opencode", false, false);
    insert(
        &writer,
        false,
        "m1",
        "s1",
        "assistant",
        START + 3000,
        &message(20),
    );
    let db = Database::memory().unwrap();
    sync_all_unlocked(&db, &roots).unwrap();
    let call = |command: &str, args: Value| {
        dispatch(
            &db,
            &roots,
            Request {
                command: command.into(),
                args,
            },
        )
        .unwrap()
    };
    let all = call("get_usage_summary", json!({}));
    assert_eq!(all["realTotalTokens"], 225);
    assert_eq!(all["inputBreakdownComplete"], false);
    let known = call("get_usage_summary", json!({"model":"model-one"}));
    assert_eq!(known["realTotalTokens"], 105);
    assert!(known.get("inputBreakdownComplete").is_none());
    let groups = call("get_usage_summary_by_app", json!({}));
    for group in groups.as_array().unwrap() {
        assert_eq!(
            group["summary"].get("inputBreakdownComplete").is_some(),
            group["appType"] == "qwen"
        );
    }
    let logs = call("get_request_logs", json!({"filters":{"appType":"qwen"}}));
    assert_eq!(logs["data"][0]["inputBreakdownComplete"], false);
    let detail = call(
        "get_request_detail",
        json!({"requestId":logs["data"][0]["requestId"]}),
    );
    assert_eq!(detail["inputBreakdownComplete"], false);
}
