# P1-S1 lark-cli 实测 fixtures（2026-10-28，lark-cli 1.0.98，user 认证）

来源：P1-S1 探针（专用 Drive 文件夹自建自删，测试对象已全部删除）。租户域名/open_id/用户名已脱敏；
token 为已删除资源，仅保留结构对照。详细结论见 agent-outputs/workflow/2026-10-27-kb-agent-upgrade/P1-S1-probe.md。

- `fetch-no-refmap.json` — RP-3/RP-1：无评论（无可提取数据）时 reference_map 键缺失
- `fetch-refmap-comments.json` — RP-1：reference_map comments 组结构（ref=c1, .data=<comment> XML）
- `fetch-markdown-inline-cites.md` — RP-2：正文内联 cite/sheet 标签实际形态
- `docs-create-output.json` — PB-1/PB-2：docs +create 响应含 document_id + url
- `docs-create-fetch-title.md` — PB-1：--title 前置 <title> 行、正文 H1 保留
- `script-parse-profile.json` — PB-2：parse profile（word_count/char_count/block_count/blocks）
- `slides-screenshot-missing-scope.json` — SP-1：missing_scope 错误原文 + device flow hint
- `slides-create-output.json` — SP 前置：slides +create 输出（xml_presentation_id/slide_ids）
