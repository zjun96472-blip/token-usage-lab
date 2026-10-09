use super::usage_record::{self as common, Parsed, UsageRecord};
use serde_json::Value;

pub fn parse(value: &Value) -> Parsed {
    if value["type"] != "assistant" {
        return Parsed::Ignore;
    }
    let message = &value["message"];
    if message["model"] == "<synthetic>" {
        return Parsed::Ignore;
    }
    if message["usage"].is_null() {
        return Parsed::Unmetered;
    }
    parse_record(value).map_or(Parsed::Unsupported, Parsed::Record)
}

fn parse_record(value: &Value) -> Option<UsageRecord> {
    let message = &value["message"];
    let usage = &message["usage"];
    let session = common::id(&value["sessionId"])?;
    // Transcript UUIDs identify stream fragments, not model calls.
    let message_id = common::id(&message["id"])?;
    let input = common::count(&usage["input_tokens"])?;
    let output = common::count(&usage["output_tokens"])?;
    let cache_read = common::count(&usage["cache_read_input_tokens"])?;
    let cache_write = common::count(&usage["cache_creation_input_tokens"])?;
    if let Some(buckets) = usage.get("cache_creation") {
        let short = common::count(&buckets["ephemeral_5m_input_tokens"])?;
        let long = common::count(&buckets["ephemeral_1h_input_tokens"])?;
        if short.checked_add(long)? != cache_write {
            return None;
        }
    }
    Some(UsageRecord {
        request_id: common::hash(&["claude", session, message_id]),
        source: "claude",
        session_key: common::hash(&["claude", session]),
        model: common::label(&message["model"])?.to_owned(),
        input,
        output,
        cache_read,
        cache_write,
        event_time_ms: common::timestamp(&value["timestamp"])?,
        execution_kind: if value["isSidechain"] == true {
            "subagent"
        } else {
            common::execution_kind(value)
        },
        agent_key: common::id(&value["agentId"]).map(|id| common::hash(&["claude", id])),
    })
}
