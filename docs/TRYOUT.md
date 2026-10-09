# Token Usage Lab - Windows 内测试用

## 开始使用

1. 将 ZIP 完整解压到自己的文件夹，不要直接在压缩包里运行。
2. 双击 TokenUsageLab.exe。无需管理员权限，无需安装 Node.js、Rust 或其他开发工具。
3. 首次打开会扫描本机日志。日志较多时请等到底部“采集中”结束；之后每 60 秒更新，也可点击右上角刷新图标。
4. 在“采集状态”查看哪些来源找到日志、哪些只有部分覆盖。

此包面向 Windows 10/11 x64 内测。系统需要 Microsoft Edge WebView2 Runtime。
WebView2 官方下载：https://developer.microsoft.com/microsoft-edge/webview2/
使用 Evergreen Standalone Installer 的 x64 版本；公司电脑请交由 IT 安装。
本包不是 Mac 安装包，也未验收 Windows ARM64。

## 系统拦截或打不开

本内测程序尚未数字签名，也没有自动更新器。可能被 SmartScreen 或公司应用控制策略拦截。
不要关闭安全防护、绕过公司策略或以管理员方式强行运行。记录提示，让提供程序的人或 IT 核实文件校验值及发布者。
发送方应通过可信渠道提供 ZIP 及其 SHA-256；压缩包内 SHA256SUMS.txt 可检查解压后的文件是否发生变化，但不能替代发布者签名。
未完成其他独立电脑上的兼容性验收，本次试用就是为了收集真实环境反馈。

## 统计什么

已接入九个本地来源：WorkBuddy、Codex、Claude Code、OpenClaw、Gemini CLI、Pi、OpenCode、新版 Kilo Code、Qwen Code。
WorkBuddy、Codex、Claude Code 已用开发机真实日志验证。其余六项目前只有合成样本验证，界面标为“实机未验收”。
只读取当前 Windows 用户默认目录里的本地日志，不代表所有 AI 工具或全部用量。
自定义数据目录、其他系统用户、WSL、远程主机的日志不会自动纳入。
Cursor、Windsurf、Trae、GitHub Copilot、Cline、Roo、CodeBuddy、Continue、Aider 和网页聊天等尚未接入。
OpenCode 旧版 JSON、Kilo 旧版 VS Code 扩展日志和 Qwen 托管会话未覆盖。

“未发现目录”表示没有在默认位置找到日志，不表示消耗为零。
“部分覆盖”表示存在无法可靠计量的记录，不能把显示总量当作完整账单。
Token 来自日志报告值；不把积分换算成 Token，不根据聊天长度估算。
缓存不会重复加到总量里。参考费用未知，实际账单尚未接入。
后台任务的实际发起人未归因，不把电脑所有者直接当作所有调用的发起人。

## 数据和隐私

数据只保存在这台电脑，不上传、不云同步，不会把同事的使用量传回发送方。
程序不修改 AI 工具配置，不启用代理，也不读取原版 CC Switch 数据库。
程序会读取本地日志以提取计量字段，但账本不保存聊天正文、工具参数、密钥或原始日志。
默认数据位置：%LOCALAPPDATA%\TokenUsageLab
统计账本：token-usage-lab.sqlite3
程序文件可以移动，但同一 Windows 用户的统计账本不会随程序文件夹移动。
关闭程序后不会继续定时采集。它不自动开机启动、不常驻托盘。

## 更新和移除

更新：先退出旧版，解压并打开新版程序。不要同时运行多个副本。
移除程序：退出后删除解压文件夹即可，本地统计账本仍保留。
需要删除统计数据时，请先确认不需要保留，再处理上述数据目录；不要删除其他 AI 工具的日志或配置。

## 反馈问题

请提供程序版本、Windows 版本、CPU 架构、使用的工具及版本，以及出错操作。
可附“采集状态”和错误提示截图；涉及用户名、项目或模型名称等敏感内容请先遮挡。
不要发送聊天日志、API 密钥、配置文件或整个统计数据库。
本包是独立产品的内部测试候选，不是 CC Switch 官方发布版。

