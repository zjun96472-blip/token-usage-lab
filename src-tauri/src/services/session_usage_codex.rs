use super::usage_record::{self as common, Parsed, UsageRecord};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct State {
    session: Option<String>,
    model: Option<String>,
    previous: Option<Counters>,
    epoch: String,
    fork: bool,
    started_at: Option<i64>,
    subagent: bool,
}

impl State {
    pub fn invalidate_context(&mut self) {
        self.model = None;
        self.previous = None;
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
struct Counters {
    input: u64,
    output: u64,
    cached: u64,
}

impl Counters {
    fn parse(value: &Value) -> Option<Self> {
        let input = value["input_tokens"].as_u64()?;
        let output = value["output_tokens"].as_u64()?;
        let cached = value["cached_input_tokens"].as_u64()?;
        if cached > input || value["total_tokens"].as_u64()? != input.checked_add(output)? {
            return None;
        }
        // Reasoning is already in output. Nonzero cache writes have no verified containment contract.
        if value
            .get("cache_write_input_tokens")
            .is_some_and(|v| v.as_u64() != Some(0))
            || value
                .get("reasoning_output_tokens")
                .is_some_and(|v| v.as_u64().is_none_or(|n| n > output))
        {
            return None;
        }
        Some(Self {
            input,
            output,
            cached,
        })
    }

    fn delta(self, previous: Self) -> Option<Self> {
        let value = Self {
            input: self.input.checked_sub(previous.input)?,
            output: self.output.checked_sub(previous.output)?,
            cached: self.cached.checked_sub(previous.cached)?,
        };
        (value.cached <= value.input).then_some(value)
    }
}

pub fn parse(value: &Value, state: &mut State) -> Parsed {
    let payload = &value["payload"];
    match value["type"].as_str() {
        Some("session_meta") => {
            // Child sessions can share session_id with their parent; id is the thread identity.
            let id = common::id(&payload["id"]);
            let session = id.map(|id| common::hash(&["codex", id]));
            if state.session.is_some() {
                // Replayed parent headers must not change the physical thread identity.
                return Parsed::Ignore;
            }
            state.session = session;
            state.started_at = common::timestamp(&payload["timestamp"])
                .or_else(|| common::timestamp(&value["timestamp"]));
            state.subagent = payload["source"].get("subagent").is_some();
            state.fork =
                payload.get("forked_from_id").is_some_and(|v| !v.is_null()) || state.subagent;
            if let Some(model) = common::label(&payload["model"]) {
                state.model = Some(model.to_owned());
            }
            return Parsed::Ignore;
        }
        Some("turn_context") => {
            state.model = common::label(&payload["model"]).map(str::to_owned);
            return Parsed::Ignore;
        }
        Some("event_msg") if payload["type"] == "token_count" => (),
        // token_usage_record mirrors token_count; never sum both representations.
        _ => return Parsed::Ignore,
    }
    let info = &payload["info"];
    if info.is_null() {
        // A quota refresh without telemetry does not represent a model call.
        return Parsed::Ignore;
    }
    let Some(current) = Counters::parse(&info["total_token_usage"]) else {
        state.previous = None;
        return Parsed::Unsupported;
    };
    let previous = state.previous.replace(current);
    if previous == Some(current) {
        return Parsed::Ignore;
    }
    let Some(time) = common::timestamp(&value["timestamp"]) else {
        return Parsed::Unsupported;
    };
    if state.fork && state.started_at.is_none_or(|start| time <= start) {
        // Copied history seeds the baseline but is not a new child invocation.
        return if state.started_at.is_none() {
            Parsed::Unsupported
        } else {
            Parsed::Ignore
        };
    }
    let Some(delta) = current.delta(previous.unwrap_or_default()) else {
        state.epoch = time.to_string();
        return Parsed::Unsupported;
    };
    if delta == Counters::default() {
        return Parsed::Ignore;
    }
    // Truncated histories and batched/ambiguous snapshots cannot be attributed to one call.
    if Counters::parse(&info["last_token_usage"]) != Some(delta) {
        return Parsed::Unsupported;
    }
    make_record(state, current, delta, time).map_or(Parsed::Unsupported, Parsed::Record)
}

fn make_record(
    state: &State,
    current: Counters,
    delta: Counters,
    time: i64,
) -> Option<UsageRecord> {
    let session = state.session.as_deref()?;
    let signature = format!("{}:{}:{}", current.input, current.output, current.cached);
    Some(UsageRecord {
        request_id: common::hash(&["codex", session, &state.epoch, &signature]),
        source: "codex",
        session_key: session.to_owned(),
        model: state.model.clone()?,
        input: u32::try_from(delta.input.checked_sub(delta.cached)?).ok()?,
        output: u32::try_from(delta.output).ok()?,
        cache_read: u32::try_from(delta.cached).ok()?,
        cache_write: 0,
        event_time_ms: time,
        execution_kind: if state.subagent {
            "subagent"
        } else {
            "unknown"
        },
        agent_key: None,
    })
}
