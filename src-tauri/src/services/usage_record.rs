use serde_json::Value;
use sha2::{Digest, Sha256};

pub const ADAPTER_VERSION: i64 = 2;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UsageRecord {
    pub request_id: String,
    pub source: &'static str,
    pub session_key: String,
    pub model: String,
    pub input: u32,
    pub output: u32,
    pub cache_read: u32,
    pub cache_write: u32,
    pub event_time_ms: i64,
    pub execution_kind: &'static str,
    pub agent_key: Option<String>,
}

impl UsageRecord {
    pub fn total(&self) -> u64 {
        u64::from(self.input)
            + u64::from(self.output)
            + u64::from(self.cache_read)
            + u64::from(self.cache_write)
    }
}

pub enum Parsed {
    Record(UsageRecord),
    Ignore,
    Unmetered,
    Unsupported,
}

pub fn hash(parts: &[&str]) -> String {
    let mut state = Sha256::new();
    for part in parts {
        state.update((part.len() as u64).to_le_bytes());
        state.update(part.as_bytes());
    }
    format!("{:x}", state.finalize())
}

pub fn label(value: &Value) -> Option<&str> {
    value.as_str().filter(|value| {
        !value.is_empty()
            && value.len() <= 256
            && value
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || "-_.:/ @+()".contains(c))
            && !value.contains("://")
            && !value.starts_with("sk-")
    })
}

pub fn id(value: &Value) -> Option<&str> {
    value.as_str().filter(|v| !v.is_empty() && v.len() <= 512)
}
pub fn count(value: &Value) -> Option<u32> {
    value.as_u64().and_then(|v| u32::try_from(v).ok())
}

pub fn timestamp(value: &Value) -> Option<i64> {
    let result = if let Some(value) = value.as_str() {
        chrono::DateTime::parse_from_rfc3339(value)
            .ok()?
            .timestamp_millis()
    } else {
        let value = value.as_i64()?;
        if value > 100_000_000_000 {
            value
        } else {
            value.checked_mul(1000)?
        }
    };
    (result >= 0 && result <= 253_402_300_799_000).then_some(result)
}

pub fn execution_kind(value: &Value) -> &'static str {
    if value.get("isBackground").and_then(Value::as_bool) == Some(true) {
        "background"
    } else {
        "unknown"
    }
}
