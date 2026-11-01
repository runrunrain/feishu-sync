# 集成验收待核对（不是已确认最终finding）

以下基于实施中现场观察，完整主链回流后必须重读确认；不要把旧观察直接当最终缺陷。

- `routes/kb.ts`安装sourceDir校验曾用`startsWith('/')`，会拒绝Windows盘符/UNC路径。应使用跨平台路径判定，与安装器规范保持一致。
- 设计§5.4“Leader经工具报告无法完成”：现Leader8工具中未见显式无法完成/中止工具，监督器却支持leader_abandoned。核对是否有真实工具事件可达该终局，不能只靠文本或模拟事件；若无，补最小Leader专属只登记诊断的工具/参数路径。
- 真probe测试当前允许两个documented codemode fail而测试本身通过；这是复现缺陷阶段的诚实断言，不是最终合规。child-policy回流后必须要求这些项pass、probe exit0，不再容忍旧的已知失败。
- 真实probe独立审查角色已派发并读草稿，但能力脚本不等于语义审查/候选发布成功；§13.2须以主链真实API成功路径+真实审查回执为证。
- 实施中executeLeaderPublishRequest曾硬写programChecks passed却未先validateStaging；已回派修正。最终复核源快照/媒体hash/毒化/身份归属/取消代次/精确revision与完整知识校验，不能只检查canPublish或存在review文件。
- confirmed candidate（手动发布）接受后工具发布窗口释放与Leader退出间不得再写；最终验证需要真实并发写入/取消用例。
- 回流UI第三轮已接summary/termination/artifact/运行包status/install，但真实成功构建动态浏览器尚未验收。
- 真实模型API与六源同条件性能对照未跑，不能据fixture给出质量/20分钟达标结论。9e6825dc只读核查原六源夹具可得性，全部实际试验使用临时状态。
- child-policy 的缺失/篡改fail-closed必须观察真实child模型请求是否发生，不能只测生成器抛错；若Pi将缺失settings.extensions仅当warning，需补实际派发前核验，不能把“安装时文件在”冒充后续派发安全。
- pending身份真实MCP缓存竞态：GET tools早于native创建事件时只列读工具，后续confirmed+分配后写工具是否能被同一已连接MCP客户端重新发现？需真实延迟创建事件用例验证，不能只单测两次HTTP list；桥若无list_changed或helper不刷新，可能永久缓存只读面（安全仍拒写，但可用性受损）。
- main技能曾物化在被整个禁止的outputRoot/.builds内，已要求移到build home独立skills目录（允许read，不授写）。实际child读正文与Leader真实system marker都要验，不只检查配置/description。
- main发布后取消的后置判断须尊重CURRENT已提交真相：不能指针已切后把状态伪装cancelled，也不得回滚/删除current release；按原标准库指针对账契约验收。
- 初始用户diff应保留。8个无关文件逐一hash与dirty-snapshot一致；R/E提交只含本次代码，扩展原maxTokens改动仍未提交。T/I共享文件的原声明读取与修订保护是既存改动，最终暂存须明确其依赖与归属，不得悄悄纳入无关模型/预览改动。
