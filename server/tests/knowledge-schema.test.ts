/**
 * knowledge-schema / orchestration-contracts 契约层单测（T1）
 *
 * 纯函数测试，无 better-sqlite3 依赖（config 段的 ConfigManager round-trip
 * 用隔离临时配置文件，同 config-manager.test.ts 模式）。
 *
 * 覆盖（任务书 §6）：
 * - 校验器：合法图零 blocking；每类错误码至少 1 正 1 反；
 * - hash：确定性 + 敏感性（改正文/证据/关系→变；改标题/时间戳/审查结果→
 *   payloadHash 不变，按 A 案 §2.3 定义）；
 * - reportCoversDraft / canPublish：旧报告≠新稿、缺报告不放行、阻断未关不放行；
 * - config 默认值与校验 round-trip；
 * - manifest v2 序列化/解析 round-trip、v1 无新字段兼容。
 */

import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  computePayloadHash,
  computeReviewSubjectHash,
  isBlocking,
  isCanonicalConflictOrientation,
  normalizeObjectBodyForPayload,
  validateKnowledgeGraph,
  type Evidence,
  type KnowledgeManifest,
  type KnowledgeObject,
  type ObjectMigration,
  type Presentation,
} from '../src/kb/knowledge-schema.js';
import {
  canPublish,
  computeBuildSpecHash,
  computeCandidateHash,
  reportCoversDraft,
  revisionBudgetExhausted,
  type BuildSpec,
  type CandidateRelease,
  type ReviewReport,
} from '../src/kb/orchestration-contracts.js';
import {
  buildDefaultStandardKbConfig,
  isKbManifestV2,
  KB_MANIFEST_SCHEMA_V2,
  resolveBuildConcurrency,
  type KbManifest,
} from '../src/types/agent-knowledge.js';
import { ConfigManager, validateAgentAndKbConfig } from '../src/modules/config-manager.js';

// ============================================================================
// fixture：一个合法的小型知识图（攻防拼点样本的最小化投影）
// ============================================================================

function makeObject(overrides: Partial<KnowledgeObject> = {}): KnowledgeObject {
  return {
    objectId: 'ko_atkdef_linear',
    type: 'rule',
    title: '攻防修正·线性方案',
    aliases: ['线性攻防修正'],
    domainIds: ['combat'],
    familyKey: 'atk-def-mod',
    variantKey: 'linear',
    scopeKey: 'combat:pvp',
    scopeText: 'PvP 战斗',
    canonical: {
      docId: 'doc_rule',
      path: 'combat/atk-def.md',
      anchor: 'ko_atkdef_linear',
      bodyRange: { startLine: 10, endLine: 30 },
    },
    revision: 3,
    locationRevision: 1,
    payloadHash: 'placeholder',
    reviewSubjectHash: 'placeholder',
    businessStatus: 'candidate',
    reviewStatus: 'pending',
    claims: [
      {
        claimKey: 'advantage-cap',
        bodyRange: { startLine: 12, endLine: 13 },
        riskCategory: 'high',
        evidenceIds: ['ev_cap'],
      },
    ],
    ...overrides,
  };
}

function makeEvidence(overrides: Partial<Evidence> = {}): Evidence {
  return {
    evidenceId: 'ev_cap',
    objectId: 'ko_atkdef_linear',
    claimKey: 'advantage-cap',
    sourceRef: {
      sourceId: 'src_design',
      sourceSnapshotHash: 'snap-hash-1',
      resourceId: 'res_main',
      resourceHash: 'res-hash-1',
    },
    selector: {
      kind: 'text_span',
      lineStart: 5,
      lineEnd: 6,
      colStart: 1,
      colEnd: 40,
      headingPath: ['①设计概要'],
    },
    quoteHash: 'quote-hash-1',
    role: 'supports',
    nature: 'direct',
    ...overrides,
  };
}

function legalManifest(): KnowledgeManifest {
  const koA = makeObject();
  const koB = makeObject({
    objectId: 'ko_unit',
    type: 'concept',
    title: '作战单元',
    aliases: ['Unit'],
    familyKey: 'combat-unit',
    variantKey: 'base',
    scopeKey: 'combat:all',
    scopeText: '全部战斗',
    canonical: {
      docId: 'doc_concept',
      path: 'combat/unit.md',
      anchor: 'ko_unit',
      bodyRange: { startLine: 1, endLine: 8 },
    },
    claims: [
      {
        claimKey: 'unit-def',
        bodyRange: { startLine: 2, endLine: 3 },
        riskCategory: 'normal',
        evidenceIds: [],
      },
    ],
  });
  const summary: Presentation = {
    presentationId: 'pres_summary_1',
    ownerObjectId: 'ko_unit',
    kind: 'summary',
    bodyRange: { startLine: 20, endLine: 22 },
    targetObjectId: 'ko_atkdef_linear',
    targetRevision: 3,
    summaryBasis: '依主定义段落摘要，已复审',
  };
  const relation = {
    edgeId: 'edge_dep_1',
    fromObjectId: 'ko_unit',
    toObjectId: 'ko_atkdef_linear',
    type: 'depends_on' as const,
    scopeKey: 'combat:pvp',
    evidenceIds: ['ev_cap'],
  };
  return {
    schemaVersion: 1,
    releaseId: 'rel_1',
    documents: [
      { docId: 'doc_rule', path: 'combat/atk-def.md' },
      { docId: 'doc_concept', path: 'combat/unit.md' },
    ],
    objects: [koA, koB],
    presentations: [summary],
    relations: [relation],
    evidence: [makeEvidence()],
    coverage: [
      {
        itemId: 'cov_cap',
        sourceRef: makeEvidence().sourceRef,
        category: 'formula',
        importance: 'important',
        disposition: 'mapped',
        targetObjectIds: ['ko_atkdef_linear'],
        reason: '上限公式已建对象',
      },
    ],
    migrations: [],
    previousObjectIds: ['ko_atkdef_linear'],
  };
}

function mutated(mutate: (m: KnowledgeManifest) => void): KnowledgeManifest {
  const manifest: KnowledgeManifest = structuredClone(legalManifest());
  mutate(manifest);
  return manifest;
}

function blockingCodes(manifest: KnowledgeManifest): string[] {
  return validateKnowledgeGraph(manifest).filter(isBlocking).map((issue) => issue.code);
}

function expectBlocking(mutatedManifest: KnowledgeManifest, code: string): void {
  const codes = blockingCodes(mutatedManifest);
  expect(codes).toContain(code);
}

// ============================================================================
// hash：确定性 + 敏感性（A 案 §2.3）
// ============================================================================

describe('computePayloadHash（A 案 §2.3）', () => {
  const body = [
    '## 攻防修正·线性方案',
    '',
    '攻防差每点提供 0.5% 修正，上限 30%。',
    '',
    '参见 [主定义](combat/atk-def.md#ko_unit) 与 <a id="ko_atkdef_linear"></a>锚点。',
  ].join('\n');

  it('确定性：同输入两次同值', () => {
    const object = makeObject();
    expect(computePayloadHash(object, body)).toBe(computePayloadHash(object, body));
  });

  it('敏感性：正文/claim/范围变化 → payloadHash 变化', () => {
    const base = computePayloadHash(makeObject(), body);
    expect(computePayloadHash(makeObject(), body.replace('0.5%', '1%'))).not.toBe(base);
    expect(computePayloadHash(makeObject({
      claims: [{ claimKey: 'advantage-cap', bodyRange: { startLine: 12, endLine: 14 }, riskCategory: 'high', evidenceIds: ['ev_cap'] }],
    }), body)).not.toBe(base);
    expect(computePayloadHash(makeObject({ scopeKey: 'combat:pve' }), body)).not.toBe(base);
    expect(computePayloadHash(makeObject({ scopeText: 'PvE 战斗' }), body)).not.toBe(base);
    expect(computePayloadHash(makeObject({ type: 'procedure' }), body)).not.toBe(base);
    expect(computePayloadHash(makeObject({ aliases: ['别名二', '线性攻防修正'] }), body)).not.toBe(base);
  });

  it('排除面：标题/时间戳/状态决定/审查结果/路径/修订号变化 → payloadHash 不变', () => {
    const base = computePayloadHash(makeObject(), body);
    expect(computePayloadHash(makeObject({ title: '完全另一个展示名' }), body)).toBe(base);
    expect(computePayloadHash(makeObject({ businessStatus: 'approved' }), body)).toBe(base);
    expect(computePayloadHash(makeObject({ reviewStatus: 'passed', reviewerId: 'human-1', reviewedAt: '2026-11-01T00:00:00Z' }), body)).toBe(base);
    expect(computePayloadHash(makeObject({ staleAfter: '2027-01-01T00:00:00Z' }), body)).toBe(base);
    expect(computePayloadHash(makeObject({ revision: 99, locationRevision: 5 }), body)).toBe(base);
    // diting F08：纯搬家——canonical 与 claim 范围同步平移，绝对行号不入哈希
    expect(computePayloadHash(makeObject({
      canonical: { docId: 'doc_other', path: 'moved.md', anchor: 'ko_atkdef_linear', bodyRange: { startLine: 1, endLine: 21 } },
      claims: [{ claimKey: 'advantage-cap', bodyRange: { startLine: 3, endLine: 4 }, riskCategory: 'high', evidenceIds: ['ev_cap'] }],
    }), body)).toBe(base);
    // 证据绑定变化只影响 reviewSubjectHash，不影响 payloadHash
    expect(computePayloadHash(makeObject({
      claims: [{ claimKey: 'advantage-cap', bodyRange: { startLine: 12, endLine: 13 }, riskCategory: 'high', evidenceIds: ['ev_other'] }],
    }), body)).toBe(base);
  });

  it('diting F08：claim 绝对行号不入 payloadHash——纯搬家不变，断言内容/范围变化仍失效', () => {
    const base = computePayloadHash(makeObject(), body);
    // 同一对象从文档行 10–30 搬到行 20–40，claim 同步平移 +10：hash 不变
    expect(computePayloadHash(makeObject({
      canonical: { docId: 'doc_rule', path: 'combat/atk-def.md', anchor: 'ko_atkdef_linear', bodyRange: { startLine: 20, endLine: 40 } },
      claims: [{ claimKey: 'advantage-cap', bodyRange: { startLine: 22, endLine: 23 }, riskCategory: 'high', evidenceIds: ['ev_cap'] }],
    }), body)).toBe(base);
    // 断言范围真实变化（相对范围拉长）→ hash 变化
    expect(computePayloadHash(makeObject({
      claims: [{ claimKey: 'advantage-cap', bodyRange: { startLine: 12, endLine: 15 }, riskCategory: 'high', evidenceIds: ['ev_cap'] }],
    }), body)).not.toBe(base);
    // 断言正文变化 → hash 变化
    expect(computePayloadHash(makeObject(), body.replace('0.5%', '1%'))).not.toBe(base);
    // 断言风险等级变化 → hash 变化
    expect(computePayloadHash(makeObject({
      claims: [{ claimKey: 'advantage-cap', bodyRange: { startLine: 12, endLine: 13 }, riskCategory: 'normal', evidenceIds: ['ev_cap'] }],
    }), body)).not.toBe(base);
  });

  it('正文规范化：剥标题行/服务端锚点；内部链接归一为目标 objectId', () => {
    const base = computePayloadHash(makeObject(), body);
    // 换标题（首行标题被剥离）
    expect(computePayloadHash(makeObject(), body.replace('攻防修正·线性方案', '新标题'))).toBe(base);
    // 去掉锚点标签
    expect(computePayloadHash(makeObject(), body.replace('<a id="ko_atkdef_linear"></a>', ''))).toBe(base);
    // 链接路径不同但 ko 目标相同 → 归一后一致
    expect(computePayloadHash(makeObject(), body.replace('combat/atk-def.md#ko_unit', 'any/other.md#ko_unit'))).toBe(base);
  });

  it('normalizeObjectBodyForPayload：旧式 heading 链接经映射表归一', () => {
    const withLegacy = '说明见 [单元](combat/unit.md#作战单元)。';
    expect(
      normalizeObjectBodyForPayload(withLegacy, { 'combat/unit.md#作战单元': 'ko_unit' }),
    ).toBe(normalizeObjectBodyForPayload('说明见 [单元](ko_unit)。'));
  });
});

describe('computeReviewSubjectHash（A 案 §2.3）', () => {
  const payloadHash = computePayloadHash(makeObject(), '正文');

  it('确定性：同输入两次同值', () => {
    const input = { payloadHash, evidence: [makeEvidence()], relations: [] };
    expect(computeReviewSubjectHash(input)).toBe(computeReviewSubjectHash(input));
  });

  it('敏感性：证据/关系/决策依据/入向呈现变化 → 变化；仅换证据登记顺序 → 不变', () => {
    const base = computeReviewSubjectHash({ payloadHash, evidence: [makeEvidence()], relations: [] });
    expect(computeReviewSubjectHash({
      payloadHash,
      evidence: [makeEvidence({ quoteHash: 'quote-hash-2' })],
      relations: [],
    })).not.toBe(base);
    expect(computeReviewSubjectHash({
      payloadHash,
      evidence: [],
      relations: [{
        edgeId: 'edge_dep_1', fromObjectId: 'ko_unit', toObjectId: 'ko_atkdef_linear',
        type: 'depends_on', scopeKey: 'combat:pvp', evidenceIds: ['ev_cap'],
      }],
    })).not.toBe(base);
    expect(computeReviewSubjectHash({ payloadHash, evidence: [], relations: [], decisionRefs: ['dec_1'] })).not.toBe(base);
    expect(computeReviewSubjectHash({
      payloadHash,
      evidence: [],
      relations: [],
      inboundPresentations: [{ presentationId: 'pres_summary_1', ownerObjectId: 'ko_unit', kind: 'summary', targetRevision: 3 }],
    })).not.toBe(base);
    // 登记顺序不影响（数组按稳定 ID 排序）
    const evA = makeEvidence();
    const evB = makeEvidence({ evidenceId: 'ev_zz', claimKey: 'advantage-cap' });
    expect(computeReviewSubjectHash({ payloadHash, evidence: [evA, evB], relations: [] }))
      .toBe(computeReviewSubjectHash({ payloadHash, evidence: [evB, evA], relations: [] }));
  });

  it('payloadHash 变化必然传导到 reviewSubjectHash（旧审查失效）', () => {
    const a = computeReviewSubjectHash({ payloadHash, evidence: [], relations: [] });
    const b = computeReviewSubjectHash({ payloadHash: `changed-${payloadHash}`, evidence: [], relations: [] });
    expect(a).not.toBe(b);
  });
});

// ============================================================================
// validateKnowledgeGraph：合法图零 blocking；逐错误码正反用例
// ============================================================================

describe('validateKnowledgeGraph（A 案 §7.4）', () => {
  it('正例：合法图零 blocking issue', () => {
    const issues = validateKnowledgeGraph(legalManifest());
    expect(issues.filter(isBlocking)).toEqual([]);
  });

  it('kb_object_duplicate：objectId 重复登记', () => {
    expectBlocking(mutated((m) => { m.objects.push(structuredClone(m.objects[0]!)); }), 'kb_object_duplicate');
  });

  it('kb_object_duplicate：同 familyKey+variantKey+scopeKey 重复登记', () => {
    expectBlocking(mutated((m) => {
      const b = m.objects[1]!;
      b.familyKey = m.objects[0]!.familyKey;
      b.variantKey = m.objects[0]!.variantKey;
      b.scopeKey = m.objects[0]!.scopeKey;
    }), 'kb_object_duplicate');
  });

  it('kb_object_duplicate：alias 歧义指向多对象', () => {
    expectBlocking(mutated((m) => { m.objects[1]!.aliases = [...m.objects[1]!.aliases, '线性攻防修正']; }), 'kb_object_duplicate');
  });

  it('kb_canonical_missing：活跃对象无 canonical', () => {
    expectBlocking(mutated((m) => { m.objects[0]!.canonical = null; }), 'kb_canonical_missing');
  });

  it('kb_canonical_missing：canonical 指向不存在文档', () => {
    expectBlocking(mutated((m) => { m.objects[0]!.canonical!.docId = 'doc_ghost'; }), 'kb_canonical_missing');
  });

  it('kb_canonical_missing：同对象多 canonical 呈现', () => {
    expectBlocking(mutated((m) => {
      m.presentations.push(
        { presentationId: 'pres_c1', ownerObjectId: 'ko_atkdef_linear', kind: 'canonical' },
        { presentationId: 'pres_c2', ownerObjectId: 'ko_atkdef_linear', kind: 'canonical' },
      );
    }), 'kb_canonical_missing');
  });

  it('kb_scope_unresolved：缺 scopeKey', () => {
    expectBlocking(mutated((m) => { m.objects[0]!.scopeKey = ''; }), 'kb_scope_unresolved');
  });

  it('kb_relation_invalid：非法关系词（related_to 逃生词）', () => {
    expectBlocking(mutated((m) => {
      m.relations[0]!.type = 'related_to' as never;
    }), 'kb_relation_invalid');
  });

  it('kb_relation_invalid：端点不存在', () => {
    expectBlocking(mutated((m) => { m.relations[0]!.toObjectId = 'ko_ghost'; }), 'kb_relation_invalid');
  });

  it('kb_relation_invalid：part_of 组成环', () => {
    expectBlocking(mutated((m) => {
      m.relations = [
        { edgeId: 'e1', fromObjectId: 'ko_unit', toObjectId: 'ko_atkdef_linear', type: 'part_of', scopeKey: 'combat:pvp', evidenceIds: [] },
        { edgeId: 'e2', fromObjectId: 'ko_atkdef_linear', toObjectId: 'ko_unit', type: 'part_of', scopeKey: 'combat:pvp', evidenceIds: [] },
      ];
    }), 'kb_relation_invalid');
  });

  it('kb_relation_invalid：supersedes 成环与缺人工决定分别命中', () => {
    expectBlocking(mutated((m) => {
      m.relations = [
        { edgeId: 'e1', fromObjectId: 'ko_unit', toObjectId: 'ko_atkdef_linear', type: 'supersedes', scopeKey: 'combat:pvp', evidenceIds: [] },
        { edgeId: 'e2', fromObjectId: 'ko_atkdef_linear', toObjectId: 'ko_unit', type: 'supersedes', scopeKey: 'combat:pvp', evidenceIds: [] },
      ];
    }), 'kb_relation_invalid');
    expectBlocking(mutated((m) => {
      m.relations = [
        { edgeId: 'e1', fromObjectId: 'ko_unit', toObjectId: 'ko_atkdef_linear', type: 'supersedes', scopeKey: 'combat:pvp', evidenceIds: [] },
      ];
    }), 'kb_relation_invalid');
  });

  it('kb_relation_invalid：conflicts_with 未按 ID 排序单份存储', () => {
    expect(isCanonicalConflictOrientation('ko_a', 'ko_b')).toBe(true);
    expect(isCanonicalConflictOrientation('ko_b', 'ko_a')).toBe(false);
    // ko_atkdef_linear < ko_unit（字典序）→ 正典方向 from=ko_atkdef_linear
    expectBlocking(mutated((m) => {
      m.relations = [
        { edgeId: 'e1', fromObjectId: 'ko_unit', toObjectId: 'ko_atkdef_linear', type: 'conflicts_with', scopeKey: 'combat:pvp', evidenceIds: [] },
      ];
    }), 'kb_relation_invalid');
  });

  it('kb_relation_invalid：restates 多定义（一个呈现位置重述多个主对象）', () => {
    expectBlocking(mutated((m) => {
      m.objects.push(makeObject({
        objectId: 'ko_tanh', variantKey: 'tanh', title: '攻防修正·tanh 方案',
      }));
      m.relations.push(
        { edgeId: 'r1', fromObjectId: 'ko_unit', toObjectId: 'ko_atkdef_linear', type: 'restates', scopeKey: 'combat:pvp', evidenceIds: [] },
        { edgeId: 'r2', fromObjectId: 'ko_unit', toObjectId: 'ko_tanh', type: 'restates', scopeKey: 'combat:pvp', evidenceIds: [] },
      );
    }), 'kb_relation_invalid');
  });

  it('kb_evidence_unresolved：高风险 claim 无证据', () => {
    expectBlocking(mutated((m) => { m.evidence = []; }), 'kb_evidence_unresolved');
  });

  it('kb_evidence_unresolved：evidence 的 objectId 不存在', () => {
    expectBlocking(mutated((m) => { m.evidence[0]!.objectId = 'ko_ghost'; }), 'kb_evidence_unresolved');
  });

  it('kb_restatement_stale：summary 目标 revision 落后于对象当前 revision', () => {
    expectBlocking(mutated((m) => {
      const summary = m.presentations.find((p) => p.kind === 'summary')!;
      summary.targetRevision = 2; // 对象当前 revision=3
    }), 'kb_restatement_stale');
  });

  it('kb_migration_invalid：迁移映射重复登记', () => {
    const entry: ObjectMigration = { objectId: 'ko_old', kind: 'remove', successorObjectIds: [], reason: '合并入主定义' };
    expectBlocking(mutated((m) => { m.migrations = [entry, { ...entry }]; }), 'kb_migration_invalid');
  });

  it('kb_migration_invalid：未解释的对象丢失（previousObjectIds 有而本 release 无且无映射）', () => {
    expectBlocking(mutated((m) => { m.previousObjectIds = ['ko_gone']; }), 'kb_migration_invalid');
  });

  it('kb_relation_invalid：迁移映射成环', () => {
    expectBlocking(mutated((m) => {
      m.migrations = [
        { objectId: 'ko_x', kind: 'merge', successorObjectIds: ['ko_y'], reason: 'r' },
        { objectId: 'ko_y', kind: 'merge', successorObjectIds: ['ko_x'], reason: 'r' },
      ];
    }), 'kb_relation_invalid');
  });

  it('kb_include_invalid：exact 目标缺失', () => {
    expectBlocking(mutated((m) => {
      m.presentations.push({ presentationId: 'pres_exact_1', ownerObjectId: 'ko_unit', kind: 'exact', targetObjectId: 'ko_ghost', targetRevision: 3, fragmentKey: 'formula' });
    }), 'kb_include_invalid');
  });

  it('kb_include_invalid：exact 递归 include（宿主↔目标成环）', () => {
    expectBlocking(mutated((m) => {
      m.presentations.push(
        { presentationId: 'pres_exact_1', ownerObjectId: 'ko_unit', kind: 'exact', targetObjectId: 'ko_atkdef_linear', targetRevision: 3, fragmentKey: 'formula' },
        { presentationId: 'pres_exact_2', ownerObjectId: 'ko_atkdef_linear', kind: 'exact', targetObjectId: 'ko_unit', targetRevision: 3, fragmentKey: 'intro' },
      );
    }), 'kb_include_invalid');
  });

  it('kb_include_invalid：exact 非 canonical 来源（目标无活跃 canonical）', () => {
    expectBlocking(mutated((m) => {
      m.objects.push(makeObject({ objectId: 'ko_orphan', canonical: null, tombstone: { reason: '并入主定义', successorObjectIds: ['ko_atkdef_linear'] } }));
      m.presentations.push({ presentationId: 'pres_exact_1', ownerObjectId: 'ko_unit', kind: 'exact', targetObjectId: 'ko_orphan', targetRevision: 1, fragmentKey: 'formula' });
    }), 'kb_include_invalid');
  });

  it('kb_presentation_invalid：link 目标缺失', () => {
    expectBlocking(mutated((m) => {
      m.presentations.push({ presentationId: 'pres_link_1', ownerObjectId: 'ko_unit', kind: 'link', targetObjectId: 'ko_ghost' });
    }), 'kb_presentation_invalid');
  });

  it('kb_coverage_invalid：已确认重要项无去向（unresolved）', () => {
    expectBlocking(mutated((m) => {
      m.coverage[0]!.disposition = 'unresolved';
    }), 'kb_coverage_invalid');
  });

  it('kb_coverage_invalid：mapped 目标对象不存在 / 无目标', () => {
    expectBlocking(mutated((m) => { m.coverage[0]!.targetObjectIds = ['ko_ghost']; }), 'kb_coverage_invalid');
    expectBlocking(mutated((m) => { m.coverage[0]!.targetObjectIds = []; }), 'kb_coverage_invalid');
  });

  it('warning 通道：普通 unresolved 与排除无理由为 warning，不阻断', () => {
    const issues = validateKnowledgeGraph(mutated((m) => {
      m.coverage = [
        { itemId: 'cov_bg', sourceRef: makeEvidence().sourceRef, category: 'background', importance: 'normal', disposition: 'unresolved', targetObjectIds: [] },
        { itemId: 'cov_tpl', sourceRef: makeEvidence().sourceRef, category: 'template', disposition: 'excluded_template', targetObjectIds: [], reason: '' },
      ];
    }));
    const codes = issues.filter((i) => !isBlocking(i)).map((i) => i.code);
    expect(codes).toContain('kb_coverage_invalid');
    expect(issues.filter(isBlocking)).toEqual([]);
  });
});

// ============================================================================
// B 案：reportCoversDraft / canPublish / 规格冻结
// ============================================================================

function makeReport(overrides: Partial<ReviewReport> = {}): ReviewReport {
  return {
    reportId: 'rep_1',
    buildId: 'bld_1',
    draftHash: 'HASH_DRAFT_1',
    coverage: { draftHashes: ['HASH_DRAFT_1'], sourceRefs: ['src_design'] },
    checkedDimensions: ['事实与数值', '条件与例外', '来源冲突'],
    issues: [],
    uncheckedScope: [],
    conclusion: 'pass',
    serverVersionTag: 'srv-v1',
    ...overrides,
  };
}

function makeCandidate(overrides: Partial<CandidateRelease> = {}): CandidateRelease {
  return {
    buildId: 'bld_1',
    documents: [{ path: 'combat/atk-def.md', contentHash: 'HASH_DRAFT_1' }],
    acceptance: {
      acceptanceId: 'acc_1',
      acceptedArtifactHash: 'HASH_DRAFT_1',
      validReportIds: ['rep_1'],
      programChecks: { passed: true, checkIds: ['struct', 'coverage'] },
      decisionMode: 'auto',
    },
    carriedOver: [],
    sourceDisposition: [{ sourceId: 'src_design', disposition: 'mapped' }],
    changeSummary: '本轮变更已审查',
    sourceSnapshotHash: 'SNAP_1',
    baseReleaseId: 'rel_prev',
    publishMode: 'auto',
    ...overrides,
  };
}

const publishCheckDefaults = {
  reports: [] as ReviewReport[],
  requiredReviewDraftHashes: ['HASH_DRAFT_1'],
  expectedSourceSnapshotHash: 'SNAP_1',
  expectedBaseReleaseId: 'rel_prev' as string | null,
};

describe('reportCoversDraft（B 案 §5/§9）', () => {
  it('报告只覆盖其绑定的草稿版本：同 hash 通过、不同 hash 拒绝', () => {
    const report = makeReport();
    expect(reportCoversDraft(report, 'HASH_DRAFT_1')).toBe(true);
    expect(reportCoversDraft(report, 'HASH_DRAFT_2')).toBe(false);
  });
});

describe('canPublish（B 案 §7 发布条件）', () => {
  it('正例：全条件满足 → publishable', () => {
    const result = canPublish({
      candidate: makeCandidate(),
      ...publishCheckDefaults,
      reports: [makeReport()],
    });
    expect(result.publishable).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  it('旧报告不能批准新稿：报告绑定旧 hash → review_missing', () => {
    const result = canPublish({
      candidate: makeCandidate(),
      ...publishCheckDefaults,
      reports: [makeReport({ draftHash: 'HASH_OLD', conclusion: 'pass' })],
    });
    expect(result.publishable).toBe(false);
    expect(result.reasons).toContain('review_missing');
  });

  it('缺报告不放行：验收引用的报告不存在 → missing_report', () => {
    const result = canPublish({
      candidate: makeCandidate(),
      ...publishCheckDefaults,
      reports: [],
    });
    expect(result.publishable).toBe(false);
    expect(result.reasons).toContain('missing_report');
  });

  it('阻断未关不放行：closureBasis 为空的 blocking issue → blocking_issue_open', () => {
    const openIssue = {
      issueId: 'iss_1',
      draftLocation: 'combat/atk-def.md:12',
      sourceLocation: '200-战斗拼点设计（R）.md:5',
      description: '上限数值与原文不符',
      severity: 'blocking' as const,
      revisionResponse: 'fixed' as const,
    };
    const result = canPublish({
      candidate: makeCandidate(),
      ...publishCheckDefaults,
      reports: [makeReport({ issues: [openIssue] })],
    });
    expect(result.publishable).toBe(false);
    expect(result.reasons).toContain('blocking_issue_open');
    // 撰写者回应 fixed 不构成关闭；审查复核写入 closureBasis 后才关闭
    const closed = canPublish({
      candidate: makeCandidate(),
      ...publishCheckDefaults,
      reports: [makeReport({ issues: [{ ...openIssue, closureBasis: '复核已确认修正' }] })],
    });
    expect(closed.publishable).toBe(true);
  });

  it('suggestion 级问题未关闭不阻断', () => {
    const result = canPublish({
      ...publishCheckDefaults,
      candidate: makeCandidate(),
      reports: [makeReport({
        issues: [{ issueId: 'iss_s1', draftLocation: 'x:1', description: '排版建议', severity: 'suggestion' }],
      })],
    });
    expect(result.publishable).toBe(true);
  });

  it('程序检查未通过 → program_check_failed', () => {
    const result = canPublish({
      candidate: makeCandidate({
        acceptance: {
          acceptanceId: 'acc_1', acceptedArtifactHash: 'HASH_DRAFT_1', validReportIds: ['rep_1'],
          programChecks: { passed: false, checkIds: ['struct'], failed: ['struct'] }, decisionMode: 'auto',
        },
      }),
      ...publishCheckDefaults,
      reports: [makeReport()],
    });
    expect(result.reasons).toContain('program_check_failed');
  });

  it('源快照/基准版本变化 → source_snapshot_mismatch / base_release_changed', () => {
    expect(canPublish({
      candidate: makeCandidate(), ...publishCheckDefaults,
      reports: [makeReport()], expectedSourceSnapshotHash: 'SNAP_2',
    }).reasons).toContain('source_snapshot_mismatch');
    expect(canPublish({
      candidate: makeCandidate(), ...publishCheckDefaults,
      reports: [makeReport()], expectedBaseReleaseId: 'rel_changed',
    }).reasons).toContain('base_release_changed');
  });

  it('沿用未标记：候选文档既非必审也未显式沿用 → carry_over_unmarked', () => {
    const result = canPublish({
      candidate: makeCandidate({
        documents: [
          { path: 'combat/atk-def.md', contentHash: 'HASH_DRAFT_1' },
          { path: 'legacy/old.md', contentHash: 'HASH_LEGACY' },
        ],
      }),
      ...publishCheckDefaults,
      reports: [makeReport()],
    });
    expect(result.reasons).toContain('carry_over_unmarked');
    // 显式沿用（含 priorReview 标记）后放行
    const fixed = canPublish({
      candidate: makeCandidate({
        documents: [
          { path: 'combat/atk-def.md', contentHash: 'HASH_DRAFT_1' },
          { path: 'legacy/old.md', contentHash: 'HASH_LEGACY' },
        ],
        carriedOver: [{ path: 'legacy/old.md', priorReview: 'never_reviewed' }],
      }),
      ...publishCheckDefaults,
      reports: [makeReport()],
    });
    expect(fixed.publishable).toBe(true);
  });

  it('confirm 模式：确认绑定候选哈希，内容变化使确认失效', () => {
    const candidate = makeCandidate({ publishMode: 'confirm' });
    const confirmBinding = { candidateHash: computeCandidateHash(candidate), confirmedAt: '2026-11-01T00:00:00Z', actor: 'user' };
    expect(canPublish({
      candidate: { ...candidate, confirmBinding }, ...publishCheckDefaults,
      reports: [makeReport()],
    }).publishable).toBe(true);
    // 内容变化（新增文档）后旧确认失效
    const changed: CandidateRelease = {
      ...candidate,
      documents: [...candidate.documents, { path: 'new.md', contentHash: 'HASH_NEW' }],
      confirmBinding,
    };
    const result = canPublish({
      candidate: changed,
      ...publishCheckDefaults,
      reports: [makeReport()],
      requiredReviewDraftHashes: ['HASH_DRAFT_1', 'HASH_NEW'],
    });
    expect(result.reasons).toContain('confirm_binding_stale');
  });

  it('材料去向缺失 → source_disposition_missing', () => {
    const result = canPublish({
      candidate: makeCandidate({ sourceDisposition: [{ sourceId: 'src_design', disposition: '' }] }),
      ...publishCheckDefaults,
      reports: [makeReport()],
    });
    expect(result.reasons).toContain('source_disposition_missing');
  });
});

describe('BuildSpec 冻结与修订预算（B 案 §5/§8）', () => {
  it('computeBuildSpecHash：同规格同哈希；任一字段变化 → 新哈希', () => {
    const spec: Omit<BuildSpec, 'specHash'> = {
      buildId: 'bld_1', sourceSnapshotId: 'snap-1', sourceSnapshotHash: 'SNAP_1',
      baseReleaseId: 'rel_prev',
      roles: { writer: { modelPresetId: '' }, reviewer: { modelPresetId: 'glm-4.7' }, plannerEnabled: false },
      specVersion: 'spec-v1', concurrency: 5, maxAutoRevisions: 2, maxInterfaceRetries: 2, publishMode: 'auto',
    };
    expect(computeBuildSpecHash(spec)).toBe(computeBuildSpecHash(spec));
    expect(computeBuildSpecHash({ ...spec, concurrency: 4 })).not.toBe(computeBuildSpecHash(spec));
    expect(computeBuildSpecHash({ ...spec, roles: { ...spec.roles, reviewer: { modelPresetId: 'glm-5' } } }))
      .not.toBe(computeBuildSpecHash(spec));
  });

  it('revisionBudgetExhausted：累计预算不因换稿重置', () => {
    expect(revisionBudgetExhausted({ usedAutoRevisions: 1, maxAutoRevisions: 2 })).toBe(false);
    expect(revisionBudgetExhausted({ usedAutoRevisions: 2, maxAutoRevisions: 2 })).toBe(true);
    expect(revisionBudgetExhausted({ usedAutoRevisions: 3, maxAutoRevisions: 2 })).toBe(true);
  });
});

// ============================================================================
// config：默认值 / 校验 / round-trip（agent-knowledge.ts + config-manager.ts）
// ============================================================================

describe('StandardKbConfig 新字段默认值与解析（B 案 §3/§5/§6/§7/§8）', () => {
  it('buildDefaultStandardKbConfig：角色/预算/发布方式默认值；buildConcurrency 不落默认', () => {
    const config = buildDefaultStandardKbConfig('/tmp/data');
    expect(config.buildRoles?.writer.modelPresetId).toBe('');
    expect(config.buildRoles?.reviewer.modelPresetId).toBe('');
    expect(config.buildRoles?.plannerEnabled).toBe(false);
    expect(config.reviewPolicy).toEqual({ maxAutoRevisions: 2, maxInterfaceRetries: 2 });
    expect(config.publishMode).toBe('auto');
    expect(config.buildConcurrency).toBeUndefined();
    // 既有字段不动
    expect(config.buildParallelism).toBe(2);
  });

  it('resolveBuildConcurrency：buildConcurrency 优先，未设回落 buildParallelism，越界钳制', () => {
    expect(resolveBuildConcurrency({ buildParallelism: 3 })).toBe(3);
    expect(resolveBuildConcurrency({ buildParallelism: 3, buildConcurrency: 5 })).toBe(5);
    expect(resolveBuildConcurrency({ buildParallelism: 3, buildConcurrency: 99 })).toBe(8);
    expect(resolveBuildConcurrency({ buildParallelism: 3, buildConcurrency: 0 })).toBe(1);
  });
});

describe('validateAgentAndKbConfig 新字段严格校验', () => {
  it('合法新字段通过', () => {
    expect(() => validateAgentAndKbConfig({
      standardKb: {
        buildConcurrency: 5,
        publishMode: 'confirm',
        reviewPolicy: { maxAutoRevisions: 3, maxInterfaceRetries: 1 },
        buildRoles: {
          writer: { modelPresetId: 'glm-4.7', thinking: 'high' },
          reviewer: { modelPresetId: 'glm-4.7', thinking: 'off' },
        },
      },
    })).not.toThrow();
  });

  it('buildConcurrency 越界 / publishMode 非法 / 预算越界 / thinking 非法分别报错', () => {
    expect(() => validateAgentAndKbConfig({ standardKb: { buildConcurrency: 9 } })).toThrowError(/buildConcurrency/);
    expect(() => validateAgentAndKbConfig({ standardKb: { publishMode: 'yes' as never } })).toThrowError(/publishMode/);
    expect(() => validateAgentAndKbConfig({ standardKb: { reviewPolicy: { maxAutoRevisions: 6 } } })).toThrowError(/maxAutoRevisions/);
    expect(() => validateAgentAndKbConfig({ standardKb: { reviewPolicy: { maxInterfaceRetries: 6 } } })).toThrowError(/maxInterfaceRetries/);
    expect(() => validateAgentAndKbConfig({
      standardKb: { buildRoles: { writer: { modelPresetId: 'x', thinking: 'ultra' as never } } },
    })).toThrowError(/thinking/);
    expect(() => validateAgentAndKbConfig({
      standardKb: { buildRoles: { writer: null as never } },
    })).toThrowError(/writer/);
  });
});

const tempConfigDirs: string[] = [];

function createTempConfigPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-sync-kb-schema-'));
  tempConfigDirs.push(dir);
  return path.join(dir, 'config.json');
}

afterEach(() => {
  while (tempConfigDirs.length > 0) {
    const dir = tempConfigDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('ConfigManager round-trip（standardKb 新字段宽容归一与持久化）', () => {
  it('updateConfig 保存新字段 → load 回读一致；非法值在严格校验被拒', async () => {
    const manager = new ConfigManager(createTempConfigPath());
    const saved = await manager.updateConfig({
      standardKb: {
        buildConcurrency: 5,
        publishMode: 'confirm',
        reviewPolicy: { maxAutoRevisions: 3 },
        buildRoles: {
          writer: { modelPresetId: 'glm-4.7', thinking: 'high' },
          reviewer: { modelPresetId: 'glm-4.7' },
          plannerEnabled: true,
        },
      },
    });
    expect(saved.standardKb.buildConcurrency).toBe(5);
    expect(saved.standardKb.publishMode).toBe('confirm');
    expect(saved.standardKb.reviewPolicy).toEqual({ maxAutoRevisions: 3, maxInterfaceRetries: 2 });
    expect(saved.standardKb.buildRoles?.writer).toEqual({ modelPresetId: 'glm-4.7', thinking: 'high' });
    expect(saved.standardKb.buildRoles?.plannerEnabled).toBe(true);

    // 重新 load（走 normalizeStandardKbConfigLoose）保持语义
    const reloaded = await manager.load();
    expect(reloaded.standardKb.buildConcurrency).toBe(5);
    expect(reloaded.standardKb.buildRoles?.writer.thinking).toBe('high');
    expect(resolveBuildConcurrency(reloaded.standardKb)).toBe(5);

    // 非法值拒绝
    await expect(manager.updateConfig({ standardKb: { buildConcurrency: 99 } })).rejects.toThrow();
  });

  it('旧配置（无新字段）加载后回落默认且 buildConcurrency 保持未设（回落 buildParallelism）', async () => {
    const configPath = createTempConfigPath();
    const legacy = {
      llm: { openAiCompatBaseUrl: 'https://open.bigmodel.cn/api/paas/v4', apiKey: '', model: 'glm-4-flash', temperature: 0.2 },
      standardKb: { outputRoot: '/tmp/legacy-kb', buildParallelism: 4 },
    };
    fs.writeFileSync(configPath, JSON.stringify(legacy));
    const manager = new ConfigManager(configPath);
    const config = await manager.load();
    expect(config.standardKb.buildParallelism).toBe(4);
    expect(config.standardKb.buildConcurrency).toBeUndefined();
    expect(resolveBuildConcurrency(config.standardKb)).toBe(4);
    expect(config.standardKb.publishMode).toBe('auto');
    expect(config.standardKb.reviewPolicy).toEqual({ maxAutoRevisions: 2, maxInterfaceRetries: 2 });
  });
});

// ============================================================================
// manifest v2（A 案 §10.2）
// ============================================================================

describe('KbManifest v2 组织段', () => {
  const v1Manifest: KbManifest = {
    schemaVersion: 1,
    releaseId: 'rel_1',
    buildId: 'bld_1',
    mode: 'incremental',
    baseReleaseId: null,
    publishedAt: '2026-11-01T00:00:00Z',
    model: null,
    sourceSnapshot: [],
    docs: [],
    skippedSources: [],
  };

  it('v1：无新字段兼容，JSON round-trip 不产生 v2 判定', () => {
    expect(isKbManifestV2(v1Manifest)).toBe(false);
    const roundTripped = JSON.parse(JSON.stringify(v1Manifest)) as KbManifest;
    expect(roundTripped.organization).toBeUndefined();
    expect(roundTripped.evidence).toBeUndefined();
    expect(roundTripped.governance).toBeUndefined();
    expect(isKbManifestV2(roundTripped)).toBe(false);
  });

  it('v2：schemaVersion:2 且必含 organization；可选段 round-trip 保真', () => {
    const v2Manifest: KbManifest = {
      ...v1Manifest,
      schemaVersion: KB_MANIFEST_SCHEMA_V2,
      organization: { schemaVersion: 1, path: 'knowledge.json', hash: 'org-hash-1', coverageMode: 'mixed' },
      evidence: { resourcesPath: 'evidence-resources.json', hash: 'ev-hash-1' },
      governance: { path: 'governance.json', hash: 'gov-hash-1' },
    };
    expect(isKbManifestV2(v2Manifest)).toBe(true);
    const roundTripped = JSON.parse(JSON.stringify(v2Manifest)) as KbManifest;
    expect(roundTripped.organization).toEqual(v2Manifest.organization);
    expect(roundTripped.evidence).toEqual(v2Manifest.evidence);
    expect(roundTripped.governance).toEqual(v2Manifest.governance);
    expect(isKbManifestV2(roundTripped)).toBe(true);
  });

  it('schemaVersion:2 但缺 organization → 不判为 v2（非法 v2 防静默误用）', () => {
    expect(isKbManifestV2({ ...v1Manifest, schemaVersion: 2 })).toBe(false);
  });
});
