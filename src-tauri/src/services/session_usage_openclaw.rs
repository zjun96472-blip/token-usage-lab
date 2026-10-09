use super::usage_record::{self as common, Parsed, UsageRecord};
use serde_json::Value;

pub fn parse(value: &Value, session: Option<&str>, agent: &str) -> Parsed {
    parse_source(value, session, agent, "openclaw")
}

pub fn parse_source(
    value: &Value,
    session: Option<&str>,
    agent: &str,
    source: &'static str,
) -> Parsed {
    let kind = value["type"].as_str().unwrap_or("");
    let message = &value["message"];
    let usage = match kind {
        "message" if message["role"] == "assistant" => &message["usage"],
        "compaction" | "branch_summary" => &value["usage"],
        _ => return Parsed::Ignore,
    };
    if usage.is_null() {
        return Parsed::Unmetered;
    }
    match parse_record(value, usage, session, agent, source) {
        Some(record) => Parsed::Record(record),
        None => Parsed::Unsupported,
    }
}

fn parse_record(
    value: &Value,
    usage: &Value,
    session: Option<&str>,
    agent: &str,
    source: &'static str,
) -> Option<UsageRecord> {
    let session = session?;
    let entry = common::id(&value["id"])?;
    let input = common::count(&usage["input"])?;
    let output = common::count(&usage["output"])?;
    let cache_read = common::count(&usage["cacheRead"])?;
    let cache_write = common::count(&usage["cacheWrite"])?;
    // OpenClaw/Pi's normalized input excludes both cache categories.
    let total =
        u64::from(input) + u64::from(output) + u64::from(cache_read) + u64::from(cache_write);
    if let Some(reported) = usage.get("totalTokens") {
        if reported.as_u64()? != total {
            return None;
        }
    }
    let model =
        common::label(&value["message"]["model"]).or_else(|| common::label(&value["model"]))?;
    Some(UsageRecord {
        request_id: common::hash(&[source, session, entry]),
        source,
        session_key: session.to_owned(),
        model: model.to_owned(),
        input,
        output,
        cache_read,
        cache_write,
        event_time_ms: common::timestamp(&value["timestamp"])?,
        execution_kind: common::execution_kind(value),
        agent_key: Some(common::hash(&[agent])),
    })
}
