# T4b 收口复审

**VERDICT: FIX**。原编号 01–10 中，**7 项 PASS，06/07 仍有 Major，08 功能链已修但真机交互验收证据未闭合**。不新增 finding 编号。

## 输入、基线与范围

必读输入均已读：同目录 `T4b-diting-final-review.md`（含复验归因、runner 全文）、`T4b-fixA-report.md`、`T4b-fixB-report.md`。上游报告的自称通过不代替本轮取证。

- cwd：`/Users/run.mao/workpace/feishu-sync`；本轮 `git rev-parse HEAD` = `6295b27d6642cfa3c4d611d7af6d8de7712a58f2`。
- 工作区是共享未提交树；已取 `git status --short`，包含原 Phase 4 新服务/测试及其他未提交内容。未冻结隔离快照，不对整个 diff 作全仓审计。
- 范围：按原十项复审、修复直接影响链、任务明确要求的 runUpdate 写后未知交叉裁定。不重开未改且无修复因果关系的历史观察。
- Leader 提供的 server 109 文件/1698 用例、前端 349、typecheck 全绿是**上游基线**，不是本轮全量重跑结果。

## 逐项裁决

| 原编号 | 裁决 | 当前代码、测试与独立反例证据 |
|---|---|---|
| **01** | **PASS** | `server/src/kb/publication-service.ts:852-856,982-986`：首次 await 前同步占准入、finally 按持有 release 释放。正式 `kb-publication-fixA.test.ts` 的 T4b-01 两例通过。独立改写原 runner：buildPlan 延时放大异步窗口，同路径两请求仅一 fulfilled、create=1。原双 create 反例关闭。 |
| **02** | **PASS** | `publication-service.ts:1153-1170`：每次 runUpdate 重新查时间；首遍/第二遍共用，变化或不可读落 conflict。正式 T4b-02 三例通过。重放原 A skip + B 创建时推进 A 时间：零 overwrite(A)，`OTHER USER CLOUD EDIT` 原样保留。正式用例还检查重新派生 `OVERWRITE_PUBLISHED`。 |
| **03** | **PASS** | `modules/config-manager.ts:938-940,1194-1202` 候选态保存前钩子；`kb/publication-service.ts:257-278` 完整祖先链校验；`index.ts:168-170` 实际注入；`routes/config.ts:312-318` 透传拒绝。正式 T4b-03 五例通过：真实临时 ConfigManager + Hono PUT 两方向拒绝且不落盘、不可读拒绝、直连 manager 拒绝、身份未变不重复解析。此结论限已接线应用入口，不泛化为任意未注入 hook 的嵌入方。 |
| **04** | **PASS** | `publication-service.ts:1173-1205`：取锚→先落 push_log→fetch revision→overwrite；无锚/日志落盘失败拒绝，force 不豁免。正式 T4b-04 三例通过。原空 history 反例重放：history 实际被读，overwrite=0，push_log=0，基线不被推进。 |
| **05** | **PASS** | `modules/local-map-store.ts:3440-3446` active 状态含 unknown；`sources/cloud-move-service.ts:563-653` 查询 task/node 后才解除；`routes/feishu.ts:882-886` 接线。原 timeout→unknown→二次移出重放：active 非空、第二次 `cloud_move_running`、move=1。正式 `cloud-move.test.ts:815-998` 覆盖编辑/放弃/写回/回滚门及核对分支，均通过。真实飞书核对输出形态仍属 S5 盲区。 |
| **06** | **未闭合｜Major** | create/revert/move 的 parse/incomplete_response 分类修复与原反例重放均通过；但 **runUpdate 的 overwrite 响应 parse 仍 failed 并允许普通重发；timeout 虽 unknown，第二遍仍会在同批重发**。详见下方 F06，任务要求的统一裁定不通过。 |
| **07** | **未闭合｜Major** | provider 现读取 current token ∪ previousCloudTokens，正常 update 保留谱系；原 A→force B 反例重放通过。但 `archivedTokens` 在 current token 为空时丢弃既有 previousCloudTokens；force create 失败再 force 成功后旧 A 再次退出排除集。详见 F07。 |
| **08** | **未闭合（验收证据）** | **原固定 body=null 的代码缺陷已修**：`SourceEditControls.tsx:113-141,343-353,589-603` handler 实际调用 fetch 并回填，只有失败才降级；`api/client.ts:1588` → `routes/feishu.ts:563` → `cloud-history-service.ts:fetchCloudRevision` 缺省 revision 为当前正文。正式前端 17 例、server 当前正文用例通过。但新增所谓“宿主级”测试实际直接调用导出 helper（`SourceEditControls.test.tsx:99-145`），并未挂载组件点击按钮。批 B 明确未做真机，本轮也未进行浏览器/Electron 点击；故不签发原要求的真实交互闭合，不把该证据缺口伪报为新代码 Major。 |
| **09** | **PASS** | `cloud-history-service.ts:618-620` 使用 `computeAnchorExactSeconds`，不再二次除 1000。正式 `cloud-history.test.ts:1075-1097` 早 1 秒/相等/不可读三例通过；原 runner 晚 1 秒反例重放，新日志 `anchorExact=false`。 |
| **10** | **PASS** | `cloud-history-service.ts:623-637,667-685,745-756,875-929` 命令前落 running、关键更新失败留围栏、保留 tracked 重试并补 taskId；`cloud-move-service.ts:407-459,501-512` 同口径保留 pending。原 running 更新异常反例按新 taskId 写点注入，DB running 门仍非空。正式 `cloud-history.test.ts:1129-1205` / `cloud-move.test.ts:1029-1089` 进一步验证新操作被拒、恢复后轮询收敛/回填 taskId及终态落盘重试。不保证从未落盘的 taskId 在进程崩溃后凭空恢复；该分支明确报 persistWarning 并保留对账语义。 |

## 剩余 finding（沿用原编号）

### F06 / T4b-06｜Major｜发布 overwrite 写后未知分类及第二遍重发未统一

- **定位**：`server/src/kb/publication-service.ts:944-963` 第二遍准入；`:1208-1249` overwrite/catch；`:1345-1361` classifyError；`:1371-1381` 仅 create 的扩展分类。
- **触发 A**：已发布 B，release 正文改变；overwrite 已接受云端写入，但命令响应抛 `LarkCliError('…','parse',false)`。测试替身实际先写 createdDocs 再抛错；meta 保持原秒值（同秒写入/尚未观察到时间推进均可能）。
- **实际影响 A**：映射 state 和 push_log outcome 均为 **failed**，而非 unknown。下次普通 PUBLISH 再 overwrite；独立 runner 观测 **attempts=2**。失去写后未知提示及人工核对门。
- **触发 B**：A 已发布且链接新 B；新 release 改 A 正文，首遍 overwrite(A) 抛 timeout，随后 B 创建成功改变 A 互链渲染。第二遍只要求有 token、render hash 改变，不检查第一遍 unknown。
- **实际影响 B**：虽第一遍落 unknown，**同一次 execute 的第二遍仍 overwrite(A)**；独立 runner 观测 `attempts=2; secondPass=1; 最终 state=unknown`。未知写未核对即重发，timeout 分类为 unknown 本身不足以关闭问题。
- **证据等级**：以上两分支均动态复现，真实服务+SQLite，远端是注明的 stub。正式 318 例全绿没有覆盖这两条组合路径。
- **最小修复方向**：按写入阶段区分写前明确失败与写后未知；overwrite 发出后的 parse/incomplete_response/timeout 统一 unknown。第二遍只接纳本批确认成功或安全 skip 的文档，拒绝第一遍 unknown/失败行；不要仅改 classifyError 而保留第二遍重发通路。正常回读 `parseDocumentProfile` 的只读失败与 overwrite 命令响应 parse 应区分，不能笼统把所有验证警告改成未知。

### F07 / T4b-07｜Major｜current token 为空时既有谱系在下一次 force create 被清除

- **定位**：`server/src/kb/publication-service.ts:1041-1048`，尤其空 token 分支 `return { warnings: parsed.warnings }`；`:1058-1068,1107` 消费该返回值重写 warningsJson。排除 provider：`modules/local-map-store.ts:listPublishedCloudTokens`。
- **触发**：发布旧 A → 行置 unknown → force 重新创建时 parse/timeout（当前 cloudToken=null，previousCloudTokens=[A]）→ 经人工核对后再次 force 创建 B 成功。
- **实际影响**：第二次 force 的 archivedTokens 因 row.cloudToken=null 不返回已经存在的 previousCloudTokens；creating/success 写入均把 A 谱系擦除。A 实际仍存在时再次成为构建原始源候选，防自我喂养不变量仍被破坏。
- **证据**：独立 runner 第一次 force 失败后断言 provider 包含 A；第二次 force 成功后 provider **不含 A，仅含 B**。输出：`old token=docxcnFixA0001; after second force excluded=docxcnFixA0002`。原正常 A→B 用例通过不能覆盖这条故障恢复链。
- **最小修复方向**：无论当前 token 是否存在，都保留 parsed.previousCloudTokens；当前 token 仅作为可选追加。正式回归加入“重建失败→再次重建”的谱系持久化检查。该缺口是原 07 残留，不另开号。

## 实际验证账本

| cwd | 命令 | 退出/结果 |
|---|---|---|
| `server/` | `git rev-parse HEAD && git status --short && npx vitest run tests/kb-publication-fixA.test.ts tests/kb-publication.test.ts tests/cloud-history.test.ts tests/cloud-move.test.ts tests/lark-cli-client.test.ts tests/source-edit.test.ts tests/source-push.test.ts tests/local-map-store.test.ts --silent` | 0；**8 files / 318 passed**。fixA 18、publication 40、history 59、move 42、client 53、edit 23、push 64、store 19。 |
| 根 | `python3 /tmp/t4b-original-replay.py`（修正 runner 文本转换后） | 0；**3 files / 10 passed**。原 8 项反例（06 三分支）改断言为安全行为；非仅跑实施者正式测试。 |
| 根 | `python3 /tmp/t4b-replay-review.py` | 0；**1 file / 2 passed**，断言不安全行为，坐实 F06 parse 重发及 F07 多次 force 丢谱系；不代表安全合约通过。 |
| 根 | `python3 /tmp/t4b-secondpass-timeout.py` | 0；**1 file / 1 passed**，断言不安全行为，坐实 F06 timeout 同批第二遍重发。 |
| 根 | `npx vitest run src/components/SourceEditControls.test.tsx src/components/source-history/CloudDiffModal.test.tsx --silent && npm run typecheck` | 0；**2 files / 17 passed**；root src、root 配置、server 三段 tsc 通过。不是浏览器交互。 |

### 独立原反例重放的调整说明

源 runner 仍在上游报告附录。重新提取其 Python fenced block，保留真实 fixture/SQLite/源码入口，仅作以下等效调整：

1. 01 原 barrier 必须两请求都建完计划才放行，修复后第二请求被同步拒绝会永久等待；改 buildPlan 末尾延时 10ms，期待一 fulfilled / 一次 create。
2. 02 期待无 A overwrite 且他人正文保留；04 期待 history reads>0、overwrite=0；05 期待 active 非空、第二次 cloud_move_running、move=1。
3. 06 create/revert/move 期待 unknown，create 普通重发 attempts=1；07 期待旧 token 仍在 provider；09 期待 false。
4. 10 新实现命令前已 INSERT running，原 `patch.revertState==='running'` 不再是实际 taskId 补写点；故对 `patch.revertTaskId` 写入注入异常，期待 running gate 非空。
5. 删除原不安全行为的 console 叙述。测试名称沿用旧标题，**断言已改为上述安全预期**，不能按旧标题误解结果。

首次转换脚本错误地按 console 字符串内分号截断，生成 TS 语法错误（3 suites failed / no tests，exit 1）。已按原始 esbuild 错误定位为审核夹具转换错误，修正为匹配完整 console 调用后重跑得 10 passed；没有改产品或正式测试来过关。另一次读取 test 的 offset=185 超过文件总长 145，已从有效区间读取，不以失败读取声称覆盖。

## 覆盖、盲区与剩余动作

- 正确性/并发/状态一致性/权限围栏：按原十项及直接链路逐项核对；03 入口正式集成测试、8 项独立反例、06/07 扩展故障恢复反例有动态证据。
- 配置兼容与持久化：临时 ConfigManager/SQLite 真实运行；未验证生产数据迁移或 Electron/Windows 打包。
- 远端行为均为明确的测试替身，零实际云端写入、零凭据操作；S5 实际 move/task 输出形态未复核。不得把 fixture 结果称为生产集成证据。
- 08 helper 请求契约、服务/路由已验证；未进行组件真实挂载点击、浏览器/Electron/视觉走查。其真机证据须补齐；helper 单测不得改称按钮交互验收。
- 全量前后端不重复跑；本轮定向证据不足以宣称整个共享树发布就绪。未新增性能/维护性风格问题。
- 剩余修复清单：**06 写后未知与第二遍状态门；07 空 current token 的历史谱系保全；08 补真机点击与真实数据回填/失败降级交互证据**。
- 本轮业务代码、正式测试零写入；只新增本报告。临时测试目录由各 runner finally 清理，临时 Python 文件交付前删除。无 commit/stash/restore/reset。回滚本轮产物仅删除本报告，不触碰共享树实现。

## 附录：新增反例的可复核最小主体

运行方法：沿上游 runner 的 /tmp fixture 展开方式，改用 `server/tests/kb-publication-fixA.test.ts` 的首个 `describe('T4b-01` 之前初始化前缀（默认有历史锚），import 指向当前 server/src；添加以下 Vitest 主体。外层 node_modules 链接、globalSetup、finally 清理与上游一致。均使用临时 SQLite，远端替身不冒充飞书。该主体为审核脚本，不是项目正式测试。

```typescript
describe('T4b independent residuals', () => {
  it('06 parse after accepted overwrite permits ordinary resend', async () => {
    const fx = makeFixture();
    try {
      await fx.service.execute({confirm:'PUBLISH',kbPaths:['b/b.md']});
      writeRelease(fx.outputRoot,'rel-002',[
        {path:'b/b.md',markdown:DOC_B+'\nChanged body'},
      ]);
      let attempts=0;
      const overwrite=fx.lark.overwriteDocument as any;
      fx.lark.overwriteDocument=async (...args:any[]) => {
        attempts++;
        await overwrite(...args); // stub 模拟远端已接受写入
        throw new LarkCliError('accepted then bad JSON','parse',false);
      };
      await fx.service.execute({confirm:'PUBLISH',kbPaths:['b/b.md']});
      const row=fx.store.getKbPublication('b/b.md')!;
      expect(row.state).toBe('failed');
      expect(fx.store.listSourcePushLogs(row.cloudToken!)[0].outcome).toBe('failed');
      await fx.service.execute({confirm:'PUBLISH',kbPaths:['b/b.md']});
      expect(attempts).toBe(2);
    } finally { fx.cleanup(); }
  });
  it('06 timeout unknown is retried in the same batch second pass', async () => {
    const fx=makeFixture();
    try {
      await fx.service.execute({confirm:'PUBLISH',kbPaths:['dirA/a.md']});
      writeRelease(fx.outputRoot,'rel-002',[
        {path:'dirA/a.md',markdown:DOC_A+'\nchanged'},
        {path:'b/b.md',markdown:DOC_B},
      ]);
      const old=fx.store.getKbPublication('dirA/a.md')!;
      let attempts=0;
      fx.lark.overwriteDocument=async (token:string) => {
        if(token===old.cloudToken) {
          attempts++;
          throw new LarkCliError('accepted then timeout','timeout',false);
        }
        return {revisionId:12};
      };
      const r=await fx.service.execute({confirm:'PUBLISH'});
      expect(attempts).toBe(2);
      expect(r.counts.secondPass).toBe(1);
      expect(fx.store.getKbPublication('dirA/a.md')!.state).toBe('unknown');
    } finally { fx.cleanup(); }
  });
  it('07 second force after unknown create erases old token lineage', async () => {
    const fx=makeFixture();
    try {
      await fx.service.execute({confirm:'PUBLISH',kbPaths:['b/b.md']});
      const old=fx.store.getKbPublication('b/b.md')!;
      fx.store.upsertKbPublication({...old,state:'unknown'});
      const create=fx.lark.createDocumentMarkdown as any;
      fx.lark.createDocumentMarkdown=async () => {
        throw new LarkCliError('accepted but bad JSON','parse',false);
      };
      await fx.service.execute({confirm:'PUBLISH',force:true,kbPaths:['b/b.md']});
      expect(fx.store.listPublishedCloudTokens()).toContain(old.cloudToken);
      fx.lark.createDocumentMarkdown=create;
      await fx.service.execute({confirm:'PUBLISH',force:true,kbPaths:['b/b.md']});
      expect(fx.store.listPublishedCloudTokens()).not.toContain(old.cloudToken);
    } finally { fx.cleanup(); }
  });
});
```

**最终：VERDICT: FIX（仅对本报告声明的原十项及直接修复链有效）。**
