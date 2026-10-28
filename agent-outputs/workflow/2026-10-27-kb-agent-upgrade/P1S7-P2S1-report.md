# P1-S7 + P2-S2 前置切片报告：发布渲染 + 字数统计纯函数（P1S7-P2S1）

> 任务：`server/src/kb/publish-render.ts`（P1 §4.3 契约）与 `server/src/kb/text-stats.ts`（P2 §2.1 契约）
> 两个纯函数模块，均不接线（消费接线在 P1-S8 / P2-S2）。
> 设计依据：`lark-cli-newcaps-P1.md` §4.3/§4.5、`lark-cli-newcaps-P2.md` §2.1（P2-S1 注明「P1 已建则跳过」，
> 两模块合并本切片交付，两份文档引用同一契约）。

## 一、产物

| 文件 | 内容 |
|---|---|
| `server/src/kb/publish-render.ts` | `renderForPublish` 确定性渲染纯函数 |
| `server/src/kb/text-stats.ts` | `countText` 字数/字符统计纯函数 |
| `server/tests/publish-render.test.ts` | 22 用例（算法层） |
| `server/tests/text-stats.test.ts` | 15 用例（算法层） |

无既有文件改动；两模块零 IO、零依赖注入（publish-render 仅用 node:crypto 哈希与 node:path 路径解析，仍为纯函数）。

## 二、导出签名清单（P1-S8 / P2-S2 消费接口）

### publish-render.ts（P1-S8 KbPublishService 消费）

```ts
export type PublishWarningCode = 'link_target_unpublished' | 'image_not_published';

export interface PublishWarning {
  code: PublishWarningCode;
  kbPath: string;   // 产生警告的标准库文档（input.kbPath），预览/UI 归因用
  target?: string;  // link：解析后的目标标准库路径（含 ../ 越界路径）；image：解析后的图片路径
  text?: string;    // 保留进正文的文字（链接文字 / 图片 alt；图片 alt 为空时为原 URL）
}

export interface RenderForPublishInput {
  kbPath: string;                       // 标准库相对 POSIX 路径
  markdown: string;                     // 标准库文件全文（含 feishu_sync_kb 头部）
  publishedUrlByKbPath: Map<string, string>; // 已发布文档路径 → 云端 URL
}

export interface RenderForPublishResult {
  title: string;       // 头部 title 字段 → 首个 H1 → basename 去 .md
  body: string;        // 渲染后正文（头部与同名首个 H1 已移除，链接/图片已改写）
  warnings: PublishWarning[]; // 按 (code, target) 首次出现去重，文档序稳定
  contentHash: string; // sha256(body) hex（UTF-8）——标题经 --title 单独传递，不入哈希
}

export function renderForPublish(input: RenderForPublishInput): RenderForPublishResult;
```

### text-stats.ts（P2-S2 effectiveWords / P1-S8 回读校验共用）

```ts
export interface TextStats { words: number; chars: number; }
export function countText(markdown: string): TextStats;
// words：Han/假名/谚文逐码点计 1；其余按 [\p{L}\p{N}_'-]+ 连续段计 1（两类不互相吞并）
// chars：预处理后非空白 Unicode 码点数（代理对按 1 计）
```

## 三、契约要点与实现决策（设计未明说处的边界裁定）

1. **标题**：现行 `feishu_sync_kb` 头部无 `title` 字段（实测 kb-build-service/agent-tool-service 生成格式），
   解析留作前向兼容；都缺失时回退 basename 去 `.md`（与 kb-build-service 的 title 回退同口径）。
   与标题相同的首个 H1 移除；不同则 H1 保留在正文。
2. **链接解析**：仅「无 scheme、非 `//`、非 `/` 开头、非纯锚点」的相对 URL 按 kbPath 解析
   （`path.posix.normalize(join(dirname(kbPath), pathPart))`，fragment/query 剥离后解析；改写后 fragment 丢弃）。
   解析越界（`../../x.md` → `../x.md`）按未发布处理（目标不可能在发布映射内）。
   根相对 `/x.md` 不在设计的「相对链接」定义内 → 原样保留不告警。
3. **图片占位**：`> ［图片未发布：alt］`（全角括号/冒号，与设计原文一致）；alt 为空时用原 URL 保证可辨认。
   远程图片原样保留不告警。
4. **代码保护（设计未明说，属确定性渲染的正确性收紧）**：围栏代码块（```/~~~，开闭围栏字符与长度
   CommonMark 口径）与行内代码 span（n 反引号开恰 n 闭）内的链接/图片一律不改写——标准库正文含
   Markdown 示例，改写会损坏示例。任务书边界用例「纯代码块」即锚定此行为。
5. **countText 预处理顺序**（P2 §2.1 固定）：剥头部注释（feishu_sync / feishu_sync_kb 同一正则）→
   图片计 alt、链接计文字（先图片后链接）→ 围栏状态机（围栏行丢弃、内容行原样）→ 围栏外剥行首
   引用/标题/列表标记（循环剥嵌套）、主题分割线与表格分隔行整行丢弃、其余行去全部 `|`。
   行内代码反引号**保留**计入 chars（§2.1 未列，宽容差 [0.8,1.25] 内）。
6. **§2.6 算例说明**：P2 §2.6 的 8 源算例是 `packBatches` 装箱算例（P2-S2/S3 切片），不属 countText；
   本切片测试锚定 §2.1 口径规则与 §2.2 中 countText 承担的正文项语义（「unavailable 计 0」为消费侧逻辑）。

## 四、测试矩阵（37/37 绿）

### publish-render（22）

| 分组 | 用例 |
|---|---|
| 头部与标题 (4) | 头部去除+H1 标题+同名 H1 移除；头部 title 优先且不同名 H1 保留；无 H1 回退 basename；无头部文档 |
| 链接改写 (6) | 已发布 ../、./、子目录三种解析改写；fragment 剥离；未发布去链接+警告；越界按未发布；外部形式（https/mailto/#/）原样；同目标去重 |
| 图片替换 (3) | 相对路径占位+警告；空 alt 用 URL；远程图片保留 |
| 代码保护 (3) | 纯代码块文档不动；行内代码不改写；未闭合反引号按普通文字处理 |
| 确定性 (3) | 同输入两次全等；Map 键序无关；URL 变化 → hash 变化（两遍发布前提） |
| 边界 (3) | 空文档（sha256("")）；仅头部+标题；自链接解析 |

### text-stats（15)

| 分组 | 用例 |
|---|---|
| 预处理 (7) | feishu_sync / feishu_sync_kb 剥离；链接/图片只计文字；标题/列表/引用标记（含嵌套缩进）；表格分隔行丢弃+数据行管道去除；代码块围栏丢弃内容保留；主题分割线；空文档 |
| words (6) | 中文逐字+标点不计词计字符；英文连续词元（连字符/撇号/下划线）；abc中def=3 词不互相吞并；平/片假名与谚文逐字；西里尔走通用正则；emoji 计 chars 不计 words |
| chars (2) | 非空白码点（含全角空格不计）；无头部渲染正文同样可统计 |

## 五、验证证据

| 验证 | 命令（cwd=server） | 结果 |
|---|---|---|
| 定向单测 | `npx vitest run tests/publish-render.test.ts tests/text-stats.test.ts` | 2 files / 37 tests passed，退出码 0 |
| 类型 | `npm run typecheck`（tsc --noEmit） | 退出码 0 |
| Lint | `npx eslint <4 个新文件>`（repo root） | 退出码 0，无输出 |

未运行项：全量 `npm test`（共享树有并行兄弟任务 luban/2c1f9511、luban/733efb22，全量套件可能撞兄弟中间态；
结算基线由 harness 隔离快照执行）。本切片零既有文件改动，理论上无回归面。

## 六、未覆盖项 / 风险

- 两遍发布、发布计划/执行、`published_content_hash` 落库均在 P1-S8；`effectiveWords`、`packBatches` 接线在 P2-S2。
- `contentHash` 只覆盖 body：若未来 update 路径需要「仅标题变化也重发」，需 P1-S8 在跳过判定中另比标题
  （设计 §4.2 定义即为正文哈希，当前按契约实现）。
- 围栏/行内代码扫描为 CommonMark 简化口径（如 setext 标题、嵌套围栏列表内代码块未做特殊处理），
  对 LLM 生成的标准库文档（统一 ``` 围栏）足够；实测缺陷由后续切片用真实 corpus 回归补充。

## 七、回滚方式

删除 4 个新文件即可，无既有文件改动：`server/src/kb/publish-render.ts`、`server/src/kb/text-stats.ts`、
`server/tests/publish-render.test.ts`、`server/tests/text-stats.test.ts`。
