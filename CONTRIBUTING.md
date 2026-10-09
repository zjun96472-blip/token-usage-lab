# 贡献指南

本项目优先保证统计口径可信、原工具不受影响和用户数据不外泄。

## 开发流程

从最新 `canonical` 创建独立的 `codex/` 功能分支，使用干净的独立工作区；同一工作区只允许一个写入者。不要重置、清理或提交他人的未完成改动。修改经过测试和审查后再合入 `canonical`；推送代码不等于发布安装包。

开发环境和验证命令见 [BUILDING.md](docs/BUILDING.md)。所有文本严格使用 UTF-8 无 BOM，每个实际源码文件最多 3000 行。

## 新增采集器

1. 提供可核验的结构化日志格式依据和版本范围。
2. 明确调用身份、输入输出、缓存包含关系、缺字段及修订规则。
3. 先添加合成样本和独立预期值，覆盖重复扫描、追加、复制、重启、不完整末行及错误隔离。
4. 缺少可信字段时标记不支持或未知，不根据相似品牌或当前版本猜测历史格式。
5. 更新覆盖清单；合成测试通过不能标成真实设备验收。

不要提交真实聊天、原始日志、数据库、账号信息、密钥或付费调用结果。需要真实样本时，先确认授权并在本机最小化处理，不上传全文。CI 仅使用合成数据。

## 提交前检查

```sh
node scripts/check-source.mjs
node --test scripts/tests/*.test.mjs
pnpm typecheck
pnpm test:unit
cargo test --locked --manifest-path src-tauri/Cargo.toml --lib
pnpm build:renderer
```

发布文件变更还要验证文件白名单、校验值、架构和对应平台的实际启动；打包成功不等于验收通过。许可证、来源和已知限制必须保留。

源码清单以已暂存的文件集合为边界。提交前先只暂存自己的修改，再运行 `node scripts/audit-public-source.mjs --write-manifest`，审查并暂存 `BUILD-SOURCE.json`；CI 会拒绝与清单不一致的源码。这个检查不能代替人工隐私审查。
