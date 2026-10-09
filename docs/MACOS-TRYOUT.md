# Token Usage Lab Mac 内部试用版

这是本地 Token 用量统计工具，不提供模型调用、配置切换或云端汇总。

## 安装与打开

- Apple 芯片电脑选择 apple-silicon 安装包；Intel 电脑选择 intel 安装包。
- 打开 DMG，将 Token Usage Lab 拖入 Applications，再从 Applications 打开。
- 无需安装 Node.js、Rust，也不需要打开开发网页。
- 构建目标为 macOS 12 及以上；CI 启动检查仅覆盖构建记录中的系统，不等于所有系统版本均已验证。

## 安全提示

此内部候选仅有 ad-hoc 签名，没有 Apple Developer ID 签名或公证。
通过网络下载后，Gatekeeper 可能阻止打开，不能保证双击即可运行。
请先核对随包 SHA256SUMS.txt；只对来源已确认且符合公司政策的应用，使用系统设置中的单个应用授权流程。
不要关闭 Gatekeeper、删除隔离属性、停用其他系统防护，或运行所谓的解锁脚本。
需要无需额外授权的正式分发版本时，必须先完成 Developer ID 签名和 Apple 公证。

## 数据与覆盖范围

所有采集和统计保存在当前用户本机，不发送到云端。
独立数据目录为 ~/Library/Application Support/TokenUsageLab。
不修改原工具配置，不启用代理，不记录聊天正文和密钥。

目前有 WorkBuddy、Codex、Claude Code、OpenClaw、Gemini CLI、Pi、OpenCode、Kilo、Qwen 九个采集器。
Mac 上这些工具的真实日志采集仍需实机验收；CI 的合成测试不代表已覆盖真实使用。
仅扫描当前用户默认目录，不含其他用户、远程设备或自定义路径。
未发现来源、格式不支持、缺少用量时显示未覆盖或未知，不代表没有消耗。
Token 来自日志，不等于实际账单；没有价格的地方不推算费用，不把积分换算成 Token。

## 试用反馈

请提供系统版本、芯片类型、工具名称和版本、采集状态，以及已遮盖个人信息的界面截图。
不要发送完整聊天日志、数据库、密钥或访问令牌。
卸载应用不会自动删除本机统计账本，也不会影响原工具。

应用和第三方许可证位于应用资源目录，并随交付文件一同提供。
