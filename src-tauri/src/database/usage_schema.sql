PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
BEGIN;
-- CC Switch's usage contract, without credentials or provider settings.
CREATE TABLE IF NOT EXISTS proxy_request_logs (
    request_id TEXT PRIMARY KEY, provider_id TEXT NOT NULL, app_type TEXT NOT NULL,
    model TEXT NOT NULL, request_model TEXT, pricing_model TEXT,
    input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL,
    cache_read_tokens INTEGER NOT NULL, cache_creation_tokens INTEGER NOT NULL,
    input_token_semantics INTEGER NOT NULL DEFAULT 2,
    input_cost_usd TEXT NOT NULL DEFAULT '', output_cost_usd TEXT NOT NULL DEFAULT '',
    cache_read_cost_usd TEXT NOT NULL DEFAULT '', cache_creation_cost_usd TEXT NOT NULL DEFAULT '',
    total_cost_usd TEXT NOT NULL DEFAULT '', cost_multiplier TEXT NOT NULL DEFAULT '1',
    latency_ms INTEGER NOT NULL DEFAULT 0, first_token_ms INTEGER, duration_ms INTEGER,
    status_code INTEGER NOT NULL DEFAULT 0, error_message TEXT, session_id TEXT,
    provider_type TEXT, is_streaming INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL, data_source TEXT NOT NULL,
    event_time_ms INTEGER NOT NULL, execution_kind TEXT NOT NULL DEFAULT 'unknown',
    actor_kind TEXT NOT NULL DEFAULT 'unattributed', agent_key TEXT,
    adapter_version INTEGER NOT NULL, measurement TEXT NOT NULL DEFAULT 'reported',
    device_scope TEXT NOT NULL DEFAULT 'local-os-user'
);
CREATE INDEX IF NOT EXISTS usage_created ON proxy_request_logs(created_at);
CREATE INDEX IF NOT EXISTS usage_source_model ON proxy_request_logs(app_type,model,created_at);
CREATE TABLE IF NOT EXISTS providers (
    id TEXT NOT NULL, app_type TEXT NOT NULL, name TEXT NOT NULL, PRIMARY KEY(id,app_type)
);
-- Preserved for upstream queries. No detail pruning or implicit backfill in this prototype.
CREATE TABLE IF NOT EXISTS usage_daily_rollups (
    date TEXT NOT NULL, app_type TEXT NOT NULL, provider_id TEXT NOT NULL, model TEXT NOT NULL,
    request_model TEXT NOT NULL DEFAULT '', pricing_model TEXT NOT NULL DEFAULT '',
    request_count INTEGER NOT NULL DEFAULT 0, success_count INTEGER NOT NULL DEFAULT 0,
    input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens INTEGER NOT NULL DEFAULT 0, cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
    input_token_semantics INTEGER NOT NULL DEFAULT 2, total_cost_usd TEXT NOT NULL DEFAULT '',
    avg_latency_ms INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(date,app_type,provider_id,model,request_model,pricing_model)
);
CREATE TABLE IF NOT EXISTS session_log_sync (
    file_key TEXT PRIMARY KEY, source TEXT NOT NULL, byte_offset INTEGER NOT NULL,
    prefix_hash TEXT NOT NULL, adapter_version INTEGER NOT NULL,
    session_key TEXT, malformed INTEGER NOT NULL DEFAULT 0,
    unsupported INTEGER NOT NULL DEFAULT 0, unmetered INTEGER NOT NULL DEFAULT 0,
    last_synced_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS lab_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS source_status (source TEXT PRIMARY KEY, value TEXT NOT NULL);
PRAGMA user_version = 1;
COMMIT;
