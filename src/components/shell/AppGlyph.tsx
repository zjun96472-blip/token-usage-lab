import { Bot, Terminal } from "lucide-react";
import type { AppId } from "@/lib/api";
export const APP_DISPLAY_NAME: Record<AppId, string> = {
  workbuddy: "WorkBuddy",
  openclaw: "OpenClaw",
  claude: "Claude Code",
  "claude-desktop": "Claude Desktop",
  codex: "Codex",
  gemini: "Gemini CLI",
  grokbuild: "Grok",
  opencode: "OpenCode",
  kilo: "Kilo Code",
  qwen: "Qwen Code",
  hermes: "Hermes",
  pi: "Pi",
  mcode: "MiniMax",
};
export function AppGlyph({
  app,
  size = 16,
}: {
  app: AppId;
  size?: number;
  badgeClassName?: string;
}) {
  const Icon = app === "workbuddy" ? Bot : Terminal;
  return <Icon size={size} aria-hidden="true" className="shrink-0" />;
}
