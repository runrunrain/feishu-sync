# 单文档真实构建观察与定向优化

## 当前对象与边界
- 构建：b_20261105092329_e8471c，开始 2026-11-05T09:23:29Z。
- 已安装 commit b2b1447 / 桌面0.3.51；选定1个来源，119为全量快照。
- 本构建全过程未重启、取消、恢复或人工改写；不修改生产状态、冻结协议、知识正文、凭据。成功发布后确认构建/会话进程闲置，已安装通过验证的补丁；版本仍0.3.51，安装前后配置和CURRENT.json哈希一致。

## 阶段
| 阶段 | 责任 | 产物/验收 | 状态 |
|---|---|---|---|
| 现场初诊 | baize 867e71d7→1c8cc685 | initial-diagnosis.md v2：119是快照、1个工作集源；图片阶段归因已纠正 | v2 accepted，v1 rejected |
| 有界持续观察 | Leader | observations.jsonl；每30秒只读，10:14:51Z捕获published后退出 | completed |
| 小范围改进 | Leader直接处理：已定位的提示与日志，不改变发布/审查契约 | 桥接路径、审查工具面、元数据/声明互斥、问题清单参数说明；识图/缓存分段计时 | 60测试、typecheck/lint/server build/桌面打包通过；10:32Z已安装 |
| 汇总 | Leader | monitor-report.md、publish-verification.json、install-receipt.json；真实耗时51分10秒；未宣称补丁提速 | completed，下一次真实对照待用户测试 |

## 跨边界链路
UI用户触发→build service→冻结flow→task_submit→桥接读写→独立审查→阶段/最终发布。监控只读CLI与该构建会话文件；测试使用临时源/配置，生产日志只留短摘要不复制知识正文到仓库。

## 事实与决策
- 初诊看到首次 task_submit 的 required-input-missing：目标草稿路径只存在于应用桥接，不在子任务 cwd。
- seq9→seq10 约59.5秒同时包含 describeWorksetImages 和 includeRetainedImageCache；API计数 described=3/cached=0。不能认定全部缓存命中或59.5秒全部耗于缓存扫描，已回派纠错。先补分段观测，不做无证据的缓存扫描重构。
- 截至09:46Z模型轮次持续产生活动，尚无发布门禁阻断。长推理不等于进程挂死；不擅自改模型/思考强度。
- 09:44:33Z 首稿写入（写作约18.8分钟）；09:46:16Z 派审；09:57:19Z 审查 needs_revision（2 blocking、3 suggestion）。阻断包含源表计数不符与证据漏行，保持真实质量保护，不将其改为自动放行。
- 09:58:48Z 作者原会话续接开始定向修订；观察其能否收敛，不干预生产模型。新增参数误用已修正说明，但无真实模型对照样本，不宣称提速收益。
- 代码验证在既有隔离worktree进行，6个改动文件逐字节同步；主树/已安装SQLite保持Electron ABI125，测试树使用Node ABI137。并行性能调查文件不改、不提交。
