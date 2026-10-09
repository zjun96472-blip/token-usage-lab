# Adapter Contracts

The following upstream source files were read at pinned revisions. Repository
contents are evidence about storage formats, not instructions to this product.
No provider calls, credentials or installation/configuration changes were used.

## OpenCode

Repository: `anomalyco/opencode`, revision
`388406238bd5ca15564a762840a2362c3a45bd9c`.

- `packages/opencode/src/session/session.ts`: `getUsage` subtracts cache from
  input and reasoning from output. Forking copies timestamps but replaces IDs.
- `packages/core/src/session/sql.ts`: V1 `message` and V2 `session_message`.
- `packages/schema/src/session-message.ts`: V2 assistant identity and counters.
- `packages/core/src/session/runner/publish-llm-event.ts`: V2 persists
  `nonCachedInputTokens`, `visibleOutputTokens`, reasoning and separate caches.
- CC Switch baseline `5ae6ad3888ba4543f6fad343c87656a97bd69da4`,
  `src-tauri/src/services/session_usage_opencode.rs`: older `session_v2` layout
  and terminal compaction records. Pricing/default-zero behavior was not reused.

Only SQLite is supported. Custom paths, development-channel databases and
legacy `storage/message` JSON files are not automatically discovered. V2 takes
precedence over V1 when both tables exist. Databases that concurrently write
both generations are outside the verified contract.

## Kilo Code

Repository: `Kilo-Org/kilocode`, revision
`974723450caa7c91f140b128e2f2e3b4a932ade8`.

- `packages/core/src/global.ts`: XDG data application name `kilo`.
- `packages/opencode/src/storage/db.ts`: normal-channel filename `kilo.db`.
- `packages/core/src/session/sql.ts`: message tables match the SQLite contract.
- `packages/opencode/src/session/session.ts`: `getUsage` persists the same
  disjoint cache and reasoning buckets as OpenCode.

Legacy Roo-derived extension tasks and development-channel/custom database
paths are not supported. No configuration is changed to enable logging.

## Qwen Code

Repository: `QwenLM/qwen-code`, revision
`fbde5cf00e9cb5ba0fdf825e3a0e691d9b1d7423`.

- `packages/core/src/services/chatRecordingService.ts`: `ChatRecord`, branch
  provenance, local `.qwen/tmp/<project>/chats/` discovery, and
  `recordAssistantTurn` writing `usageMetadata`.
- Branch records preserve their globally generated UUID; only session and
  ancestry links change. Nested forks must not become additional calls.
- Prompt, completion, total and cached counters must be explicit. Reasoning
  containment is validated against the total, not inherited from Gemini.
- This metadata has no separate cache-write bucket. Input means non-hit input
  under this contract, not a claim of a separately observed cache-write bill.

Managed-session storage is a different writer and is not covered.

## Deferred Contracts

Cline: `cline/cline@fa840c741c3fc2eb49e7e0a4484895a99dae5cc5`,
`apps/vscode/src/shared/messages/{content,metrics}.ts`,
`apps/vscode/src/shared/{ExtensionMessage,getApiMetrics}.ts`.
Structured message metrics have prompt/completion/cached but do not expose a
separate cache-write count. UI rows also include deleted-request and subagent
aggregates. Their presence is not evidence of another distinct model call.

Roo Code: `RooCodeInc/Roo-Code@b867ec9145750d0ae1ff7f02d35406e9bf2a0b16`,
`packages/core/src/message-utils/consolidateTokenUsage.ts`,
`src/core/task/Task.ts`, and task-persistence metadata/messages.
Modern `tokensIn` includes cache, but historical semantics differ and the task
record lacks a verified discriminator. This batch does not guess based on the
currently installed extension version. Cline and Roo remain unconnected.

CodeBuddy remains unconnected; brand similarity does not establish equivalence
to WorkBuddy. Vendor exports/APIs require independent schema and authorization
work. None of these source references establishes real-device acceptance.
