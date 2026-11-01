# MCP 桥接调用示例（Pi 子任务）

知识工具经 `mcp_call` 到达应用桥接（server 名见路由配置；`mcp_list_tools` 可列出当前身份可用的清单）。业务参数嵌套在 `arguments` 中——调用前先用 `mcp_list_tools` 核对参数结构。你的身份（任务 ID/角色）由环境自动附带，不要在参数里声明。

## 读取

```json
{"tool": "mcp_call", "arguments": {"server": "feishu-kb", "tool": "raw_read", "arguments": {"objToken": "<token>", "startLine": 1, "endLine": 120}}}
```

批量/搜索（先列清单确认参数）：`raw_list`、`raw_search`、`raw_links`。读取回执随返回携带；重要事实在声明中引用回执。

## 写正文与声明（仅写作身份）

```json
{"tool": "mcp_call", "arguments": {"server": "feishu-kb", "tool": "kb_write_doc", "arguments": {"path": "combat/actions.md", "markdown": "<!-- std: ... -->\n# 行动\n...", "summary": "回合次数、先手判定与怒气消耗", "sources": ["<token>"], "operationId": "op-write-actions-1"}}}
```

- 局部修改：按服务端返回的变更集/定位参数提交，不整篇重发。
- 对象迁移显式提交（迁移意图字段见工具清单），不删除重建。
- `operationId` 幂等键保持稳定：回执丢失时用同一 ID 重放。

## 审查（仅审查身份）

```json
{"tool": "mcp_call", "arguments": {"server": "feishu-kb", "tool": "kb_submit_review", "arguments": {"scopePaths": ["combat/actions.md"], "verdict": "needs_revision", "issues": [{"severity": "blocking", "path": "combat/actions.md", "description": "怒气消耗数值与来源表 3 不符（回执 rr_123）"}]}}}
```

## 常见错误

- 未分配目标写入 → 可重试错误：先完成阅读，确认分配后再写。
- 参数结构不符 → `mcp_list_tools` 核对后重试；同类错误连发时读结构化反馈，不盲试。
- 版本冲突 → 按返回的当前 revision 重读后重试，不覆盖。
