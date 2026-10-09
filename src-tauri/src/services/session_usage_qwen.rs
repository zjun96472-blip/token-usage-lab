use super::usage_record::{count, hash, id, label, timestamp, Parsed, UsageRecord};
use serde_json::Value;

pub fn parse(value: &Value) -> Parsed {
    if value["type"] != "assistant" {
        return Parsed::Ignore;
    }
    if value["usageMetadata"].is_null() {
        return Parsed::Unmetered;
    }
    parse_record(value).map_or(Parsed::Unsupported, Parsed::Record)
}

fn parse_record(value: &Value) -> Option<UsageRecord> {
    let message = id(&value["uuid"])?;
    let session = id(&value["sessionId"])?;
    let origin = if let Some(origin) = value.get("forkedFrom") {
        if id(&origin["messageUuid"])? != message {
            return None;
        }
        id(&origin["sessionId"])?
    } else {
        session
    };
    let usage = &value["usageMetadata"];
    let prompt = count(&usage["promptTokenCount"])?;
    let completion = count(&usage["candidatesTokenCount"])?;
    let cached = count(&usage["cachedContentTokenCount"])?;
    let total = usage["totalTokenCount"].as_u64()?;
    let thoughts = match usage.get("thoughtsTokenCount") {
        Some(value) => Some(count(value)?),
        None => None,
    };
    // Providers differ on reasoning containment. Require the reported total to resolve it.
    let output = if total == u64::from(prompt) + u64::from(completion) {
        if thoughts.is_some_and(|v| v > completion) {
            return None;
        }
        completion
    } else {
        let output = completion.checked_add(thoughts?)?;
        if total != u64::from(prompt) + u64::from(output) {
            return None;
        }
        output
    };
    for field in ["toolUsePromptTokenCount", "cacheCreationInputTokenCount"] {
        if usage.get(field).is_some_and(|v| count(v) != Some(0)) {
            return None;
        }
    }
    Some(UsageRecord {
        // Qwen preserves the globally generated message UUID across nested branches.
        request_id: hash(&["qwen", message]),
        source: "qwen",
        session_key: hash(&["qwen", origin]),
        model: label(&value["model"])?.into(),
        input: prompt.checked_sub(cached)?,
        output,
        cache_read: cached,
        cache_write: 0,
        event_time_ms: timestamp(&value["timestamp"])?,
        execution_kind: if value["isSidechain"] == true {
            "subagent"
        } else if value.get("backgroundTurn").is_some_and(Value::is_object) {
            "background"
        } else {
            "unknown"
        },
        agent_key: id(&value["agentId"]).map(|agent| hash(&["qwen", agent])),
    })
}
