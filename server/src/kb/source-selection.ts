import type { DocumentRecord } from '../types/index.js';

/**
 * 构建勾选不等于删除已发布来源。待更新比较和增量构建保留仍然可用的
 * 已发布源；明确排除、实际删源仍由各自的记录决定。完整重建只用勾选源。
 */
export function selectKnowledgeSources(
  documents: DocumentRecord[],
  options: {
    unselected: Iterable<string>;
    excluded: Iterable<string>;
    published?: Iterable<string>;
  },
): DocumentRecord[] {
  const unselected = new Set(options.unselected);
  const excluded = new Set(options.excluded);
  const published = new Set(options.published);
  return documents.filter((doc) => !excluded.has(doc.objToken)
    && (!unselected.has(doc.objToken) || published.has(doc.objToken)));
}
