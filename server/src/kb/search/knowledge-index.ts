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
export const KNOWLEDGE_INDEX_SCHEMA_VERSION = 1;

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
  };
}
