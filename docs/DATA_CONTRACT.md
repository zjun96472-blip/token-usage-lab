# 采集与统计契约

## 数据流

```text
只读日志发现 -> 格式适配器 -> 规范化调用记录 -> 去重/upsert -> 独立 SQLite
                                                       |
                                  原有统计 SQL <- usage_request <- React 统计界面
```

桌面版通过 Tauri IPC 调用 dispatcher；开发浏览器通过固定 loopback 桥接启动同一 Rust CLI。后端没有模型请求、代理、配置写入、更新、上传或通用文件读取命令。

## WorkBuddy 格式 v1

已验证本机记录具备以下字段组合，缺少关键字段或相互冲突时标为“不支持”，不推算：

| 字段 | 用途 |
| --- | --- |
| `sessionId` | 会话身份，入库前哈希 |
| `providerData.messageId` | 单次调用稳定身份，不能用 conversationRequestId 替代 |
| `timestamp` | 日志事件时间 |
| `providerData.model` | 模型标识 |
| `providerData.usage.requests` | 必须为 1 |
| `usage.inputTokens/outputTokens/totalTokens` | 输入、输出、总量，要求总量等于输入加输出 |
| `usage.inputTokensDetails[0].cached_tokens` | 规范化缓存命中，数组必须只有一个计量项 |
| `message.usage` | 用于一致性校验，不增加调用或 Token |
| `rawUsage.prompt_cache_hit_tokens` | 与规范化缓存命中一致 |
| `rawUsage.prompt_cache_miss_tokens` | 与扣除缓存后的新增输入一致 |
| `rawUsage.prompt_tokens_details.cached_tokens` | 交叉校验缓存命中 |

样本原始包中的 `cache_read_input_tokens`、`cached_tokens` 是零填充别名，不能覆盖规范化缓存值。非零别名必须与规范化值一致。

本机样本的缓存写入为零。第一版只接受已验证的零写入格式；非零 WorkBuddy 缓存写入先标“不支持”，避免猜测其包含关系。OpenClaw 的非零缓存写入另有独立格式和测试。

输出中的 reasoning token 已包含在 outputTokens，不重复增加。积分字段完全忽略。

## OpenClaw 格式 v1

沿用 `agents/<agent>/sessions/*.jsonl` 目录结构。session 头的 `id` 提供会话身份；assistant message 的行级 `id` 区分多次调用。身份包含来源、会话和消息，复制路径不影响去重。

接受 Pi 规范化的 `usage.input/output/cacheRead/cacheWrite` 四个非负整数。input 不包含缓存；若有 totalTokens，必须等于四项之和。toolResult 不额外记为模型调用。明确提供模型、用量的 compaction/branch_summary 使用其自己的稳定行 ID。

缺会话头、模型、稳定消息 ID 或计数，不以文件名或对话正文猜测。真实 OpenClaw 默认目录在本机未发现，当前只有合成样本验证。

## Codex / Claude Code / Gemini CLI / Pi

- Codex：`session_meta.payload.id` 是线程身份，不能用可能指向父任务的 `session_id`。读取 `turn_context.model` 和 `event_msg/token_count` 的累计快照；累计增量必须与 `last_token_usage` 一致才接受。重复快照、空限额刷新、`token_usage_record` 镜像不增加用量。初始快照大于最后一次调用、计数回退、缺模型、缓存关系矛盾均不推算。计数回退建立新基线；后续明确增量可继续采集。
- Codex 输入包含缓存命中，reasoning 包含在输出内。只有已确认的零缓存写入格式可用。带明确 fork/subagent 标记的记录，以子线程创建时间之前的快照作为基线而不重复入账；缺创建时间无法确认继承边界时不计入。未标记的外部历史拼接不保证可识别。
- Codex 游标持久化哈希线程 ID、模型标签、上一累计计数和重置标记，不保存正文或原始 payload。损坏或超大记录会使模型上下文失效，防止错归到上一个模型。
- Claude Code：仅 assistant 记录；主键使用来源、sessionId、`message.id`，不是流式片段 `uuid`。`input_tokens`、`output_tokens`、`cache_read_input_tokens`、`cache_creation_input_tokens` 四项互斥且必须明确存在。缓存 TTL 子项只交叉校验，不另加。`<synthetic>` 非模型消息跳过；`isSidechain` 标记子代理，发起人仍未归因。
- Gemini CLI：支持 JSON 会话文档和 JSONL 元数据/消息/`$set.messages`。以 sessionId 和消息 id 去重；rewind 不撤销已发生的历史用量。input 包含 cached，output 与 thoughts 相加；total 必须一致，非零 tool 计数暂不支持。只接受计数齐全且包含关系明确的格式。
- Pi：使用与 OpenClaw 相同的 Pi 四项独立计数契约，但来源和身份命名空间独立，扫描 `~/.pi/agent/sessions`。

## 增量、更新与失败

### OpenCode / Kilo Code / Qwen Code

- OpenCode 与新版 Kilo：分别只读打开默认的 `opencode.db` 与 `kilo.db`。存在 `session_message` 时读取 V2，否则读取 V1 `message`；V2 同时兼容 `session_v2` 和新版共用 `session` 的布局，不叠加冻结的 V1 表。只接受已完成 assistant 和带明确终态、用量的旧 V2 compaction，未完成记录延后。
- SQLite 的 `tokens.input` 不含缓存，`output` 不含 `reasoning`，四分类为 input、output + reasoning、cache.read、cache.write。必需计数缺失、溢出、负数或 total 不一致均不推算。消息 ID 和会话 ID 哈希去重；会话创建时间之前的复制历史标为不支持，避免 fork 换 ID 后重复入账。原历史缺失时不尝试重建这部分用量。
- SQLite 独立持久化 `time_updated` 修订水位。新修订可向下纠正旧计数，但调用日期使用原 `time.created`；旧数据库副本不能覆盖新修订。同一修订号的冲突仍按原有保守规则处理。
- SQLite 扫描考虑主库、WAL 和 journal 的大小及修改时间。只读事务读取可见的已提交快照，期间发生变化则整批延后；不执行 checkpoint、源库迁移或写 SQL，不复制源数据库或正文。SQLite 自身的 WAL 读锁使用共享内存协调，不等于修改业务数据。单库 2 GiB、单条 JSON 4 MiB、每库 250,000 行上限，超限显示读取失败。
- Qwen：只读 `tmp/<project>/chats/*.jsonl` 的 assistant `usageMetadata`。promptTokenCount 包含 cachedContentTokenCount。以 totalTokenCount 的等式确认 candidatesTokenCount 是否已经包含 thoughtsTokenCount，只在等式一致时采集。该格式不提供独立缓存写入桶，未命中的输入保留在 input；不据此推算缓存写入费用。非零 toolUsePromptTokenCount 或缓存写入扩展字段暂不支持。
- 包含 Qwen 记录的 API 汇总和明细附带 `inputBreakdownComplete=false`：规范化 input 是未拆分写入的非命中输入，write 的内部零值只是总量运算占位，不是已观测的零。界面将新增输入和缓存写入显示“未知”，总量、输出与缓存命中仍可统计。混合来源总览同样不能把未知拆分显示为完整已知。
- Qwen 的全局消息 `uuid` 在多层 branch 中保持不变，以来源与该逻辑 ID 去重；`forkedFrom.messageUuid` 必须与当前 uuid 一致。sessionId 可被分支改写，不能把它加入调用主键导致复制历史重复。显式 isSidechain 标为子代理，backgroundTurn 对象标为后台；实际发起人仍未归因。
- 三项均只有合成样本验收。Cline/Roo 的旧版缓存包含关系没有可靠版本区分，暂不入账；不会依据当前安装版本替历史记录猜口径。

### 共享规则

- 记录主键使用带长度前缀的 SHA-256，采用各来源的稳定调用身份；Qwen 的全局逻辑 UUID 是跨分支去重的例外。
- 每个 JSONL 文件保存已消费字节偏移、前缀哈希、解析器版本、修改时间和必要解析上下文。
- 追加只解析新增完整行；末行未换行则延后，重启后继续。
- 文件缩短、内容改写或适配器版本变化时重扫。文件复制、重扫仍按稳定调用身份 upsert。
- 事件时间较新的同 ID 记录替换旧计数，不相加。较旧版本不覆盖新版本。
- 同一事件时间只接受同模型、所有计数不下降的流式增长。较小的旧快照忽略；交叉冲突标不支持。
- 较新事件时间作为记录最新报告时间，日期汇总随之更新。没有独立 revision 时，不承诺识别同时间戳的向下修订。
- 已采集的历史调用不会因日志被删除、截短或源目录消失而删除。来源状态描述当前扫描覆盖，历史总量仍可查询。
- 一个文件失败不阻断其他文件；每个文件的记录和游标一起提交。
- 解析期间计算的前缀哈希必须与提交前重读一致，改写冲突回滚该文件事务。
- 跳过符号链接，JSONL 单文件上限 2 GiB，单行上限 4 MiB，JSON 文档上限 64 MiB，文件发现上限 20,000。达到限制显示失败或不支持，不伪装成完整覆盖。

已读完整、大小和高精度修改时间均未变化的 JSONL 文件不重读；变化文件仍校验已读前缀。主动保留相同大小和修改时间的外部改写不在自动发现保证内。JSON 文档每次完整解析并检查读取一致性。首次历史采集可能耗时较长，后续扫描不反复解析静态历史。

## 统计与隐私

常规来源存储的 input_tokens 已经是新增输入，语义标记为 FRESH；Qwen 保留未拆分写入的非命中输入，并通过上述不完整拆分标记防止误展示。所有汇总、模型/来源统计、趋势和详情使用相同的总量运算口径，前端不再次扣除缓存。日期使用设备本地时区。

成功率、延迟、参考费用没有权威数据，API 返回 null。实际账单未接入。空区间表示没有已采集记录，不代表实际使用量为零，也不保证覆盖率可量化。

只存来源、模型、时间、计数、哈希身份、采集状态和显式后台标记。设备当前用户是采集范围，不是实际发起人。缺少后台标记时任务类型为“未知”，发起人始终“未归因”。不保存聊天正文、工具入参、原始 JSON、积分或密钥。

原始日志只读打开。应用数据库独立；CLI 拒绝将账本目录放入 `.cc-switch`、`.workbuddy`、`.openclaw`、`.codex`、`.claude`、`.gemini`、`.pi`、`.qwen`、`opencode`、`kilo` 等已知来源目录。原版设置、供应商切换、自动代理和自动更新代码不在运行路径中。
