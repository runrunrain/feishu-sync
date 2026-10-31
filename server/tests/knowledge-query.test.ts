/**
 * T4b：检索与消费端（A案 §8 检索与阅读契约）
 *
 * 覆盖：对象级查询（objectId 直取/过滤/compare 并列）、usage 三态
 * （browse 全量+legacy-unclassified / operational 资格与原因计数 /
 * compare 同族并列）、关系扩展（direct/related 分离、预算截断+remaining、
 * 去重、冲突/取代提示）、状态过滤泄漏防护（被过滤章节不产 snippet、
 * summary 改对象摘要）、游标绑定过滤参数与 evaluatedAt、v1 release 全兼容
 * （legacy 提示不报错、全文检索照常、sidecar 损坏透传不降级）。
 * 全部合成 fixture，无模型调用。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { KbQueryService } from '../src/kb/search/kb-query-service.js';
import { AgentToolService } from '../src/agent/agent-tool-service.js';
import { kbRoutes, type KbRouteDeps } from '../src/routes/kb.js';
import { writeSearchRelease } from './helpers/kb-search-fixture.js';
import { writeKnowledgeRelease } from './helpers/kb-knowledge-fixture.js';
import type { KnowledgeManifest, KnowledgeObject } from '../src/kb/knowledge-schema.js';

const FUTURE = '2099-01-01T00:00:00Z';
const PAST = '2020-01-01T00:00:00Z';

const DAMAGE_BODY = [
  '# 伤害结算', '## 普攻伤害公式', '普攻伤害 = 攻击力 × 攻击系数，上限 300%。', '公式适用于所有作战单元。',
  '## 攻防修正·线性', '线性方案：修正 = 系数 × 差值。', '## 攻防修正·tanh', 'tanh 方案：修正 = tanh(差值)。',
  '## 背景说明', '历史设计背景，未纳管对象。',
].join('\n');
const MODIFIER_BODY = [
  '# 攻防修正', '## 基础修正规则', '基础修正在伤害计算前生效。', '## 依赖失效示例', '本规则依赖候选规则。',
  '## 已过期高风险', '本规则已超过复核期。', '## 已过期普通', '本规则超过复核期但无高风险断言。',
].join('\n');
const DECISION_BODY = ['# 攻防修正选型', '## 选型说明', '当前候选并存，尚无采用决定。'].join('\n');
const OVERVIEW_BODY = ['# 战斗总览', '## 战斗组成', '战斗由多个系统组成。'].join('\n');
const EXT_LINES = ['# 关系扩展', '中心对象甲内容。', '中心对象乙内容。',
  ...Array.from({ length: 8 }, (_, i) => `目标${'一二三四五六七八'[i]}内容。`),
  ...Array.from({ length: 6 }, (_, i) => `长目标${i + 1}内容。`),
  '共享目标内容。'];
const EXT_BODY = EXT_LINES.join('\n');
// 扩展.md 行号：2=hub甲 3=hub乙 4..11=t1..t8 12..17=c1..c6 18=shared

function makeObject(objectId: string, title: string, docId: string, docPath: string, startLine: number, endLine: number, overrides: Partial<KnowledgeObject> = {}): KnowledgeObject {
  return {
    objectId, type: 'rule', title, aliases: [], domainIds: [],
    familyKey: `fam:${objectId}`, variantKey: 'default', scopeKey: 'combat-global', scopeText: '战斗全局',
    canonical: { docId, path: docPath, anchor: objectId, bodyRange: { startLine, endLine } },
    revision: 1, locationRevision: 0, payloadHash: `sha256:${objectId}`, reviewSubjectHash: `sha256:r:${objectId}`,
    businessStatus: 'approved', reviewStatus: 'passed', claims: [],
    ...overrides,
  };
}

function buildKnowledge(): KnowledgeManifest {
  const objects: KnowledgeObject[] = [
    makeObject('ko_damage', '普攻伤害公式', 'kd_damage', '战斗/伤害.md', 2, 4, {
      staleAfter: FUTURE,
      domainIds: ['combat'],
      claims: [{ claimKey: 'cap-300', bodyRange: { startLine: 3, endLine: 3 }, riskCategory: 'high', evidenceIds: ['kev_damage'] }],
    }),
    makeObject('ko_lin', '攻防修正·线性方案', 'kd_damage', '战斗/伤害.md', 5, 6, {
      businessStatus: 'candidate', reviewStatus: 'pending', domainIds: ['combat'], familyKey: 'fam:modifier', variantKey: 'linear',
    }),
    makeObject('ko_tanh', '攻防修正·tanh方案', 'kd_damage', '战斗/伤害.md', 7, 8, {
      businessStatus: 'candidate', reviewStatus: 'pending', familyKey: 'fam:modifier', variantKey: 'tanh',
    }),
    makeObject('ko_dec', '攻防修正选型', 'kd_decision', '战斗/决策.md', 2, 3, {
      type: 'decision', businessStatus: 'unknown', reviewStatus: 'pending', familyKey: 'fam:modifier', variantKey: 'decision',
    }),
    makeObject('ko_base', '基础修正规则', 'kd_modifier', '战斗/修正.md', 2, 3, { staleAfter: FUTURE }),
    makeObject('ko_dep_broken', '依赖失效示例', 'kd_modifier', '战斗/修正.md', 4, 5, {}),
    makeObject('ko_overdue_high', '已过期高风险', 'kd_modifier', '战斗/修正.md', 6, 7, {
      staleAfter: PAST,
      claims: [{ claimKey: 'high-1', bodyRange: { startLine: 7, endLine: 7 }, riskCategory: 'high', evidenceIds: [] }],
    }),
    makeObject('ko_overdue_normal', '已过期普通', 'kd_modifier', '战斗/修正.md', 8, 9, { staleAfter: PAST }),
    makeObject('ko_combat', '战斗组成', 'kd_overview', '战斗/总览.md', 2, 3, { type: 'overview', domainIds: ['meta'] }),
    // 关系扩展预算：hub甲 8 个 depends_on 目标（>6 → max_objects）；hub乙 6 个长 scopeText 目标（→ max_chars）
    makeObject('ko_hub', '中心对象甲', 'kd_ext', '战斗/扩展.md', 2, 2, {}),
    ...Array.from({ length: 8 }, (_, i) => makeObject(`ko_t${i + 1}`, `目标${'一二三四五六七八'[i]}`, 'kd_ext', '战斗/扩展.md', 4 + i, 4 + i)),
    makeObject('ko_hub_chars', '中心对象乙', 'kd_ext', '战斗/扩展.md', 3, 3, {}),
    ...Array.from({ length: 6 }, (_, i) => makeObject(`ko_c${i + 1}`, `长目标${i + 1}`, 'kd_ext', '战斗/扩展.md', 12 + i, 12 + i, { scopeText: '范围说明'.repeat(280) })),
    // 去重：同一目标同时 depends_on 与 part_of
    makeObject('ko_dedupe', '去重示例', 'kd_ext', '战斗/扩展.md', 3, 3, { objectId: 'ko_dedupe', title: '去重示例' }),
    makeObject('ko_shared', '共享目标', 'kd_ext', '战斗/扩展.md', 18, 18, {}),
    // tombstone：browse 不列；直取返回迁移信息
    { ...makeObject('ko_dead', '已合并对象', 'kd_damage', '战斗/伤害.md', 1, 1), canonical: null,
      tombstone: { reason: '内容并入伤害公式', successorObjectIds: ['ko_damage'] } },
  ];
  return {
    schemaVersion: 1,
    releaseId: 'r_kq',
    documents: [
      { docId: 'kd_damage', path: '战斗/伤害.md' }, { docId: 'kd_modifier', path: '战斗/修正.md' },
      { docId: 'kd_decision', path: '战斗/决策.md' }, { docId: 'kd_overview', path: '战斗/总览.md' },
      { docId: 'kd_ext', path: '战斗/扩展.md' },
    ],
    objects,
    presentations: [],
    relations: [
      { edgeId: 'ke_dep_ok', fromObjectId: 'ko_damage', toObjectId: 'ko_base', type: 'depends_on', scopeKey: 'combat-global', evidenceIds: [] },
      { edgeId: 'ke_dep_broken', fromObjectId: 'ko_dep_broken', toObjectId: 'ko_lin', type: 'depends_on', scopeKey: 'combat-global', evidenceIds: [] },
      { edgeId: 'ke_part', fromObjectId: 'ko_damage', toObjectId: 'ko_combat', type: 'part_of', scopeKey: 'combat-global', evidenceIds: [] },
      { edgeId: 'ke_conf', fromObjectId: 'ko_lin', toObjectId: 'ko_tanh', type: 'conflicts_with', scopeKey: 'combat-global', evidenceIds: [] },
      { edgeId: 'ke_sup', fromObjectId: 'ko_tanh', toObjectId: 'ko_lin', type: 'supersedes', scopeKey: 'combat-global', evidenceIds: [], decisionRef: 'dec:modifier-1' },
      ...Array.from({ length: 8 }, (_, i) => ({ edgeId: `ke_hub_t${i + 1}`, fromObjectId: 'ko_hub', toObjectId: `ko_t${i + 1}`, type: 'depends_on' as const, scopeKey: 'combat-global', evidenceIds: [] })),
      ...Array.from({ length: 6 }, (_, i) => ({ edgeId: `ke_hub_c${i + 1}`, fromObjectId: 'ko_hub_chars', toObjectId: `ko_c${i + 1}`, type: 'depends_on' as const, scopeKey: 'combat-global', evidenceIds: [] })),
      { edgeId: 'ke_dd_dep', fromObjectId: 'ko_dedupe', toObjectId: 'ko_shared', type: 'depends_on', scopeKey: 'combat-global', evidenceIds: [] },
      { edgeId: 'ke_dd_part', fromObjectId: 'ko_dedupe', toObjectId: 'ko_shared', type: 'part_of', scopeKey: 'combat-global', evidenceIds: [] },
    ],
    evidence: [{
      evidenceId: 'kev_damage', objectId: 'ko_damage', claimKey: 'cap-300',
      sourceRef: { sourceId: 'fixture', sourceSnapshotHash: 'sha256:fixture', resourceId: 'fixture', resourceHash: 'sha256:fixture' },
      selector: { kind: 'text_span', lineStart: 3, lineEnd: 3, colStart: 1, colEnd: 20, headingPath: ['伤害结算'] },
      quoteHash: 'sha256:quote', role: 'supports', nature: 'direct',
    }],
    coverage: [], migrations: [],
  };
}

function fixtureDocs() {
  return [
    { path: '战斗/伤害.md', title: '伤害结算', docId: 'kd_damage', summary: '混状态文档摘要', body: DAMAGE_BODY },
    { path: '战斗/修正.md', title: '攻防修正', docId: 'kd_modifier', body: MODIFIER_BODY },
    { path: '战斗/决策.md', title: '攻防修正选型', docId: 'kd_decision', body: DECISION_BODY },
    { path: '战斗/总览.md', title: '战斗总览', docId: 'kd_overview', body: OVERVIEW_BODY },
    { path: '战斗/扩展.md', title: '关系扩展', docId: 'kd_ext', body: EXT_BODY },
  ];
}

let home: string, service: KbQueryService;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-knowledge-query-'));
  writeKnowledgeRelease(home, 'r_kq', fixtureDocs(), buildKnowledge());
  // 同根目录并存 v1 release：验证按 releaseId 双读
  writeSearchRelease(home, 'r_v1', [{ path: '旧/文档.md', title: '旧文档', body: '# 旧文档\n## 旧节\n旧内容伤害说明。\n' }], false);
  service = new KbQueryService(home, { prewarm: false });
});
afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

/** 按预算分页取尽对象列表（行较大时单页装不下全部） */
async function allObjects(service: KbQueryService, params: Record<string, unknown>): Promise<Awaited<ReturnType<KbQueryService['objects']>>['objects']> {
  const rows: Awaited<ReturnType<KbQueryService['objects']>>['objects'] = [];
  let cursor: string | undefined;
  do {
    const page = await service.objects({ ...params, cursor });
    rows.push(...page.objects);
    cursor = page.next ?? undefined;
  } while (cursor);
  return rows;
}

describe('A案 §8.1 对象级查询：objectId 直取与过滤', () => {
  it('getObject 直取：对象+canonical 片段+状态+证据列表；候选带 caution；tombstone 带迁移信息', async () => {
    const read = await service.getObject({ objectId: 'ko_damage' });
    expect(read.releaseId).toBe('r_kq');
    expect(read.object).toMatchObject({ objectId: 'ko_damage', businessStatus: 'approved', reviewStatus: 'passed',
      type: 'rule', familyKey: 'fam:ko_damage', matchType: 'object_id',
      canonical: { docId: 'kd_damage', path: '战斗/伤害.md', bodyRange: { startLine: 2, endLine: 4 } },
      evidenceCount: 1, evidenceGaps: [], freshness: { state: 'fresh', staleAfter: FUTURE } });
    expect(read.object!.snippet).toContain('上限 300%');
    expect(read.object!.caution).toBeUndefined();
    expect(read.evidence).toHaveLength(1);
    expect(read.evidence[0]).toMatchObject({ evidenceId: 'kev_damage', claimKey: 'cap-300', role: 'supports', nature: 'direct' });
    expect(read.evidence[0]!.locator).toContain('L3');
    expect(read.evidence[0]!.locator).toContain('伤害结算');
    expect(read.evidenceNote).toContain('发布');

    const candidate = await service.getObject({ objectId: 'ko_lin' });
    expect(candidate.object!.businessStatus).toBe('candidate');
    expect(candidate.object!.caution).toContain('禁止直接作为现行规则执行');
    expect(candidate.object!.freshness).toMatchObject({ state: 'not_scheduled', staleAfter: null });

    const dead = await service.getObject({ objectId: 'ko_dead' });
    expect(dead.object!.tombstone).toEqual({ reason: '内容并入伤害公式', successorObjectIds: ['ko_damage'] });
    expect(dead.object!.canonical).toBeNull();

    await expect(service.getObject({ objectId: 'ko_ghost' })).rejects.toMatchObject({ code: 'kb_not_found' });
  });

  it('objects browse 全量：tombstone 除外，逐对象带业务/审查/新鲜度标签', async () => {
    const rows = await allObjects(service, { usage: 'browse', limit: 100 });
    const ids = rows.map((row) => row.objectId);
    expect(ids).not.toContain('ko_dead');
    expect(ids).toContain('ko_damage');
    expect(ids).toContain('ko_t8');
    const byId = new Map(rows.map((row) => [row.objectId, row]));
    expect(byId.get('ko_damage')!.matchType).toBe('filter');
    expect(byId.get('ko_damage')!.freshness.state).toBe('fresh');
    expect(byId.get('ko_overdue_high')!.freshness.state).toBe('overdue');
    expect(byId.get('ko_overdue_high')!.evidenceGaps).toEqual(['high-1']);
    expect(byId.get('ko_lin')!.freshness.state).toBe('not_scheduled');
  });

  it('types/domainIds/businessStatuses/reviewStatuses 过滤与参数互斥校验', async () => {
    const rules = await allObjects(service, { types: ['rule'], limit: 100 });
    expect(rules.map((r) => r.type)).toEqual(rules.map(() => 'rule'));
    expect(rules.some((r) => r.objectId === 'ko_combat' || r.objectId === 'ko_dec')).toBe(false);
    const approved = await allObjects(service, { businessStatuses: ['approved'], limit: 100 });
    expect(approved.every((r) => r.businessStatus === 'approved')).toBe(true);
    expect(approved.some((r) => r.objectId === 'ko_lin')).toBe(false);
    const meta = await allObjects(service, { domainIds: ['meta'], limit: 100 });
    expect(meta.map((r) => r.objectId)).toEqual(['ko_combat']);
    const reviewed = await allObjects(service, { reviewStatuses: ['pending'], limit: 100 });
    expect(reviewed.every((r) => r.reviewStatus === 'pending')).toBe(true);

    await expect(service.objects({ objectId: 'ko_damage', familyKey: 'fam:modifier' })).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(service.objects({ objectId: 'ko_damage', types: ['rule'] })).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(service.objects({ usage: 'compare' })).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(service.objects({ usage: 'compare', familyKey: 'fam:modifier', types: ['rule'] })).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(service.objects({ usage: 'operational', familyKey: 'fam:x' })).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(service.objects({ usage: 'weird' as 'browse' })).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(service.objects({ types: ['nonsense' as 'rule'] })).rejects.toMatchObject({ code: 'invalid_request' });
  });
});

describe('A案 §8.1 usage=operational：资格过滤与原因计数', () => {
  it('approved+passed 通过；candidate/依赖不可用/高风险 overdue 排除；excluded 计数', async () => {
    const rows = await allObjects(service, { usage: 'operational', limit: 100 });
    const ids = rows.map((row) => row.objectId);
    expect(ids).toContain('ko_damage');
    expect(ids).toContain('ko_base');
    expect(ids).toContain('ko_overdue_normal'); // 到期只提醒复核，无高风险断言不排除（A案 §4.4）
    expect(ids).not.toContain('ko_lin');
    expect(ids).not.toContain('ko_dec');
    expect(ids).not.toContain('ko_dep_broken');
    expect(ids).not.toContain('ko_overdue_high');
    // 全量页同时携带原因计数（不需分页即可断言）
    const first = await service.objects({ usage: 'operational', limit: 100 });
    expect(first.excluded).toMatchObject({ not_approved: 3, dependency_unavailable: 1, high_risk_overdue: 1 });
    expect(rows.every((row) => row.businessStatus === 'approved' && row.reviewStatus === 'passed')).toBe(true);
  });

  it('无结果时返回原因计数与回源提示，不自动退回 candidate', async () => {
    const page = await service.objects({ usage: 'operational', businessStatuses: ['candidate'], limit: 100 });
    expect(page.objects).toEqual([]);
    expect(page.excluded).toMatchObject({ not_approved: 2, excluded_by_filter: expect.any(Number) });
    expect(page.hint?.join('')).toContain('不自动退回 candidate');
  });
});

describe('A案 §8.1 usage=compare：同 familyKey 并列返回', () => {
  it('familyKey/objectId 均可定位；各标状态；conflicts/supersedes 只给提示与入口', async () => {
    const page = await service.objects({ usage: 'compare', familyKey: 'fam:modifier' });
    expect(page.objects.map((row) => row.objectId).sort()).toEqual(['ko_dec', 'ko_lin', 'ko_tanh']);
    expect(page.objects.every((row) => row.matchType === 'family')).toBe(true);
    const byId = new Map(page.objects.map((row) => [row.objectId, row]));
    expect(byId.get('ko_lin')!.businessStatus).toBe('candidate');
    expect(byId.get('ko_dec')!.businessStatus).toBe('unknown');
    expect(page.conflictHints).toEqual(expect.arrayContaining([
      expect.objectContaining({ edgeId: 'ke_conf', type: 'conflicts_with', fromObjectId: 'ko_lin', toObjectId: 'ko_tanh' }),
      expect.objectContaining({ edgeId: 'ke_sup', type: 'supersedes', decisionRef: 'dec:modifier-1' }),
    ]));
    const viaObject = await service.objects({ usage: 'compare', objectId: 'ko_lin' });
    expect(viaObject.objects.map((row) => row.objectId).sort()).toEqual(['ko_dec', 'ko_lin', 'ko_tanh']);
  });
});

describe('A案 §8.2 关系扩展：direct/related 分离与预算', () => {
  it('related 单独返回不混入 direct；depends_on 优先于 part_of；冲突/取代不进计算链', async () => {
    const page = await service.objects({ objectId: 'ko_damage' });
    expect(page.objects.map((row) => row.objectId)).toEqual(['ko_damage']);
    const relatedIds = page.related.map((row) => row.objectId);
    expect(relatedIds).toContain('ko_base');
    expect(relatedIds).toContain('ko_combat');
    expect(page.related.every((row) => row.matchType === 'related' && row.relation)).toBe(true);
    const base = page.related.find((row) => row.objectId === 'ko_base')!;
    expect(base.relation).toMatchObject({ edgeId: 'ke_dep_ok', type: 'depends_on', direction: 'out' });
    expect(page.relatedBudget).toMatchObject({ maxHops: 1, maxObjects: 6, maxChars: 6000, remaining: 0, stopReason: null });
  });

  it('预算截断：>6 对象 → 6 个 + remaining + stopReason=max_objects', async () => {
    const page = await service.objects({ objectId: 'ko_hub' });
    expect(page.related).toHaveLength(6);
    expect(page.relatedBudget).toMatchObject({ included: 6, remaining: 2, stopReason: 'max_objects' });
    expect(new Set(page.related.map((row) => row.objectId)).size).toBe(6);
  });

  it('预算截断：字符预算 → stopReason=max_chars 且累计不超 6000', async () => {
    const page = await service.objects({ objectId: 'ko_hub_chars' });
    expect(page.relatedBudget.stopReason).toBe('max_chars');
    expect(page.relatedBudget.included).toBeLessThan(6);
    expect(page.relatedBudget.remaining).toBeGreaterThan(0);
    expect(page.relatedBudget.chars).toBeLessThanOrEqual(6000);
    expect(page.relatedBudget.chars + JSON.stringify(page.related[page.related.length - 1]).length).toBeGreaterThan(6000);
  });

  it('objectId 去重：同一目标经 depends_on 与 part_of 只出现一次', async () => {
    const page = await service.objects({ objectId: 'ko_dedupe' });
    const shared = page.related.filter((row) => row.objectId === 'ko_shared');
    expect(shared).toHaveLength(1);
    expect(shared[0]!.relation!.type).toBe('depends_on'); // 优先级 depends_on > part_of
  });
});

describe('A案 §8.2 状态过滤泄漏防护（search 对象感知模式）', () => {
  it('operational search：只从合格对象范围生成 snippet；混状态文档 summary 改用对象摘要', async () => {
    const page = await service.search({ query: '伤害', usage: 'operational', limit: 30 });
    expect(page.usage).toBe('operational');
    const paths = page.results.map((hit) => hit.path);
    expect(paths).toContain('战斗/伤害.md');
    expect(paths).toContain('战斗/修正.md'); // ko_base 命中（“伤害计算前”）
    expect(paths).not.toContain('战斗/决策.md'); // 仅 ko_dec（unknown）→ 整文档不进 operational
    const damage = page.results.find((hit) => hit.path === '战斗/伤害.md')!;
    expect(damage.summary).toBe('普攻伤害公式'); // 混状态：不用文档 summary
    expect(damage.objectRefs).toEqual([{ objectId: 'ko_damage', businessStatus: 'approved', reviewStatus: 'passed' }]);
    const text = JSON.stringify(damage);
    expect(text).not.toContain('线性方案');
    expect(text).not.toContain('tanh 方案');
    expect(text).not.toContain('历史设计背景'); // 未纳管章节不产 snippet
    const modifier = page.results.find((hit) => hit.path === '战斗/修正.md')!;
    expect(modifier.objectRefs!.map((ref) => ref.objectId).sort()).toEqual(['ko_base', 'ko_overdue_normal']);
    expect(JSON.stringify(modifier)).not.toContain('本规则依赖候选规则');
    expect(JSON.stringify(modifier)).not.toContain('已超过复核期');
  });

  it('browse + 状态过滤：候选方案可见，已批准章节不产 snippet；反向同样受保护', async () => {
    const page = await service.search({ query: '伤害', businessStatuses: ['candidate'], limit: 30 });
    const paths = page.results.map((hit) => hit.path);
    expect(paths).toContain('战斗/伤害.md');
    expect(paths).not.toContain('战斗/修正.md');
    const damage = page.results.find((hit) => hit.path === '战斗/伤害.md')!;
    expect(damage.objectRefs!.map((ref) => ref.objectId).sort()).toEqual(['ko_lin', 'ko_tanh']);
    expect(damage.summary).toBe('攻防修正·线性方案；攻防修正·tanh方案');
    expect(JSON.stringify(damage)).not.toContain('上限 300%');
  });

  it('缺省行为不变：无 usage/过滤参数时不进入对象感知模式', async () => {
    const page = await service.search({ query: '伤害' });
    expect(page.usage).toBeUndefined();
    expect(page.excluded).toBeUndefined();
    expect(page.results.some((hit) => hit.objectRefs !== undefined)).toBe(false);
    const damage = page.results.find((hit) => hit.path === '战斗/伤害.md')!;
    expect(damage.summary).toBe('混状态文档摘要');
  });
});

describe('A案 §8.2 游标：绑定 releaseId/usage/过滤参数/evaluatedAt', () => {
  it('objects 分页无重无漏；跨页 freshness.evaluatedAt 一致；改参数拒绝', async () => {
    const first = await service.objects({ usage: 'browse', limit: 5 });
    expect(first.next).toBeTypeOf('string');
    const collected = [...first.objects.map((row) => row.objectId)];
    const evaluatedAt = first.objects[0]!.freshness.evaluatedAt;
    let cursor = first.next;
    let pages = 1;
    while (cursor && pages < 30) {
      const page = await service.objects({ usage: 'browse', limit: 5, cursor });
      collected.push(...page.objects.map((row) => row.objectId));
      if (page.objects.length) expect(page.objects[0]!.freshness.evaluatedAt).toBe(evaluatedAt);
      cursor = page.next; pages++;
    }
    expect(new Set(collected).size).toBe(collected.length);
    const full = await allObjects(service, { usage: 'browse', limit: 100 });
    expect(collected.sort()).toEqual(full.map((row) => row.objectId).sort());
    await expect(service.objects({ usage: 'operational', limit: 5, cursor: first.next! })).rejects.toMatchObject({ code: 'invalid_cursor' });
    await expect(service.objects({ usage: 'browse', limit: 6, cursor: first.next! })).rejects.toMatchObject({ code: 'invalid_cursor' });
    await expect(service.search({ query: '伤害', limit: 1, cursor: first.next! })).rejects.toMatchObject({ code: 'invalid_cursor' });
  });

  it('search operational 分页：同参数续页稳定，改 usage 拒绝', async () => {
    const first = await service.search({ query: '伤害', usage: 'operational', limit: 1 });
    expect(first.next).toBeTypeOf('string');
    const second = await service.search({ query: '伤害', usage: 'operational', limit: 1, cursor: first.next! });
    expect(second.releaseId).toBe(first.releaseId);
    expect(second.usage).toBe('operational');
    await expect(service.search({ query: '伤害', limit: 1, cursor: first.next! })).rejects.toMatchObject({ code: 'invalid_cursor' });
  });
});

describe('A案 §8.1/§10.2 v1 release 全兼容与 sidecar 异常透传', () => {
  it('v1：对象查询返回 legacy 提示不报错；全文检索照常；operational 不把未分类当已批准', async () => {
    const objects = await service.objects({ releaseId: 'r_v1' });
    expect(objects).toMatchObject({ releaseId: 'r_v1', organizationHash: null, total: 0, next: null });
    expect(objects.objects).toEqual([]);
    expect(objects.legacy).toMatchObject({ label: 'legacy-unclassified' });
    expect(objects.legacy!.notice).toContain('全文检索');

    const read = await service.getObject({ objectId: 'ko_damage', releaseId: 'r_v1' });
    expect(read.object).toBeNull();
    expect(read.legacy!.label).toBe('legacy-unclassified');

    const search = await service.search({ query: '伤害', releaseId: 'r_v1' });
    expect(search.results).toHaveLength(1);
    expect(search.results[0]!.path).toBe('旧/文档.md');

    const operational = await service.search({ query: '伤害', usage: 'operational', releaseId: 'r_v1' });
    expect(operational.results).toEqual([]);
    expect(operational.legacy).toBe('legacy-unclassified');
    expect(operational.excluded).toEqual({ legacy_unclassified: 1 });
    expect(operational.hint?.join('')).toContain('legacy-unclassified');

    const filteredBrowse = await service.search({ query: '伤害', businessStatuses: ['approved'], releaseId: 'r_v1' });
    expect(filteredBrowse.results).toEqual([]);
    expect(filteredBrowse.legacy).toBe('legacy-unclassified');
  });

  it('knowledge.json 损坏：组织查询失败透传，不降级为无状态全文结果（T4a 语义）', async () => {
    fs.writeFileSync(path.join(home, 'releases/r_kq/knowledge.json'), '{corrupted');
    const fresh = new KbQueryService(home, { prewarm: false });
    await expect(fresh.objects({})).rejects.toMatchObject({ code: 'kb_index_failed' });
    await expect(fresh.search({ query: '伤害', usage: 'browse' })).rejects.toMatchObject({ code: 'kb_index_failed' });
    // 无对象感知参数的普通检索不受 sidecar 影响（双读：正文真相不依赖 knowledge.json）
    const plain = await fresh.search({ query: '伤害' });
    expect(plain.results.length).toBeGreaterThan(0);
  });
});

describe('A案 §8.1 内置工具与 HTTP 端点透传（共用实现验证）', () => {
  it('kb_search 与 /api/kb/search 透传 usage/过滤参数，结果与共用查询层一致', async () => {
    const tools = new AgentToolService({ dataRoot: home, documentsProvider: () => [] });
    const token = tools.createRunContext({ runKind: 'discuss', outputRoot: home, knowledgeBaseRoot: home }).token;
    try {
      const builtin = JSON.parse((await tools.executeTool(token, 'kb_search', { query: '伤害', usage: 'operational', limit: 20 })).content[0].text);
      const direct = await service.search({ query: '伤害', usage: 'operational', limit: 20, releaseId: 'r_kq' });
      expect(builtin.results).toEqual(direct.results);
      expect(builtin.usage).toBe('operational');

      const routes = kbRoutes({ configManager: { load: async () => ({ standardKb: { outputRoot: home } }) }, buildService: {}, localMapStore: {}, documentsProvider: () => [], sheetCsvPaths: () => [] } as unknown as KbRouteDeps);
      const response = await routes.request(`/api/kb/search?q=${encodeURIComponent('伤害')}&usage=operational`);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.usage).toBe('operational');
      expect(body.results).toEqual(direct.results);
      expect(body.excluded).toEqual(direct.excluded);
      // 端点错误透传：非法枚举 → 400
      const bad = await routes.request(`/api/kb/search?q=${encodeURIComponent('伤害')}&usage=weird`);
      expect(bad.status).toBe(400);
      expect((await bad.json()).error).toBe('invalid_request');
    } finally {
      tools.revokeToken(token);
    }
  });
});
