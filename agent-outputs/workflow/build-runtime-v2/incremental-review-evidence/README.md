# 增量审核最小证据归档

本目录是 `/tmp/feishu-build-v2-incremental-review/` 中隔离复现脚本/小日志的原样副本，供临时目录清理后的回源；没有重新运行，也不是修复代码。完整结论见上一级 `incremental-review-report.md`，VERDICT仍FIX。

- family-lease：F03最终族授权竞争。
- resume：F09旧代次idle、F10缺termination绕过rebuild对账。
- residual：F10普通同组孤儿假confirmed、根失效后误信号（后者为安全注入记录）。
- publish-lease：F11 v1提交点拒租约后草稿删除。
- recursive-sentinel：F12真实child祖先grep越deny读取合成sentinel；报告/小日志保留，63KB原始JSON事件证据仍在原临时目录，没有在此复制。
- mcp-refresh：F02真实Pi MCP同连接迟到刷新正例。
- cleanup-forensics：ENOTEMPTY现场只读取证，未确认根因。

原样脚本仍引用 `/tmp/feishu-build-v2-feature-tree` 和本机外部Pi/amagi路径；执行前必须回读脚本并按当前隔离环境调整。OS复现只允许作用于当轮自己创建且归属可证的进程，不能直接信任历史PID文件；本目录没有复制历史orphan-pid，也不自动执行任何脚本。不读取生产资料/实际认证文件，不使用真实密钥。

上一级 `candidate-feature.patch` 是相对25cc0b4的冻结候选，仅供重建审核源码，**不是已通过的发布版本**；其中旧工作流进度以本目录上级现行报告为准。用户原12+2不在该patch。`SHA256SUMS`以仓库根为校验cwd。
