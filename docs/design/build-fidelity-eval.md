# 构建保真评测骨架（S4）

> 范围：`server/scripts/lib/build-fidelity-metrics.ts`（指标纯函数 + 黄金集加载校验）与
> `build-fidelity-synthetic.ts`（合成 fixture）。本轮只交付骨架：目录约定、指标定义与
> 合成数据，**不含任何真实资料**；测试见 `server/tests/build-fidelity-eval.test.ts`。

## 目的

标准库构建（write → review → integrate）目前的机械门禁只覆盖流程完整性与证据哈希；
「数值/条件/事实是否被保真转写」「多源冲突是否被并列而非静默取一方」依赖模型与人工。
本骨架把这两类问题降为**可复算的确定性指标**：给定人工标注的黄金断言集与构建产物
文本，不调用模型即可产出保真率、遗漏率与冲突处理正确率，用于纵向对比构建策略改动。

## 目录约定

- 合成资料：只存在于生成器代码内（`build-fidelity-synthetic.ts`，虚构「星轨远征」
  规则集），仅物化到调用方自有的**空临时目录**（`materializeSyntheticFidelity`），
  产物为 `<dir>/golden.jsonl` + `<dir>/docs/<docPath>`；不进仓库、不进 fixtures。
- 真实资料（未来接入时）：`server/tests/fixtures/build-fidelity/<数据集名>/`，同构布局
  （`golden.jsonl` + `docs/`），数据集目录内 provenance 必须单一（见下），目录名即
  数据集名；评测报告只落调用方输出目录，证据文件不可被覆盖写。
- 黄金集与产物文本一一对应同一数据集；跨数据集混用分母无意义，加载层直接拒绝。

## 黄金集 JSONL 格式

每行一条断言（字段校验见 `parseGoldenSet`，坏行报 `文件:行号`）：

```jsonc
{
  "id": "assert-001",                        // 唯一；重复即报错
  "docPath": "战斗/星轨护盾.md",              // 断言应出现的产物文档（正斜杠相对路径）
  "kind": "text | number | condition",
  "source": { "objToken": "src-token", "quote": "可选源原文锚点（仅人工核对，不参与匹配）" },
  "expected": {
    "text": "期望保真表达的事实片段",           // kind=text|condition
    "numbers": [1500, 4000],                  // kind=number：期望全部出现
    "conditionTerm": "仅当"                    // kind=condition：须与 text 同句共现
  },
  "conflict": {                               // 可选：期望的多源冲突并列
    "sides": [ { "objToken": "src-b", "text": "另一方应被呈现的原文" } ]
  },
  "provenance": { "kind": "synthetic", "source": "hand-authored-fixture" }
}
```

拒绝项：id 空/重复、docPath 空/非 .md、kind 非法、各 kind 期望字段缺失或类型不符、
冲突 sides 空或含空字段、provenance 缺失、human 标注缺 `annotator`+`reference`、
合成与人工标注混在同一文件、空集。校验失败即整份拒绝，**绝不静默缩水分母**。

## 指标定义（确定性匹配，无模型）

文本规范化：NFKC（全角→半角）、小写、去空白、弯直引号归一、剥离 markdown
强调/标题/引用字符；标点保留参与匹配。

| 指标 | 定义 | 匹配规则 |
|---|---|---|
| factFidelity | preserved 断言数 / 总断言数 | 断言全部期望元素命中（coverage = 1） |
| omissionRate | 零命中断言数 / 总断言数 | 断言任何元素都未命中（含产物文档缺失） |
| conflictHandlingCorrectness | 冲突处理正确数 / 冲突断言数 | 己方期望与冲突各方文本均出现（并列的确定性代理） |

- `text`：规范化后期望片段是产物文本的子串。
- `number`：千分位（`1,500`→1500）、百分号与单位剥离后，期望数值集合全部出现在产物
  数值集合中；符号仅紧贴数字时计入（`skill-1001` 抽成 -1001），需要上下文锚定时配合
  text 断言。
- `condition`：条件限定词与事实片段**同句共现**（按中英文句终符与换行切句）。
- 部分丢失（数值集只命中一半）计 factFidelity 失分、不计 omission；整条零命中两者
  皆计。分母为空返回 `null`，null 不是 0。

**已知局限（如实声明，不假装覆盖）**：子串/数值匹配不判定语义等价（改写偷换原意、
夸大范围仍需审查流水线）；「并列」代理只验证各方文本存在，不验证呈现方式是否并排
而非互相矛盾；`quote` 字段不参与匹配。

## 真实与合成严格分开

- 每条断言必带 `provenance`；synthetic 与 human 混写同一文件在加载层直接报错。
- human 标注必须带 `annotator`（标注人）与 `reference`（来源依据），可独立复核。
- 合成 fixture 的任何结果**不构成验收证据**，只能用于指标正确性与回归验证；
  真实数据集的结论必须单独记录数据集名、标注来源与运行日期。
