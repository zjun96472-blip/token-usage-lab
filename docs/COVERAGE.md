# Cross-tool coverage

This is a local Windows/macOS desktop application with a browser development preview,
not a website that can automatically inspect every device or online account.
Both interfaces use the same native collector and isolated SQLite ledger.
The existing-log checks below were performed on Windows. macOS native CI
startup has passed for Apple Silicon and Intel, but real Mac tool logs remain
unverified. An installed adapter is not proof of real-device compatibility.

## Implemented adapters

| Tool | Discovery | Validation |
| --- | --- | --- |
| WorkBuddy | `.workbuddy/projects/**/*.jsonl` | Existing local logs |
| Codex CLI / IDE / Desktop | `.codex/sessions` and `archived_sessions` | Existing local logs; cumulative deltas |
| Claude Code | `.claude/projects/**/*.jsonl`, including subagents | Existing local logs; streaming deduplication |
| OpenClaw | `.openclaw/agents/*/sessions/*.jsonl` | Synthetic fixtures only |
| Gemini CLI | `.gemini/tmp/*/chats/session-*.json(l)` | Synthetic fixtures only |
| Pi | `.pi/agent/sessions/**/*.jsonl` | Synthetic fixtures only |
| OpenCode | `.local/share/opencode/opencode.db` | Synthetic fixtures; V1/V2 SQLite messages |
| Kilo Code | `.local/share/kilo/kilo.db` | Synthetic fixtures; modern SQLite only |
| Qwen Code | `.qwen/tmp/*/chats/*.jsonl` | Synthetic fixtures; local chat records only |

An implemented adapter does not mean complete coverage. Unsupported records,
missing counters, unreadable files and partial writes remain visible. None of
these counters proves a provider bill. Custom data directories, other OS users,
remote hosts and WSL homes are not automatically included.

## Not Yet Connected

| Tools | Candidate integration to verify |
| --- | --- |
| Cline, Roo Code | Historical `tokensIn` cache containment is not reliably versioned; task aggregates and subagent snapshots cannot be added as calls |
| Kilo legacy VS Code, OpenCode legacy JSON | Not equivalent to the supported modern SQLite layouts |
| CodeBuddy | Independent format; the WorkBuddy adapter must not be reused without evidence |
| Qwen managed sessions | Different storage/writer; not the supported local JSONL contract |
| Cursor, Windsurf, Trae | Vendor-supported usage exports or documented APIs, where available |
| GitHub Copilot | Authorized organization usage reports; request/credit metrics are not Token metrics |
| Continue, Aider | Opt-in telemetry or explicit local usage logs with stable call identities |
| ChatGPT, Claude web | No verified per-call Token source connected |

This list is a tracked subset of the market, not a claim to enumerate every AI
tool. A new brand name alone is not evidence that its format matches a related
product. Each adapter needs field contracts, stable identity, cache semantics,
failure reporting, fixtures and independent reconciliation before activation.

Pinned upstream contracts and exclusions for the latest batch are recorded in
[Adapter sources](ADAPTER_SOURCES.md). No real local samples were found for this
batch. Synthetic acceptance does not make these adapters device-verified.

## Broader Product Direction

1. Local adapters collect existing structured logs without changing the tool.
2. Explicit user imports can ingest official usage exports once their schema is
   verified. Raw exports must not be treated as a second copy of the same local
   event without an authority and deduplication rule.
3. Authorized vendor APIs can add account or organization usage. Credentials,
   consent and billing authority require a separate implementation and review.
4. An opt-in gateway may cover future compatible API calls, but cannot recover
   historical usage or intercept closed clients automatically. No gateway is
   enabled by this application.

When only credits, money, request quotas or text length are available, Token
usage stays unknown. Historical totals are never claimed to be 100% complete.
