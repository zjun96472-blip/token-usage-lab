use super::*;
use serde_json::{json, Value};
use std::io::Write;

fn put(path: &Path, rows: &[Value]) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(
        path,
        rows.iter().map(|v| format!("{v}\n")).collect::<String>(),
    )
    .unwrap();
}
fn append(path: &Path, value: &str) {
    fs::OpenOptions::new()
        .append(true)
        .open(path)
        .unwrap()
        .write_all(value.as_bytes())
        .unwrap();
}
fn totals(db: &Database, source: &str) -> (u64, u64) {
    let v = db
        .get_usage_summary(None, None, Some(source), None, None)
        .unwrap();
    (v.total_requests, v.real_total_tokens)
}
fn meta() -> Value {
    json!({"type":"session_meta","timestamp":"2026-10-01T00:00:00Z","payload":{
        "id":"thread-a","session_id":"not-the-thread-id","timestamp":"2026-10-01T00:00:00Z"}})
}
fn context(model: &str) -> Value {
    json!({"type":"turn_context","payload":{"model":model,"content":"PRIVATE_DO_NOT_STORE"}})
}
fn counters(input: u64, output: u64, cached: u64) -> Value {
    json!({"input_tokens":input,"output_tokens":output,"cached_input_tokens":cached,
        "reasoning_output_tokens":output/2,"total_tokens":input+output,"cache_write_input_tokens":0})
}
fn token(total: (u64, u64, u64), last: (u64, u64, u64), time: &str) -> Value {
    json!({"type":"event_msg","timestamp":time,"payload":{"type":"token_count","info":{
        "total_token_usage":counters(total.0,total.1,total.2),
        "last_token_usage":counters(last.0,last.1,last.2)}}})
}
fn first_token() -> Value {
    token((100, 20, 60), (100, 20, 60), "2026-10-01T01:00:00Z")
}
fn claude(id: &str, output: u32, time: &str) -> Value {
    json!({"type":"assistant","sessionId":"s1","uuid":"fragment","timestamp":time,
        "message":{"id":id,"model":"claude-test","role":"assistant","content":"PRIVATE_DO_NOT_STORE",
            "usage":{"input_tokens":10,"output_tokens":output,"cache_read_input_tokens":30,
                "cache_creation_input_tokens":40,"cache_creation":{
                    "ephemeral_5m_input_tokens":30,"ephemeral_1h_input_tokens":10}}}})
}

#[test]
fn codex_cumulative_snapshots_mirrors_and_model_changes_count_only_deltas() {
    let temp = tempfile::tempdir().unwrap();
    let roots = SourceRoots::from_home(temp.path());
    let path = roots.codex.join("sessions/2026/10/01/rollout.jsonl");
    let second = token((230, 50, 160), (130, 30, 100), "2026-10-02T01:00:00Z");
    let mut duplicate = first_token();
    duplicate["timestamp"] = json!("2026-10-01T01:00:01Z");
    put(
        &path,
        &[
            meta(),
            context("gpt-test"),
            first_token(),
            duplicate,
            json!({"type":"token_usage_record","payload":{"usage":counters(100,20,60)}}),
            context("second-model"),
            second,
        ],
    );
    let db = Database::memory().unwrap();
    sync_all_unlocked(&db, &roots).unwrap();
    assert_eq!(totals(&db, "codex"), (2, 280));
    let models = db
        .get_model_stats(None, None, Some("codex"), None, None)
        .unwrap();
    assert_eq!(models.len(), 2);
    assert_eq!(models.iter().map(|v| v.total_tokens).sum::<u64>(), 280);
    assert_eq!(
        db.get_usage_summary(None, None, Some("codex"), None, None)
            .unwrap()
            .total_cache_read_tokens,
        160
    );
}

#[test]
fn codex_restart_archive_copy_partial_tail_append_and_rewrite_are_idempotent() {
    let temp = tempfile::tempdir().unwrap();
    let roots = SourceRoots::from_home(temp.path());
    let path = roots.codex.join("sessions/a.jsonl");
    put(&path, &[meta(), context("gpt-test"), first_token()]);
    let db = Database::open(&temp.path().join("lab")).unwrap();
    sync_all_unlocked(&db, &roots).unwrap();
    let next = token((230, 50, 160), (130, 30, 100), "2026-10-02T01:00:00Z").to_string();
    append(&path, &next[..next.len() / 2]);
    assert_eq!(sync_all_unlocked(&db, &roots).unwrap().deferred_files, 1);
    drop(db);
    let db = Database::open(&temp.path().join("lab")).unwrap();
    append(&path, &format!("{}\n", &next[next.len() / 2..]));
    sync_all_unlocked(&db, &roots).unwrap();
    assert_eq!(totals(&db, "codex"), (2, 280));
    let archive = roots.codex.join("archived_sessions");
    fs::create_dir_all(&archive).unwrap();
    fs::copy(&path, archive.join("copy.jsonl")).unwrap();
    assert_eq!(sync_all_unlocked(&db, &roots).unwrap().imported, 0);
    put(&path, &[meta(), context("gpt-test"), first_token()]);
    sync_all_unlocked(&db, &roots).unwrap();
    assert_eq!(totals(&db, "codex"), (2, 280));
}

#[test]
fn codex_missing_fields_counter_resets_and_unknown_models_are_not_guessed() {
    for pointer in [
        "/payload/info/last_token_usage/input_tokens",
        "/payload/info/total_token_usage/cached_input_tokens",
    ] {
        let mut state = session_usage_codex::State::default();
        session_usage_codex::parse(&meta(), &mut state);
        session_usage_codex::parse(&context("gpt-test"), &mut state);
        let mut row = first_token();
        *row.pointer_mut(pointer).unwrap() = Value::Null;
        assert!(matches!(
            session_usage_codex::parse(&row, &mut state),
            Parsed::Unsupported
        ));
    }
    let mut state = session_usage_codex::State::default();
    session_usage_codex::parse(&meta(), &mut state);
    assert!(matches!(
        session_usage_codex::parse(&first_token(), &mut state),
        Parsed::Unsupported
    ));
    session_usage_codex::parse(&context("gpt-test"), &mut state);
    assert!(matches!(
        session_usage_codex::parse(
            &token((5, 1, 0), (5, 1, 0), "2026-10-02T00:00:00Z"),
            &mut state
        ),
        Parsed::Unsupported
    ));
    assert!(matches!(
        session_usage_codex::parse(
            &token((15, 3, 0), (10, 2, 0), "2026-10-02T00:01:00Z"),
            &mut state
        ),
        Parsed::Record(_)
    ));
    let mut absent = session_usage_codex::State::default();
    session_usage_codex::parse(&meta(), &mut absent);
    session_usage_codex::parse(&context("gpt-test"), &mut absent);
    assert!(matches!(
        session_usage_codex::parse(
            &token((1000, 200, 100), (100, 20, 10), "2026-10-02T00:00:00Z"),
            &mut absent
        ),
        Parsed::Unsupported
    ));
}

#[test]
fn malformed_codex_context_never_inherits_the_previous_model() {
    let temp = tempfile::tempdir().unwrap();
    let roots = SourceRoots::from_home(temp.path());
    let path = roots.codex.join("sessions/a.jsonl");
    put(&path, &[meta(), context("gpt-test"), first_token()]);
    append(&path, "{broken-context}\n");
    append(
        &path,
        &format!(
            "{}\n",
            token((230, 50, 160), (130, 30, 100), "2026-10-02T01:00:00Z")
        ),
    );
    let db = Database::memory().unwrap();
    let sync = sync_all_unlocked(&db, &roots).unwrap();
    assert_eq!(totals(&db, "codex"), (1, 120));
    let status = sync.sources.iter().find(|s| s.source == "codex").unwrap();
    assert_eq!((status.malformed, status.unsupported), (1, 1));
}

#[test]
fn codex_fork_history_is_not_new_child_usage_and_parent_session_id_is_not_identity() {
    let temp = tempfile::tempdir().unwrap();
    let roots = SourceRoots::from_home(temp.path());
    put(
        &roots.codex.join("sessions/parent.jsonl"),
        &[meta(), context("gpt-test"), first_token()],
    );
    let mut child = meta();
    child["payload"]["id"] = json!("child-thread");
    child["payload"]["forked_from_id"] = json!("thread-a");
    child["payload"]["source"] =
        json!({"subagent":{"thread_spawn":{"parent_thread_id":"thread-a"}}});
    child["payload"]["timestamp"] = json!("2026-10-01T02:00:00Z");
    put(
        &roots.codex.join("sessions/child.jsonl"),
        &[
            child,
            context("gpt-test"),
            first_token(),
            token((230, 50, 160), (130, 30, 100), "2026-10-02T01:00:00Z"),
        ],
    );
    let db = Database::memory().unwrap();
    sync_all_unlocked(&db, &roots).unwrap();
    assert_eq!(totals(&db, "codex"), (2, 280));
    let conn = db.conn.lock().unwrap();
    let count: i64 = conn.query_row("SELECT COUNT(*) FROM proxy_request_logs WHERE execution_kind='subagent' AND actor_kind='unattributed'",[],|r|r.get(0)).unwrap();
    assert_eq!(count, 1);
}

#[test]
fn claude_stream_fragments_update_one_call_subagents_and_cache_buckets_are_distinct() {
    let temp = tempfile::tempdir().unwrap();
    let roots = SourceRoots::from_home(temp.path());
    let path = roots
        .claude
        .join("projects/project/session/subagents/agent.jsonl");
    let mut second = claude("m1", 20, "2026-10-01T01:00:01Z");
    second["uuid"] = json!("different-fragment");
    second["isSidechain"] = json!(true);
    put(
        &path,
        &[
            claude("m1", 1, "2026-10-01T01:00:00Z"),
            second,
            claude("m2", 30, "2026-10-01T01:01:00Z"),
        ],
    );
    let before = fs::read(&path).unwrap();
    let db = Database::memory().unwrap();
    sync_all_unlocked(&db, &roots).unwrap();
    assert_eq!(totals(&db, "claude"), (2, 210));
    fs::copy(&path, path.with_file_name("copy.jsonl")).unwrap();
    assert_eq!(sync_all_unlocked(&db, &roots).unwrap().imported, 0);
    assert_eq!(totals(&db, "claude"), (2, 210));
    assert_eq!(fs::read(&path).unwrap(), before);
    let conn = db.conn.lock().unwrap();
    let count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM proxy_request_logs WHERE execution_kind='subagent'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(count, 1);
}

#[test]
fn claude_absent_cache_is_unknown_not_zero_and_nested_cache_is_not_added_twice() {
    let mut value = claude("m", 20, "2026-10-01T01:00:00Z");
    assert!(matches!(session_usage_claude::parse(&value),Parsed::Record(ref r) if r.total()==100));
    value["message"]["usage"]["cache_creation"]["ephemeral_5m_input_tokens"] = json!(99);
    assert!(matches!(
        session_usage_claude::parse(&value),
        Parsed::Unsupported
    ));
    value["message"]["usage"] = Value::Null;
    assert!(matches!(
        session_usage_claude::parse(&value),
        Parsed::Unmetered
    ));
    value = claude("m", 20, "2026-10-01T01:00:00Z");
    value["message"]["usage"]["cache_read_input_tokens"] = Value::Null;
    assert!(matches!(
        session_usage_claude::parse(&value),
        Parsed::Unsupported
    ));
}

fn gemini(output: u32) -> Value {
    json!({"id":"g1","type":"gemini","model":"gemini-test","timestamp":"2026-10-01T01:00:00Z",
        "tokens":{"input":100,"output":output,"cached":60,"thoughts":5,"tool":0,"total":105+output}})
}

#[test]
fn gemini_json_and_jsonl_mirrors_updates_rewind_and_partial_snapshot() {
    let temp = tempfile::tempdir().unwrap();
    let roots = SourceRoots::from_home(temp.path());
    let path = roots.gemini.join("tmp/project/chats/session-a.json");
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(
        &path,
        json!({"sessionId":"g-session","messages":[gemini(20)]}).to_string(),
    )
    .unwrap();
    let db = Database::memory().unwrap();
    sync_all_unlocked(&db, &roots).unwrap();
    assert_eq!(totals(&db, "gemini"), (1, 125));
    let jsonl = path.with_extension("jsonl");
    put(
        &jsonl,
        &[
            json!({"sessionId":"g-session"}),
            gemini(20),
            json!({"$set":{"messages":[gemini(30)]}}),
            json!({"$rewindTo":"g1"}),
        ],
    );
    sync_all_unlocked(&db, &roots).unwrap();
    assert_eq!(totals(&db, "gemini"), (1, 135));
    fs::write(&path, "{\"sessionId\":").unwrap();
    assert_eq!(sync_all_unlocked(&db, &roots).unwrap().deferred_files, 1);
    assert_eq!(totals(&db, "gemini"), (1, 135));
}

#[test]
fn pi_and_openclaw_have_independent_namespaces() {
    let temp = tempfile::tempdir().unwrap();
    let roots = SourceRoots::from_home(temp.path());
    let rows = [
        json!({"type":"session","id":"same-session"}),
        json!({"type":"message","id":"same-message",
        "timestamp":"2026-10-01T01:00:00Z","message":{"role":"assistant","model":"pi-test",
            "usage":{"input":10,"output":20,"cacheRead":30,"cacheWrite":40,"totalTokens":100}}}),
    ];
    put(
        &roots.pi.join("agent/sessions/project/session.jsonl"),
        &rows,
    );
    put(
        &roots.openclaw.join("agents/main/sessions/session.jsonl"),
        &rows,
    );
    let db = Database::memory().unwrap();
    sync_all_unlocked(&db, &roots).unwrap();
    assert_eq!(totals(&db, "pi"), (1, 100));
    assert_eq!(totals(&db, "openclaw"), (1, 100));
}

#[test]
fn v1_database_migrates_without_losing_usage_and_parser_state_contains_no_content() {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(include_str!("../../database/usage_schema.sql"))
        .unwrap();
    // The normal open path exercises the same additive v1 -> v2 migration.
    let temp = tempfile::tempdir().unwrap();
    let db_path = temp.path().join("token-usage-lab.sqlite3");
    let old = Connection::open(&db_path).unwrap();
    old.execute_batch(include_str!("../../database/usage_schema.sql"))
        .unwrap();
    old.execute("INSERT INTO lab_settings VALUES ('preserved','yes')", [])
        .unwrap();
    drop(old);
    let db = Database::open(temp.path()).unwrap();
    let roots = SourceRoots::from_home(temp.path());
    put(
        &roots.codex.join("sessions/a.jsonl"),
        &[meta(), context("gpt-test"), first_token()],
    );
    sync_all_unlocked(&db, &roots).unwrap();
    let conn = db.conn.lock().unwrap();
    let state: String = conn
        .query_row(
            "SELECT parser_state FROM session_log_sync WHERE source='codex'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert!(!state.contains("PRIVATE"));
    assert!(!state.contains("thread-a"));
    assert_eq!(
        conn.query_row(
            "SELECT value FROM lab_settings WHERE key='preserved'",
            [],
            |r| r.get::<_, String>(0)
        )
        .unwrap(),
        "yes"
    );
}
