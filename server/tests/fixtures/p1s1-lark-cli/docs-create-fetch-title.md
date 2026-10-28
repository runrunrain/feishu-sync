<!-- P1-S1 fixture：docs +create --title "p1s1-发布测试A" 后 fetch 回读（PB-1）
     CLI 在 content 前置 <title> 行；正文内 H1 不被移除（两者并存）；
     create 输入 |---|---| 表格分隔行 fetch 归一为 |-|-|；代码块内 URL 不转链接 -->
<title>p1s1-发布测试A</title>

# 内容内标题-应被覆盖

这是 P1-S1 发布测试文档 A，验证 docs +create 的 --title 行为与 parse 回读画像。

## 二级标题-统计样本

正文段落：中英混排 English words mixed content，用于 char_count 口径对比。数字 12345 与标点！@# 也计入。

- 列表项一 list item one
- 列表项二 list item two

| 列A | 列B |
|-|-|
| 值一 | 值二 |

```code
code block lines should not be links
https://<tenant>.feishu.cn/docx/shouldnotparse123456
```
