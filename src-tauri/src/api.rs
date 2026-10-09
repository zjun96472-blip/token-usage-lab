use crate::{
    database::Database,
    error::AppError,
    services::{
        session_usage::{self, SourceRoots},
        usage_stats::LogFilters,
    },
};
use serde::Deserialize;
use serde_json::{json, Value};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    pub command: String,
    #[serde(default)]
    pub args: Value,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Query {
    start_date: Option<i64>,
    end_date: Option<i64>,
    app_type: Option<String>,
    provider_name: Option<String>,
    model: Option<String>,
}

fn validate_query(query: &Query) -> Result<(), AppError> {
    if query
        .start_date
        .zip(query.end_date)
        .is_some_and(|(start, end)| start > end)
        || [query.start_date, query.end_date]
            .into_iter()
            .flatten()
            .any(|date| !(0..=253_402_300_799).contains(&date))
        || query.app_type.as_deref().is_some_and(|source| {
            !matches!(
                source,
                "workbuddy"
                    | "openclaw"
                    | "codex"
                    | "claude"
                    | "gemini"
                    | "pi"
                    | "opencode"
                    | "kilo"
                    | "qwen"
            )
        })
        || [&query.model, &query.provider_name]
            .into_iter()
            .flatten()
            .any(|value| value.len() > 256 || value.contains('\0'))
    {
        return Err(AppError::Config("Invalid usage filter".into()));
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LogsQuery {
    #[serde(default)]
    filters: LogFilters,
    #[serde(default)]
    page: u32,
    #[serde(default = "default_page_size")]
    page_size: u32,
}
fn default_page_size() -> u32 {
    20
}

pub fn dispatch(db: &Database, roots: &SourceRoots, request: Request) -> Result<Value, AppError> {
    let args = if request.args.is_null() {
        json!({})
    } else {
        request.args
    };
    let mut value = match request.command.as_str() {
        "sync_session_usage" => serde_json::to_value(session_usage::sync_all_unlocked(db, roots)?)?,
        "get_source_status" => serde_json::to_value(session_usage::statuses(db)?)?,
        "get_session_usage_last_sync" => json!(session_usage::statuses(db)?
            .iter()
            .map(|s| s.last_scan_at)
            .max()),
        "get_usage_summary"
        | "get_usage_summary_by_app"
        | "get_usage_trends"
        | "get_model_stats"
        | "get_provider_stats" => {
            let q: Query = serde_json::from_value(args)?;
            validate_query(&q)?;
            let (start, end, app, provider, model) = (
                q.start_date,
                q.end_date,
                q.app_type.as_deref(),
                q.provider_name.as_deref(),
                q.model.as_deref(),
            );
            let mut output = match request.command.as_str() {
                "get_usage_summary" => {
                    serde_json::to_value(db.get_usage_summary(start, end, app, provider, model)?)?
                }
                "get_usage_summary_by_app" => {
                    serde_json::to_value(db.get_usage_summary_by_app(start, end, provider, model)?)?
                }
                "get_usage_trends" => {
                    serde_json::to_value(db.get_daily_trends(start, end, app, provider, model)?)?
                }
                "get_model_stats" => {
                    serde_json::to_value(db.get_model_stats(start, end, app, provider, model)?)?
                }
                _ => {
                    serde_json::to_value(db.get_provider_stats(start, end, app, provider, model)?)?
                }
            };
            if request.command != "get_usage_summary_by_app"
                && q.app_type.as_deref().is_none_or(|source| source == "qwen")
                && db
                    .get_usage_summary(start, end, Some("qwen"), provider, model)?
                    .total_requests
                    > 0
            {
                mark_incomplete_input(&mut output);
            }
            output
        }
        "get_request_logs" => {
            let query: LogsQuery = serde_json::from_value(args)?;
            if query.page > 100_000 || !(1..=100).contains(&query.page_size) {
                return Err(AppError::Config("Invalid pagination".into()));
            }
            validate_query(&Query {
                start_date: query.filters.start_date,
                end_date: query.filters.end_date,
                app_type: query.filters.app_type.clone(),
                provider_name: query.filters.provider_name.clone(),
                model: query.filters.model.clone(),
            })?;
            serde_json::to_value(db.get_request_logs(
                &query.filters,
                query.page,
                query.page_size,
            )?)?
        }
        "get_request_detail" => {
            let id = args["requestId"]
                .as_str()
                .filter(|id| id.len() == 64 && id.bytes().all(|byte| byte.is_ascii_hexdigit()))
                .ok_or_else(|| AppError::Config("Invalid request identity".into()))?;
            let mut detail = serde_json::to_value(db.get_request_detail(id)?)?;
            if let Some(object) = detail.as_object_mut() {
                use crate::database::lock_conn;
                let conn = lock_conn!(db.conn);
                let (execution, actor): (String, String) = conn.query_row(
                    "SELECT execution_kind,actor_kind FROM proxy_request_logs WHERE request_id=?1",
                    [id],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )?;
                object.insert("executionKind".into(), json!(execution));
                object.insert("actorKind".into(), json!(actor));
                object.insert("measurement".into(), json!("reported"));
            }
            detail
        }
        _ => {
            return Err(AppError::Config(
                "Command is not available in this read-only statistics application".into(),
            ))
        }
    };
    // No pricing or billing authority has been connected. SQL compatibility zeros must never become money claims.
    mark_source_limits(&mut value);
    hide_unavailable_metrics(&mut value);
    Ok(value)
}

fn mark_incomplete_input(value: &mut Value) {
    match value {
        Value::Array(values) => values.iter_mut().for_each(mark_incomplete_input),
        Value::Object(object) => {
            if object.contains_key("inputTokens") || object.contains_key("totalInputTokens") {
                object.insert("inputBreakdownComplete".into(), json!(false));
            }
            object.values_mut().for_each(mark_incomplete_input);
        }
        _ => (),
    }
}

fn mark_source_limits(value: &mut Value) {
    match value {
        Value::Array(values) => values.iter_mut().for_each(mark_source_limits),
        Value::Object(object) => {
            if object.get("appType").is_some_and(|source| source == "qwen") {
                object.values_mut().for_each(mark_incomplete_input);
                if object.contains_key("inputTokens") {
                    object.insert("inputBreakdownComplete".into(), json!(false));
                }
            }
            object.values_mut().for_each(mark_source_limits);
        }
        _ => (),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn call(command: &str, args: Value) -> Result<Value, AppError> {
        let temp = tempfile::tempdir().unwrap();
        dispatch(
            &Database::memory().unwrap(),
            &SourceRoots::from_home(temp.path()),
            Request {
                command: command.into(),
                args,
            },
        )
    }
    #[test]
    fn only_statistics_commands_are_exposed() {
        for command in [
            "set_provider",
            "enable_proxy",
            "install_update",
            "delete_session",
            "read_file",
            "execute_sql",
        ] {
            assert!(call(command, json!({})).is_err());
        }
    }
    #[test]
    fn filters_are_bounded_and_unknown_parameters_rejected() {
        for args in [
            json!({"startDate":2,"endDate":1}),
            json!({"startDate":-1}),
            json!({"appType":"other"}),
            json!({"path":"private"}),
            json!({"startDate":i64::MAX}),
        ] {
            assert!(call("get_usage_summary", args).is_err());
        }
        for args in [
            json!({"pageSize":0}),
            json!({"pageSize":101}),
            json!({"page":-1}),
        ] {
            assert!(call("get_request_logs", args).is_err());
        }
        assert!(call("get_request_detail", json!({"requestId":"../private"})).is_err());
    }
    #[test]
    fn money_and_performance_remain_unknown() {
        let value = call("get_usage_summary", json!({})).unwrap();
        assert!(value["totalCost"].is_null());
        assert!(value["successRate"].is_null());
        assert_eq!(
            call("get_usage_trends", json!({"startDate":0})).unwrap(),
            json!([])
        );
    }
    #[test]
    fn source_tool_directories_cannot_be_used_for_storage() {
        let temp = tempfile::tempdir().unwrap();
        for name in [
            ".workbuddy",
            ".openclaw",
            ".cc-switch",
            ".codex",
            ".claude",
            ".gemini",
            ".pi",
        ] {
            let dir = temp.path().join(name);
            assert!(Database::open(&dir).is_err());
            assert!(!dir.exists());
        }
    }
}

fn hide_unavailable_metrics(value: &mut Value) {
    match value {
        Value::Array(values) => values.iter_mut().for_each(hide_unavailable_metrics),
        Value::Object(object) => {
            for (key, value) in object {
                if matches!(
                    key.as_str(),
                    "totalCost"
                        | "avgCostPerRequest"
                        | "totalCostUsd"
                        | "inputCostUsd"
                        | "outputCostUsd"
                        | "cacheReadCostUsd"
                        | "cacheCreationCostUsd"
                        | "successRate"
                        | "avgLatencyMs"
                        | "latencyMs"
                ) {
                    *value = Value::Null;
                } else {
                    hide_unavailable_metrics(value);
                }
            }
        }
        _ => (),
    }
}
