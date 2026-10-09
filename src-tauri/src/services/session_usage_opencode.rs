use super::usage_record::{count, hash, id, label, timestamp, Parsed, UsageRecord};
use serde_json::Value;

pub struct Message<'a> {
    pub source: &'static str,
    pub session: &'a str,
    pub message: &'a str,
    pub kind: &'a str,
    pub session_created: i64,
    pub child_session: bool,
    pub revision: i64,
}

pub fn parse(value: &Value, message: &Message<'_>) -> Parsed {
    if !matches!(message.kind, "assistant" | "compaction") {
        return Parsed::Ignore;
    }
    if value["tokens"].is_null() {
        return Parsed::Unmetered;
    }
    parse_record(value, message).map_or(Parsed::Unsupported, Parsed::Record)
}

fn parse_record(value: &Value, message: &Message<'_>) -> Option<UsageRecord> {
    let created = timestamp(&value["time"]["created"])?;
    // Forks can allocate new IDs to copied history. Pre-session events are not new calls.
    if created < message.session_created || message.revision < created {
        return None;
    }
    if message.kind == "assistant" {
        let completed = timestamp(&value["time"]["completed"])?;
        if completed < created {
            return None;
        }
    } else if !matches!(value["status"].as_str(), Some("completed" | "failed")) {
        return None;
    }
    let model = label(&value["modelID"])
        .or_else(|| label(&value["model"]["id"]))
        .or_else(|| label(&value["model"]))?;
    if message.session.is_empty()
        || message.message.is_empty()
        || message.session.len() > 512
        || message.message.len() > 512
    {
        return None;
    }
    let tokens = &value["tokens"];
    let record = UsageRecord {
        request_id: hash(&[message.source, message.session, message.message]),
        source: message.source,
        session_key: hash(&[message.source, message.session]),
        model: model.into(),
        input: count(&tokens["input"])?,
        output: count(&tokens["output"])?.checked_add(count(&tokens["reasoning"])?)?,
        cache_read: count(&tokens["cache"]["read"])?,
        cache_write: count(&tokens["cache"]["write"])?,
        event_time_ms: created,
        execution_kind: if message.kind == "compaction" {
            "background"
        } else if message.child_session {
            "subagent"
        } else {
            "unknown"
        },
        agent_key: id(&value["agent"]).map(|agent| hash(&[message.source, agent])),
    };
    if let Some(total) = tokens.get("total") {
        if !total.is_null() && total.as_u64()? != record.total() {
            return None;
        }
    }
    Some(record)
}
