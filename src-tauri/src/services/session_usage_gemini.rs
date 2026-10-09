use super::usage_record::{self as common, Parsed, UsageRecord};
use serde_json::Value;

pub fn parse_entries(value: &Value, session: &mut Option<String>) -> Vec<Parsed> {
    let envelope = value.get("$set").unwrap_or(value);
    if let Some(id) = common::id(&envelope["sessionId"]) {
        *session = Some(common::hash(&["gemini", id]));
    }
    if let Some(messages) = envelope["messages"].as_array() {
        return messages
            .iter()
            .map(|message| parse(message, session.as_deref()))
            .collect();
    }
    // Rewind removes conversation context, not the historical model usage ledger.
    if value.get("$rewindTo").is_some()
        || envelope.get("sessionId").is_some()
        || value.get("$set").is_some()
    {
        return vec![Parsed::Ignore];
    }
    vec![parse(value, session.as_deref())]
}

pub fn parse(message: &Value, session: Option<&str>) -> Parsed {
    if message["type"] != "gemini" {
        return Parsed::Ignore;
    }
    if message["tokens"].is_null() {
        return Parsed::Unmetered;
    }
    parse_record(message, session).map_or(Parsed::Unsupported, Parsed::Record)
}

fn parse_record(message: &Value, session: Option<&str>) -> Option<UsageRecord> {
    let usage = &message["tokens"];
    let input = common::count(&usage["input"])?;
    let cached = common::count(&usage["cached"])?;
    let output = common::count(&usage["output"])?;
    let thoughts = common::count(&usage["thoughts"])?;
    let output = output.checked_add(thoughts)?;
    if usage.get("tool").is_some_and(|v| v.as_u64() != Some(0)) {
        return None;
    }
    if usage["total"].as_u64()? != u64::from(input) + u64::from(output) {
        return None;
    }
    let session = session?;
    let message_id = common::id(&message["id"])?;
    Some(UsageRecord {
        request_id: common::hash(&["gemini", session, message_id]),
        source: "gemini",
        session_key: session.to_owned(),
        model: common::label(&message["model"])?.to_owned(),
        input: input.checked_sub(cached)?,
        output,
        cache_read: cached,
        cache_write: 0,
        event_time_ms: common::timestamp(&message["timestamp"])?,
        execution_kind: common::execution_kind(message),
        agent_key: None,
    })
}
