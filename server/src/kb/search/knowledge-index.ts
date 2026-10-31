/**
 * 知识索引内存视图（A案 §6.2/§8）——对象/呈现/关系/证据/覆盖的访问层。
 *
 * T4b 从 standard-kb-store 提取为共用纯函数：StandardKbStore.readKnowledgeIndex
 * 与 KbQueryService（UI/内置 Agent/stdio/LAN MCP 三入口共用查询层，A案 §8.1）
 * 共用同一装配实现，不各写一套视图。本层只提供数据访问与集合视图，不过滤、
 * 不排序、不做用途判定——usage 三态与关系扩展预算在 kb-query-service 实现。
 *
 * 真相在 release 的 knowledge.json（全量自包含，MCP 无 SQLite 依赖）；
 * 缓存键为 (releaseId, organizationHash, indexSchemaVersion)（A案 §8.2）。
 */

import type {
  CoverageItem,
  Evidence,
  KnowledgeManifest,
  KnowledgeObject,
  KnowledgeRelation,
  Presentation,
} from '../knowledge-schema.js';

/** 内存索引结构版本：视图装配公式变化时递增，缓存键随之失效（A案 §8.2） */
export const KNOWLEDGE_INDEX_SCHEMA_VERSION = 2;

/** A案 §2.4 旧 path#heading → objectId 解析结果。
 * migratedFrom 为迁移链途经的已消失对象（不含终点）；多后继/环时不静默
 * 跳第一个，返回命中对象由调用方选择。 */
export interface LegacyRefResolution {
  objectId: string;
  aliasHitObjectId: string;
  migratedFrom: string[];
  cycle: boolean;
}

export interface KbKnowledgeIndex {
  releaseId: string;
  knowledge: KnowledgeManifest;
  objectsById: Map<string, KnowledgeObject>;
  /** 活跃对象（无 tombstone） */
  activeObjects: KnowledgeObject[];
  /** 对象 → canonical 所在文档路径 */
  canonicalDocByObject: Map<string, string>;
  /** 文档路径 → 活跃对象列表 */
  objectsByDoc: Map<string, KnowledgeObject[]>;
  presentationsByOwner: Map<string, Presentation[]>;
  relationsFrom: Map<string, KnowledgeRelation[]>;
  relationsTo: Map<string, KnowledgeRelation[]>;
  evidenceByObject: Map<string, Evidence[]>;
  coverage: CoverageItem[];
  /** A案 §2.4：旧 path#headingPath（≡ path#标题，编译契约标题行即章节头）
   * → objectId；活跃对象当前 canonical + tombstone 保留的旧 canonical。 */
  aliasByLegacyRef: Map<string, string>;
  /** 同键命中多对象（first-wins 未登记项；发布校验器应阻止，防御性记录） */
  aliasConflicts: Array<{ legacyRef: string; objectIds: string[] }>;
}

/** 从 knowledge.json 装配内存索引（纯函数；哈希校验在 release-reader 完成）。 */
export function assembleKnowledgeIndex(releaseId: string, knowledge: KnowledgeManifest): KbKnowledgeIndex {
  const objectsById = new Map(knowledge.objects.map((object) => [object.objectId, object] as const));
  const activeObjects = knowledge.objects.filter((object) => !object.tombstone);
  const canonicalDocByObject = new Map<string, string>();
  const objectsByDoc = new Map<string, KnowledgeObject[]>();
  for (const object of activeObjects) {
    if (!object.canonical) continue;
    canonicalDocByObject.set(object.objectId, object.canonical.path);
    const list = objectsByDoc.get(object.canonical.path) ?? [];
    list.push(object);
    objectsByDoc.set(object.canonical.path, list);
  }
  const presentationsByOwner = new Map<string, Presentation[]>();
  for (const presentation of knowledge.presentations) {
    const list = presentationsByOwner.get(presentation.ownerObjectId) ?? [];
    list.push(presentation);
    presentationsByOwner.set(presentation.ownerObjectId, list);
  }
  const relationsFrom = new Map<string, KnowledgeRelation[]>();
  const relationsTo = new Map<string, KnowledgeRelation[]>();
  for (const relation of knowledge.relations) {
    const from = relationsFrom.get(relation.fromObjectId) ?? [];
    from.push(relation);
    relationsFrom.set(relation.fromObjectId, from);
    const to = relationsTo.get(relation.toObjectId) ?? [];
    to.push(relation);
    relationsTo.set(relation.toObjectId, to);
  }
  const evidenceByObject = new Map<string, Evidence[]>();
  for (const evidence of knowledge.evidence) {
    const list = evidenceByObject.get(evidence.objectId) ?? [];
    list.push(evidence);
    evidenceByObject.set(evidence.objectId, list);
  }
  // A案 §2.4 alias 表：旧 `path#heading` → objectId。本流水线编译契约下
  // canonical 首行即章节标题（heading ≡ title），故以 `${path}#${title}` 登记，
  // 不依赖文档大纲（knowledge.json 自含）。仅覆盖当前 release 仍可推导的位置
  // （活跃对象当前位置 + tombstone 保留的旧 canonical）；更早历史路径随旧
  // release 清理不可复原——「脱离应用的旧相对路径不承诺永久重定向」。
  // move 不产生迁移映射（保留 ID 改 canonical），旧路径只有 tombstone 保留
  // canonical 时可解析；标题改名后的旧标题锚点不在当前 schema 数据内，同为
  // 已声明的边界而非静默丢失。
  const aliasByLegacyRef = new Map<string, string>();
  const aliasConflicts: Array<{ legacyRef: string; objectIds: string[] }> = [];
  for (const object of knowledge.objects) {
    if (!object.canonical) continue;
    const key = `${object.canonical.path}#${object.title}`;
    const existing = aliasByLegacyRef.get(key);
    if (existing === undefined) aliasByLegacyRef.set(key, object.objectId);
    else if (existing !== object.objectId) aliasConflicts.push({ legacyRef: key, objectIds: [existing, object.objectId] });
  }
  return {
    releaseId,
    knowledge,
    objectsById,
    activeObjects,
    canonicalDocByObject,
    objectsByDoc,
    presentationsByOwner,
    relationsFrom,
    relationsTo,
    evidenceByObject,
    coverage: knowledge.coverage,
    aliasByLegacyRef,
    aliasConflicts,
  };
}

/** A案 §2.4：旧 path#heading 引用解析。接受完整 headingPath（含 › 分隔）
 * 与末段裸标题两种形态；命中后沿 tombstone/migrations 迁移链前进到活跃
 * 对象——单后继链自动跟进，多后继/零后继/环停在当前对象由调用方选择
 * （不静默跳第一个）；环以 visited 集合防御（发布门禁阻止环，此处兼防御）。 */
export function resolveLegacyRef(view: KbKnowledgeIndex, legacyRef: string): LegacyRefResolution | null {
  const ref = legacyRef.trim();
  if (!ref) return null;
  let hit = view.aliasByLegacyRef.get(ref);
  if (hit === undefined && ref.includes('#')) {
    const section = ref.slice(ref.lastIndexOf('#') + 1);
    const last = section.includes(' › ') ? section.split(' › ').pop()! : null;
    if (last) hit = view.aliasByLegacyRef.get(`${ref.slice(0, ref.lastIndexOf('#') + 1)}${last}`);
  }
  if (hit === undefined) return null;
  const migratedFrom: string[] = [];
  const visited = new Set<string>([hit]);
  let current = hit;
  for (;;) {
    const object = view.objectsById.get(current);
    if (!object || !object.tombstone) return { objectId: current, aliasHitObjectId: hit, migratedFrom, cycle: false };
    const successors = new Set<string>([
      ...(object.tombstone.successorObjectIds ?? []),
      ...(view.knowledge.migrations.find((migration) => migration.objectId === current)?.successorObjectIds ?? []),
    ]);
    if (successors.size !== 1) return { objectId: current, aliasHitObjectId: hit, migratedFrom, cycle: false };
    const successor = [...successors][0]!;
    if (visited.has(successor)) return { objectId: current, aliasHitObjectId: hit, migratedFrom, cycle: true };
    visited.add(successor);
    migratedFrom.push(current);
    current = successor;
  }
}
