# 开发与构建

接收者直接使用 Releases 的安装文件，本页仅供开发者使用。

## 环境

- Node.js 22，pnpm 10.12.3，通过 Corepack 使用锁定版本。
- Rust 1.89.0；使用 `Cargo.lock`，不要绕过锁文件更新依赖。
- Windows：MSVC 工具链、Visual Studio C++ Build Tools、WebView2 Runtime。
- Mac：Xcode Command Line Tools。原生架构构建优先。
- Linux：默认 Rust 库测试不需要桌面依赖；构建桌面需另外安装 Tauri 对应系统库。本项目没有已验收的 Linux 安装包。

```sh
corepack enable
corepack prepare pnpm@10.12.3 --activate
pnpm install --frozen-lockfile
rustup toolchain install 1.89.0 --profile minimal
rustup override set 1.89.0
```

## 测试和桌面开发

```sh
node scripts/check-source.mjs
node --test scripts/tests/*.test.mjs
pnpm typecheck
pnpm test:unit
cargo test --locked --manifest-path src-tauri/Cargo.toml --lib
pnpm dev:desktop
```

开发版仍会读取当前用户的默认工具目录。需要隔离数据时，使用下述 CLI 测试入口和合成样本，不要把真实日志提交到仓库。

## 本机浏览器预览

```sh
cargo build --locked --manifest-path src-tauri/Cargo.toml --features cli --bin usage-lab-cli
pnpm build:renderer
pnpm preview
```

预览默认只监听 `127.0.0.1:18462`，通过固定本机桥接调用 Rust CLI，不是公网统计服务。CLI 可执行路径由 `USAGE_LAB_CLI` 显式指定；CLI 的 `--home`、`--data-dir` 以及桥接的 `USAGE_LAB_HOME`、`USAGE_LAB_DATA_DIR` 可用于受控的隔离测试。开发环境 `pnpm dev` 包含热更新，不用于最终用户交付。

## Mac 安装包

```sh
bash scripts/build-macos.sh aarch64-apple-darwin
node scripts/package-macos.mjs aarch64-apple-darwin
```

Intel 原生机器改为 `x86_64-apple-darwin`。脚本执行依赖检查、测试、第三方许可证生成、Tauri app/DMG 构建及最终 DMG 启动验收，输出到 `release/macos`。生成物不进入 Git。

macOS 工作流仅手动触发，两个标准 runner 顺序运行，每个任务最多 35 分钟。上传的 artifact 保留 7 天，**不是用户的长期下载地址**；用户下载入口是经检查后发布的 Releases。

## Windows 程序

在具备原生工具链的 Windows 开发机运行：

```sh
pnpm exec tauri build --ci --features desktop --no-bundle -- --locked
```

程序输出在 `src-tauri/target/release/token-usage-lab.exe`。这只是开发构建，不自动代表已完成分发许可证、文件清单和独立启动验收。

可选的 `scripts/build-windows.ps1` 使用固定摘要的 Docker cargo-xwin 镜像交叉编译，需要已安装 Docker；仅用于开发和本项目候选验证，不为最终用户安装 Docker。

## 发布边界

参见 [发布流程](RELEASING.md)。不得关闭系统安全策略来让测试通过；不能把 CI 成功等同于真实工具日志、所有系统版本或签名公证通过。

## Windows EXE 安装器

手动运行 `Build Windows Installer` 工作流，使用标准 Windows runner 的 Tauri NSIS 打包器。默认当前用户安装；没有签名、自动更新或自定义安装钩子。

首个安装器复用 beta.1 中已验收的程序，先固定校验公开 ZIP、来源记录、程序哈希和全部 64 份运行时源码，再生成安装包。任一运行时源码变化都会拒绝复用，必须先重新构建并验收程序，不能只改哈希跳过检查。

工作流在一次性 Windows 环境检查安装、开始菜单入口、原生启动及重启、重复安装、卸载和数据保留，然后上传候选文件。`verify-windows-installer.ps1` 拒绝在普通用户环境执行，避免影响维护者的实际安装和账本。

这一步是对旧程序的可追溯重新包装，不是应用重新编译。来源与验证记录随安装器分发，旧版便携包和 Mac 包不修改。
