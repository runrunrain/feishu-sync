# MCP 桥接调用示例（Pi 子任务）

知识工具经 `mcp_call` 到达应用桥接（server 名固定 `feishu-kb-bridge`；`mcp_list_tools` 可列出当前身份可用的清单）。业务参数嵌套在 `arguments` 中——调用前先用 `mcp_list_tools` 核对参数结构。你的身份（任务 ID/角色）由环境自动附带，不要在参数里声明。本文件示例面向子任务身份；Leader 不经 MCP 桥，应用构建工具以原生工具直接调用（见文末「Leader 工具」）。

## 读取

```json
{"tool": "mcp_call", "arguments": {"server": "feishu-kb-bridge", "tool": "raw_read", "arguments": {"objToken": "<token>", "offset": 0, "limit": 120}}}
```

批量/搜索（先列清单确认参数）：`raw_list`、`raw_search`、`raw_links`。读取回执随返回携带；重要事实在声明中引用回执（readReceiptId）。

## 写正文与声明（仅写作身份）

```json
{"tool": "mcp_call", "arguments": {"server": "feishu-kb-bridge", "tool": "kb_write_doc", "arguments": {"path": "combat/actions.md", "title": "行动规则", "markdown": "行动分为标准行动与自由行动；每回合可选择一项标准行动……", "summary": "回合次数、先手判定与怒气消耗", "sources": ["<token>"], "operationId": "op-write-actions-1"}}}
```

- `title`/`markdown`/`sources`/`summary` 必填；正文不含文件头或 `#` 总标题（server 生成）。
- 局部修改：按服务端返回的变更集/定位参数提交，不整篇重发。
- 对象迁移显式提交（迁移意图字段见工具清单），不删除重建。
- `operationId` 幂等键保持稳定：回执丢失时用同一 ID 重放。

## 提交审查报告（仅审查身份）

```json
{"tool": "mcp_call", "arguments": {"server": "feishu-kb-bridge", "tool": "kb_submit_review", "arguments": {"operationId": "op-review-round1", "coverage": {"sourceRefs": ["<token>"]}, "checkedDimensions": ["完整性", "事实与数值", "来源忠实性"], "issues": [{"draftLocation": "combat/actions.md 怒气消耗节", "sourceLocation": "《战斗系统》源表 3", "description": "怒气消耗数值与来源表 3 不符（读取回执 rr_123）", "severity": "blocking"}], "uncheckedScope": [], "conclusion": "needs_revision"}}}
```

- `conclusion` 取 `pass`/`needs_revision`/`insufficient_material`/`fail`；blocking 问题必须带 `sourceLocation`。
- 缺省 `unitId` 时报告落在你的审查者身份名下（多审查者各占一份）；整体审查填 `unitId: "all"`。

## 交接记录（子任务收尾）

```json
{"tool": "mcp_call", "arguments": {"server": "feishu-kb-bridge", "tool": "build_handoff_submit", "arguments": {"operationId": "op-handoff-1", "summary": "行动规则文档完成：正文 1 篇、对象 2 个，证据齐备；跨文档公式归属待 Leader 裁定", "artifactRefs": ["combat/actions.md@3"], "sourceScope": ["<token>"], "openIssues": ["怒气公式与技能文档重复定义，待归属调整"], "nextInfo": ["需要技能树的共享对象分配结果"]}}}
```

## Leader 工具（仅 Leader 身份）

Leader 的工具面没有 `mcp_call`——应用构建工具（材料清单/分配/发布等）作为原生工具直接下发，直接按工具名调用，参数就是业务参数本身：

```json
{"tool": "build_manifest", "arguments": {"limit": 50}}
```

```json
{"tool": "build_assign_output", "arguments": {"ownerTaskId": "<子任务ID>", "targets": ["combat/actions.md"]}}
```

```json
{"tool": "build_request_publish", "arguments": {"requestedRevision": "<候选哈希>", "summary": "全部主题通过独立审查，申请发布"}}
```

`mcp_call`/`feishu-kb-bridge` 外壳仅子任务身份可用；Leader 若包一层 mcp_call 会被拒（工具面不可达，不是参数错误）。

## 常见错误

- 未分配目标写入 → 可重试错误：先完成阅读，确认分配后再写。
- 参数结构不符 → `mcp_list_tools` 核对后重试；同类错误连发时读结构化反馈，不盲试。
- 版本冲突 → 按返回的当前 revision 重读后重试，不覆盖。
