# 参与贡献

## 提交前检查（CI 同口径）

```bash
npm install && cd server && npm install && cd ..   # 双包依赖
npm run check    # lint + typecheck + 前端/server 全部测试
```

push / PR 会触发 [CI](.github/workflows/ci.yml) 执行同样检查与构建冒烟；请先本地跑通。

- 环境要求：Node.js 22.19+（22.x）或 24.x LTS（见 [docs/development.md](docs/development.md)）。
- lint 违规已清零，新代码保持 0 error；2 处已知 `react-hooks/exhaustive-deps` warning 见 [docs/testing.md](docs/testing.md)。
- 格式：prettier 渐进采纳（`.prettierrc.json`），不做全仓一次性 format；新文件建议 `npx prettier --write <file>`。

## 分层改动约定

| 改动面 | 必读 |
|--------|------|
| 数据层 / 同步引擎 / header 格式 | [docs/data-contract.md](docs/data-contract.md)（含不可破契约清单） |
| 新模块 / 架构问题 | [docs/architecture.md](docs/architecture.md) + 对应模块头注释 |
| 测试 | [docs/testing.md](docs/testing.md)（mock 模式 / round-trip 守护 / ABI 注意） |
| 打包 / 运维脚本 | [docs/operations.md](docs/operations.md)（发布不可变约束 / 脚本风险分级） |

## 硬性红线

1. **零飞书 token**：不引入任何飞书 token/app_id/app_secret；飞书访问一律经 lark-cli user 认证态。
2. **不提交真实凭据**：config.json / apiKey 不入库（明文存储是运行时已知决策，见 data-contract）。
3. **前端改动需真机交互验证**：浏览器/Electron 实测，不能只靠 API/单元测试。
4. **不改发布身份**：appId / 产物命名 / 更新 feed 保持现状（历史安装包兼容）。
5. **原生模块**：改 better-sqlite3 相关依赖后注意 ABI 切换（`npm rebuild`，见 docs/development.md）。

## 提交与发布

- 提交信息用中文简洁描述动机（参考 `git log` 风格）。
- 发布：合入 main → CHANGELOG 归档 → `npm version` → 打 `v*` 标签 → release workflow 自动构建发布。不发版不打包 tag。
- 版本号与 CHANGELOG 顶部条目必须同步（历史一直如此保持）。
