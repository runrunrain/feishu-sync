/**
 * cloudObjType - P2-S8（设计 §4.3/U50）未知类型提示文案
 *
 * 检测链把 mindnote/file 等折叠为 objType 'unknown' 时，会把折叠前的
 * 真实云端类型携带在 cloudObjType 字段（仅未知类型路径）。这里集中
 * 维护「不支持同步的类型」类文案，供变更列表详情与同步结果列表使用。
 * 已支持类型不携带该字段，展示行为不变。
 */

/** 类型专属提示（设计 §4.2 blocker 文案列）；无专属文案的类型返回 null。 */
export function unsupportedCloudTypeHint(cloudObjType?: string | null): string | null {
  const type = cloudObjType?.trim();
  if (!type) return null;
  if (type === 'mindnote') {
    return '思维笔记暂不支持同步，可在飞书中导出为文档后纳入';
  }
  if (type === 'file') {
    return '云空间文件暂不支持同步';
  }
  return null;
}

/**
 * 完整提示行：不支持同步的类型：<type>（含类型专属提示，若有）。
 * 无 cloudObjType（已支持类型或真实类型不可得）返回 null——调用方不渲染。
 */
export function unsupportedCloudTypeText(cloudObjType?: string | null): string | null {
  const type = cloudObjType?.trim();
  if (!type) return null;
  const hint = unsupportedCloudTypeHint(type);
  return hint ? `不支持同步的类型：${type}（${hint}）` : `不支持同步的类型：${type}`;
}
