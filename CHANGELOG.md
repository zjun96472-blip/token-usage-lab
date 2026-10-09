# 更新记录

## v0.1.0-beta.1

首个公开测试版，应用内部版本为 0.1.0。

- 公开源码、中文安装说明及 GitHub Releases 下载入口。
- 提供 Mac Apple Silicon、Mac Intel 和 Windows x64 安装文件。
- 接入 WorkBuddy、Codex、Claude Code、OpenClaw、Gemini CLI、Pi、OpenCode、Kilo Code、Qwen Code 九个本地采集器。
- 支持总量、输入输出、缓存、趋势、日期、模型和来源筛选，以及调用明细与采集状态。
- 处理增量、重复记录和缓存口径，缺数据保持未知或未覆盖。

### 限制

- 安装文件复用此前验收版本，应用版本不是 0.1.0-beta.1；发布标签用于标识本次分发。各文件来源见 Release 的 `PROVENANCE.json`。
- Mac 只有原生 CI 启动验证，真实工具日志仍需实机验收；Windows 实测仅覆盖开发机，其他设备未验收。
- 六个新来源仍主要是合成测试覆盖，不承诺全部工具或全部调用完整统计。
- 没有实际账单、可靠参考费用、云端汇总、自定义目录界面或应用内自动更新。
- Mac 没有 Developer ID 签名或公证，Windows 未数字签名。
