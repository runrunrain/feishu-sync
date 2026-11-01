# 构建 v2 真实 GLM 端点/密钥传递最小烟测报告（设计 §13.1 补充证据）

> 生成：`/tmp/feishu-build-v2-real-smoke/real-model-smoke.ts`（独立烟测脚本，不改生产基建/源码）。
> 复用真实 PiAmagiBuildRuntime + 真实 AgentToolService/BuildActorStore/桥接/转发扩展 + 真实 pi/amagi；唯一目标 = 真实模型通道与密钥传递证据。
> **不是 LLM 质量/性能基准，不构成 20 分钟实验目标或六源构建结论；fixture 负面断言面未在本轮覆盖。**

## 环境

- startedAt: 2026-11-01T11:27:07.190Z
- finishedAt: 2026-11-01T11:28:03.303Z
- model: glm-5.3-flash
- baseUrl: https://open.bigmodel.cn/api/coding/paas/v4
- piVersion: 1.4.0
- amagiVersion: 2.21.31
- tempRoot: /private/tmp/feishu-build-v2-real-smoke/run-mvxqwdrs
- 结果：**pass 17 / fail 0 / unavailable 0 / not-measured 0**
- 证据 JSON：/tmp/feishu-build-v2-real-smoke/evidence/real-model-smoke-mvxqxl2f.json

## 检查项

| ID | 检查 | 状态 | 结论与证据 |
|---|---|---|---|
| preflight-model | 真实模型解析（内存，无密钥输出） | **pass** | pi 1.4.0；amagi-pi 2.21.31；resolveProviderModel → glm-5.3-flash @ https://open.bigmodel.cn/api/coding/paas/v4（openai-completions；密钥长度 49，仅进 ZHIPU_API_KEY env） |
| package-install | 版本化 amagi-pi 安装 | **pass** | /private/tmp/feishu-build-v2-real-smoke/run-mvxqwdrs/feishu-home/agent/runtime-packages/amagi-pi@2.21.31/package（hash 9485dd95c004，fresh=true） |
| env-credential-hygiene | Leader env 凭据卫生（ZHIPU_API_KEY only，无 PI_* 凭据） | **pass** | envAuditIssues=0；ZHIPU_API_KEY 命中且与解析值一致（值不输出）；PI_CODING_AGENT_DIR=/private/tmp/feishu-build-v2-real-smoke/run-mvxqwdrs/feishu-home/agent/builds/b_mvxqwdrt_smoke1/home；HOME=/private/tmp/feishu-build-v2-real-smoke/run-mvxqwdrs/user-home |
| guard-extra-zones | 派发守卫禁区含真实凭据根/生产数据根 | **pass** | 冻结禁区 21 项，含 /Users/run.mao/.feishu-sync、~/.pi、~/.agents（原禁区全部保留，仅追加） |
| leader-start | 真实 Leader RPC 启动（真实 GLM） | **pass** | session=build-b_mvxqwdrt_smoke1 pid=89390；模型 zhipuai/glm-5.3-flash（端点 https://open.bigmodel.cn/api/coding/paas/v4） |
| leader-round1 | Leader 首轮完成（真实 GLM） | **pass** | outcome=completed；tokens in/out=510/124；thinking=- |
| leader-material-tool | Leader 真实调用材料工具 build_manifest | **pass** | 桥接审计：status=200（+6ms { "buildId": "b_mvxqwdrt_smoke1", "total": 2, "entries": [ { "objToken": "tok_probe_w1", "objType": "docx", "title": "Alpha 指南", "relPath": "probe/alpha-gu） |
| cancel-leader-exit | 取消：Leader 终止 | **pass** | exit={"code":0,"signal":null}；凭据撤销=true |
| cancel-no-residue | 取消：Leader/child/桥无残留进程 | **pass** | 相关进程全部退出 |
| old-token-revoked | 取消后旧代次凭据写入被拒 | **pass** | status=401 error=run_token_invalid（预期 401） |
| ledger-all-revoked | 代次轮换撤销全部身份 | **pass** | rotateGeneration(2) 后活跃身份=0 |
| single-task-cap | task_submit 恰好 1 个（上限防护在位） | **pass** | 登记任务=1；task_submit 尝试=1；无第二次尝试（防护未触发，上限仍在位） |
| child-mcp-list | child 经 mcp_list_tools 实际枚举桥接工具 | **pass** | 审计含 GET /tools（X-Amagi-Task-Id=6e9c0997…） |
| child-raw-read | child 经 mcp_call raw_read 实读 Alpha fixture（身份上行） | **pass** | status=200；X-Amagi-Agent=baize；任务已登记=true；返回摘要：+3ms <untrusted_source obj_token="tok_probe_w1" title="Alpha 指南"> # Alpha 指南 Alpha 系统有三条规则： - A1：入口在北方。 - A2：每轮刷新两个补给点。 - A3：雨天视野减半。 </untrusted_source> |
| child-report-content | child 回传真实内容要点（报告文件） | **pass** | agent-outputs/research-report.md 命中源短语 5/≥2（北方、补给点、雨天、视野、刷新两个） |
| completion-self-round | 后台完成通知触发 Leader 收尾轮 | **pass** | raw_read 后自触发轮 settled（共 1 轮） |
| leader-wrap-up | Leader 收尾总结（SMOKE-LEADER-DONE） | **pass** | 收尾文本含 SMOKE-LEADER-DONE 标记 |

## 复跑

```bash
cd /Users/run.mao/workpace/feishu-sync/server && node ../node_modules/tsx/dist/cli.mjs /tmp/feishu-build-v2-real-smoke/real-model-smoke.ts
# 前置：~/.feishu-sync/config.json 已配置启用的 GLM provider（密钥仅内存解析→ZHIPU_API_KEY env）。可选 --keep。
```
