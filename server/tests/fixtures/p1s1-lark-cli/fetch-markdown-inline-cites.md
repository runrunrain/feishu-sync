<!-- P1-S1 fixture：docs +fetch --doc-format markdown --detail simple 正文引用形态（RP-2）
     @doc → <cite doc-id file-type title type>；@user → <cite type=user user-id user-name>；
     sheet 嵌入 → <sheet sheet-id token>；普通链接 → [text](url)；
     <cite type="citation">（参考文献）create 后被静默丢弃，fetch 正文不出现 -->
# p1s1-引用测试B

四种引用形态对照：

1. 普通飞书链接：[文档A的链接](https://<tenant>.feishu.cn/docx/VtS3d0GPLoAxLJxAGHLcv1tMnQZ)
2. @文档引用：<cite doc-id="VtS3d0GPLoAxLJxAGHLcv1tMnQZ" file-type="docx" title="p1s1-发布测试A" type="doc"></cite>
3. 参考文献：
4. @人引用：<cite type="user" user-id="ou_xxxxxxxxxxxxxxxxxxxxxxxx" user-name="测试用户"></cite>

结束段落。

嵌入表格段落：

<sheet sheet-id="GGRbGT" token="PhQvsydSBhy0UStlHk0c3zoJnoe"></sheet>
