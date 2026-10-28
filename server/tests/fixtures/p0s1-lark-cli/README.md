# P0-S1 lark-cli 实测 fixtures（2026-10-28，lark-cli 1.0.98，user 认证）

来源：P0-S1 探针（专用测试文档自建自删，`feishu-sync-p0s1-probe` / `probe2`，测试对象已全部删除并经 fetch 3380003 验证）。
租户域名 / open_id / doc·whiteboard·block token / task_id / log_id / ticket 已脱敏为占位符（`DOCXTOKENPROBE1`、`WBTOKENPROBE1`、`ou_EDITOR_PROBE`、`task-uuid-probe-N`、`LOGIDPROBE`、`TICKETPROBEN` 等），结构与字段名保持原样。
`whiteboard-export-raw-nodes.json` 与 `whiteboard-min-sample.wb.svg` 为原始文件未脱敏（本体不含 token，已核对）。
详细结论见 agent-outputs/workflow/2026-10-27-kb-agent-upgrade/P0-S1-probe.md。

## history（docs +history-list / +history-revert / +history-revert-status）

- `history-list-fresh-doc.json` — HP-1：新建（import）文档即有 1 条建档历史（type=1）；`history_version_id` 为**字符串**（1024 步进）、`revision_id` 为数值、`edit_time` RFC3339Z、`editor_ids` 为 open_id 数组（无编辑者姓名字段）
- `history-list-after-append-lag.json` — HP-2/HP-4：append（rev→3）后立即 list，仅见 rev1/rev2 条目——**最新一次写的条目异步延迟出现**
- `history-list-multi-entry.json` — HP-2：4 条目全景，type 1=建档 / 2=普通编辑 / 3=revert 产生的新历史；条目按新→旧排序；`has_more`+`page_token` 恒存在
- `history-revert-done.json` — HP-2：`--wait-timeout-ms 30000` 同步完成形态 `{status:"done", task_id, poll_after_ms:0}`（done 仍返回 task_id）
- `history-revert-running.json` — HP-2：`--wait-timeout-ms 0` 异步形态 `{status:"running", task_id, poll_after_ms:10000}`
- `history-revert-status-done.json` — HP-2：轮询结果 `{status:"done", failed_block_tokens:[]}`（注意 `failed_block_tokens` 字段，非空=部分失败）
- `history-revert-error-10020.json` — HP-3：同文档并发 revert 被拒（服务端单飞门）
- `history-revert-error-3380002-notfound.json` — HP-3：不存在的 history_version_id → 3380002 INVALID ARGUMENT
- `history-revert-error-3380002-newest-entry.json` — HP-3：目标为**最新条目**时同样 3380002（最新条目被超越后才可作目标）
- `history-revert-error-local-validation.json` — HP-3：`0`/非正整数为 CLI 本地校验拦截（validation/invalid_argument）

## whiteboard（docs +update 插入 / whiteboard +export）

- `whiteboard-insert-newblocks.json` — HP-4：`docs +update --command append` 插入 `<whiteboard type="mermaid">` 的响应，`new_blocks[].block_token` 即画板 token（无需二次 fetch 解析）
- `whiteboard-export-svg-success.json` — HP-4：2 节点画板导出成功，响应字段为 `data.svg_path` + `size_bytes`（注意不是 `output_path`）
- `whiteboard-min-sample.wb.svg` — HP-4：真实 SVG 样本——标准 `<svg width height viewBox>` 头、文字为真实 `<text>/<tspan>` 节点（中文原文，非路径化字形）、连线为无语义 `<path>`+`<defs><marker>`、字体 Noto Sans SC
- `whiteboard-export-svg-timeout.json` — HP-4/HP-5：7 节点画板 svg 导出**稳定服务端超时**（~6.5s 返回 network/timeout，内容相关，非 scope、非客户端等待耗尽）
- `whiteboard-export-raw-nodes.json` — HP-4：raw 通道稳定可用；文字抽取路径：形状 `nodes[i].text.text`、连线标注 `nodes[i].connector.captions.data[j].text`
- `whiteboard-export-source.json` — HP-4：source 通道按 mermaid 源码往返（`data.code` + `syntax_type`），仅对源码派生画板有效
- `fetch-whiteboard-inline-restored.json` — 设计 §9 HP-7：revert 后 fetch 证实**内嵌白板块随正文整体恢复**（token 保留，mermaid 源内联在 `<whiteboard token=...>` 块中）

## drive 标题与生命周期

- `import-create-docx.json` — `drive +import --type docx` 建档响应（token/ticket/job_status）
- `update-title-success.json` — HP-6：成功响应 `{file_token, title, type, updated:true, url}`
- `inspect-after-rename.json` — HP-6：`drive +inspect` 证实标题已变
- `update-title-error-981003.json` — HP-6：类型错配（docx token 传 `--type sheet`）→ 981003 "not found." + CLI hint
- `update-title-error-empty-local.json` — HP-6：空标题为 CLI 本地拦截（hint：API 会接受并把标题清空）
- `fetch-revision-id-2.json` — 设计 §9 HP-3：`docs +fetch --revision-id <int>` 可读历史版正文（注意是 revision_id 数值空间，非 history_version_id）；不存在版本见 `fetch-revision-id-error-4000002.json`（4000002）
- `fetch-after-revert-restored.json` — HP-2：revert 到 rev2 快照后正文逐字节恢复 v1
- `delete-docx-response.json` / `fetch-deleted-3380003.json` — 清理与验证：delete 为异步任务（`task_id: "schedule|…"`）；已删文档 fetch → 3380003（inspect 元数据仍可短暂解析，属缓存）
