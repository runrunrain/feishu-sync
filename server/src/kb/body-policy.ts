/** 明确的修订记录/写作过程不属于标准正文；不误杀正常的领域版本规则。 */
export function hasEditorialHistory(markdown: string): boolean {
  return /^\s*(?:#{1,6}\s+)(?:变更记录|修订记录|版本历史|版本说明|更新日志|更新记录|修订说明|changelog|revision history)(?:\s|[：:]|$)/im.test(markdown)
    || /^\s*(?:>\s*)?版本[：:]\s*[vV]?\d/m.test(markdown)
    || /^\s*(?:[-*]\s*)?(?:本次(?:修订|更新|改动)[：:，,]|相较(?:上一|上|旧)版|相比(?:上一|上|旧)版)/m.test(markdown)
    || /^\s*(?:(?:依据|根据|基于)(?:新增|变更|更新|本次|已移除|被排除)(?:源|来源|文档)|(?:本次|本批次)(?:构建|新增|生成|处理|修订|更新)|(?:已|本版)(?:改为|新增|删除|移除))/m.test(markdown)
    || /^\s*(?:新增|补充|更新|重写|生成|撰写|修订|删除|移除)[^\n。]{0,80}(?:标准文档|知识库文档)/m.test(markdown);
}

/** 只识别构建溯源信息；领域内的资源来源、伤害来源等正常知识仍可保留。 */
export function hasSourceMetadata(markdown: string, identifiers: Iterable<string> = []): boolean {
  if (/\b(?:obj_?token|doc_id|build_id|feishu_sync_kb)\b/i.test(markdown)
    || /\b(?:b_\d{14}_[a-z0-9]+|r_\d{8}T\d{6}_[a-z0-9]+|kd_[a-f0-9]{12})\b/i.test(markdown)
    || /^\s*(?:#{1,6}\s+|>\s*|[-*]\s*)?(?:\*\*)?(?:资料来源|文档来源|原始来源|来源追溯|来源说明|参考文档|来源)(?:\*\*)?\s*(?:[：:]|$)/m.test(markdown)) {
    return true;
  }
  for (const identifier of identifiers) {
    if (!identifier) continue;
    // 避免短标识匹配到另一个单词内部，同时支持紧邻中文与 Markdown 标点。
    const escaped = identifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`(?<![A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])`).test(markdown)) return true;
  }
  return false;
}
