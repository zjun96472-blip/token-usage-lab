export const SOURCE_NAMES = {
  workbuddy: "WorkBuddy",
  openclaw: "OpenClaw",
  codex: "Codex",
  claude: "Claude Code",
  gemini: "Gemini CLI",
  pi: "Pi",
  opencode: "OpenCode",
  kilo: "Kilo Code",
  qwen: "Qwen Code",
} as const;
export type SourceId = keyof typeof SOURCE_NAMES;
export const SOURCE_IDS = Object.keys(SOURCE_NAMES) as SourceId[];
export const SOURCE_PATHS: Record<SourceId, string> = {
  workbuddy: "~/.workbuddy/projects",
  openclaw: "~/.openclaw/agents/*/sessions",
  codex: "~/.codex/sessions + archived_sessions",
  claude: "~/.claude/projects (含 subagents)",
  gemini: "~/.gemini/tmp/*/chats/session-*.json(l)",
  pi: "~/.pi/agent/sessions",
  opencode: "~/.local/share/opencode/opencode.db",
  kilo: "~/.local/share/kilo/kilo.db",
  qwen: "~/.qwen/tmp/*/chats/*.jsonl",
};
export const FIXTURE_ONLY: SourceId[] = [
  "openclaw",
  "gemini",
  "pi",
  "opencode",
  "kilo",
  "qwen",
];
export const SOURCE_LIMITS: Partial<Record<SourceId, string>> = {
  opencode: "SQLite 消息记录；旧版 JSON 与自定义目录未覆盖",
  kilo: "新版 SQLite；旧版 VS Code 任务日志未覆盖",
  qwen: "JSONL；缓存写入未拆分，托管会话未覆盖",
};
export const PENDING_SOURCES = [
  {
    name: "Cline / Roo Code",
    route: "本地任务记录；旧版缓存口径有歧义",
    state: "尚未接入",
  },
  { name: "CodeBuddy", route: "独立会话格式待核实", state: "尚未接入" },
  { name: "Cursor", route: "官方用量导出 / API 待核实", state: "未接入" },
  {
    name: "Windsurf / Trae",
    route: "官方用量导出 / API 待核实",
    state: "未接入",
  },
  {
    name: "GitHub Copilot",
    route: "官方组织报表 / API 待核实",
    state: "未接入",
  },
  {
    name: "Continue / Aider",
    route: "本地日志 / 遥测格式待核实",
    state: "未接入",
  },
  {
    name: "ChatGPT / Claude 网页端",
    route: "未确认可用的逐调用 Token 数据源",
    state: "未覆盖",
  },
] as const;
export interface SourceStatus {
  source: SourceId;
  state: "missing" | "empty" | "ready" | "partial" | "error";
  filesScanned: number;
  observedRequests: number;
  imported: number;
  updated: number;
  skipped: number;
  malformed: number;
  unsupported: number;
  unmetered: number;
  deferredFiles: number;
  fileErrors: number;
  lastScanAt: number;
  validation: string;
}
export const STATE_NAMES = {
  missing: "未发现目录",
  empty: "暂无可计量记录",
  ready: "已采集",
  partial: "部分覆盖",
  error: "读取失败",
};
