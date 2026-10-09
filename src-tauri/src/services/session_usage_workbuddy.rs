use super::usage_record::{self as common, Parsed, UsageRecord};
use serde_json::Value;

pub fn parse(value: &Value) -> Parsed {
    let data = &value["providerData"];
    let usage = &data["usage"];
    let mirror = &value["message"]["usage"];
    if usage.is_null() && mirror.is_null() {
        return if value["role"] == "assistant" || value["type"] == "function_call" {
            Parsed::Unmetered
        } else {
            Parsed::Ignore
        };
    }
    match parse_record(value) {
        Some(record) => Parsed::Record(record),
        None => Parsed::Unsupported,
    }
}

fn parse_record(value: &Value) -> Option<UsageRecord> {
    let data = &value["providerData"];
    let usage = &data["usage"];
    let raw = &data["rawUsage"];
    let mirror = &value["message"]["usage"];
    let session = common::id(&value["sessionId"])?;
    // A conversationRequestId/traceId identifies an agent turn, not a model call.
    let message = common::id(&data["messageId"])?;
    let model = common::label(&data["model"]).or_else(|| common::label(&data["model"]["id"]))?;
    let reported_input = common::count(&usage["inputTokens"])?;
    let output = common::count(&usage["outputTokens"])?;
    let total = common::count(&usage["totalTokens"])?;
    if common::count(&usage["requests"])? != 1
        || u64::from(total) != u64::from(reported_input) + u64::from(output)
    {
        return None;
    }
    let details = usage["inputTokensDetails"].as_array()?;
    if details.len() != 1 {
        return None;
    }
    let cache_read = common::count(&details[0]["cached_tokens"])?;
    let cache_write = common::count(&raw["cache_creation_input_tokens"])?;
    // The observed WorkBuddy format only establishes inclusive cache-read semantics.
    // Nonzero cache-write accounting requires a separately verified format adapter.
    if cache_write != 0 {
        return None;
    }
    let input = reported_input
        .checked_sub(cache_read)?
        .checked_sub(cache_write)?;
    for (field, expected) in [
        ("input_tokens", reported_input),
        ("output_tokens", output),
        ("total_tokens", total),
        ("cache_read_input_tokens", cache_read),
    ] {
        if common::count(&mirror[field])? != expected {
            return None;
        }
    }
    for (field, expected) in [
        ("prompt_tokens", reported_input),
        ("completion_tokens", output),
        ("total_tokens", total),
    ] {
        if let Some(value) = raw.get(field) {
            if common::count(value)? != expected {
                return None;
            }
        }
    }
    for (field, expected) in [
        ("prompt_cache_hit_tokens", cache_read),
        ("prompt_cache_miss_tokens", input),
        ("prompt_cache_write_tokens", cache_write),
    ] {
        if common::count(&raw[field])? != expected {
            return None;
        }
    }
    if common::count(&raw["prompt_tokens_details"]["cached_tokens"])? != cache_read {
        return None;
    }
    // Legacy aliases in the observed raw envelope are zero-filled placeholders.
    for field in ["cache_read_input_tokens", "cached_tokens"] {
        if let Some(value) = raw.get(field) {
            let alias = common::count(value)?;
            if alias != 0 && alias != cache_read {
                return None;
            }
        }
    }
    Some(UsageRecord {
        request_id: common::hash(&["workbuddy", session, message]),
        source: "workbuddy",
        session_key: common::hash(&["workbuddy", session]),
        model: model.to_owned(),
        input,
        output,
        cache_read,
        cache_write,
        event_time_ms: common::timestamp(&value["timestamp"])?,
        execution_kind: common::execution_kind(value),
        agent_key: None,
    })
}
