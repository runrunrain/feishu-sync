# 整理前验证记录

基线：8e35146，v0.3.47；Node v24.21.0，macOS；2026-10-26。仅本地验证，未访问飞书或读取用户配置。

| 验证 | 结果 | 证据 |
|---|---|---|
| `npm run typecheck --prefix server` | PASS | bg-10bb448f 命令第一步成功 |
| `npm test --prefix server` | FAIL | 42/43 文件完成，565/614 测试通过，1 worker 原生崩溃；不计为全绿 |
| `./node_modules/.bin/tsc --noEmit -p tsconfig.json` | PASS | bg-6bf131ae，exit 0 |
| `npm run build:all` | PASS | bg-6bf131ae，exit 0 |
| `npm run electron:build` | PASS | bg-6bf131ae，exit 0；未执行 Electron native rebuild |

原生错误：`node::RemoveEnvironmentCleanupHook` 断言 `(env) != nullptr`，堆栈含 `better_sqlite3.node` 的 `Statement::~Statement()`。其余 SQLite 测试通过；与典型 ABI mismatch 不同。已交 G1 诊断，禁止忽略 unhandled error。

日志显示部分现有测试尝试向默认 `~/.feishu-sync/sync-errors.log` 追加错误，均报 ENOENT；治理需设置隔离 FEISHU_SYNC_HOME，避免测试依赖用户目录。

本机完整日志（非仓库内长期依赖）：
- `/Users/run.mao/.pi/agent/amagi/data/run-bg/bg-10bb448f.log`
- `/Users/run.mao/.pi/agent/amagi/data/run-bg/bg-6bf131ae.log`

本记录只说明整理前状态，不代替治理后的验收。
