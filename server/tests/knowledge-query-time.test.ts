/**
 * D2：检索时间维度 + 证据当前源比对 + 旧引用 alias + 围栏边界
 * （A案 §2.4/§6.1/§8.1/§8.3）
 *
 * 覆盖：
 * - asOf：关系 validFrom/validUntil 过滤（扩展/依赖判定）、timeUnknown 标注
 *   （对象/关系）、supersedes 历史时点可见性、不传 asOf 完全兼容、游标绑定。
 * - 证据当前源并列比对：current/stale/source_missing 三态（fixture 临时源根）、
 *   stale 双版本并列、无源根上下文退化为 evidenceNote、CSV 附件、MCP 注入
 *   解析（resolveEvidenceSourceRoot）、/api/kb/objects 路由注入。
 * - alias：迁移对象旧引用解析（migratedFrom）、未迁移对象不命中、多后继不
 *   静默跳第一个、循环迁移防护。
 * - 围栏：info string 含反引号不开栏（CommonMark；diting 遗留观察）。
 * 全部合成 fixture，无模型调用。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { KbQueryService } from '../src/kb/search/kb-query-service.js';
import { FenceTracker } from '../src/kb/knowledge-compiler.js';
import { resolveEvidenceSourceRoot } from '../src/mcp/kb-mcp-tools.js';
import type { KbRouteDeps } from '../src/routes/kb.js';
import { writeKnowledgeRelease } from './helpers/kb-knowledge-fixture.js';
import type { KnowledgeManifest, KnowledgeObject, ObjectMigration } from '../src/kb/knowledge-schema.js';

const FUTURE = '2099-01-01T00:00:00Z';
const DOC_PATH = '时间/规则.md';

const BODY_LINES = [
  '# 时间规则',
  '## 生效窗口规则', '窗口规则正文。',
  '## 未标注时间规则', '未标注规则正文。',
  '## 依赖持有者', '依赖持有者正文。',
  '## 依赖过期持有者', '依赖过期持有者正文。',
  '## 依赖目标', '依赖目标正文。',
  '## 被取代规则', '被取代规则正文。',
  '## 取代规则', '取代规则正文。',
  '## 已合并规则', '已合并规则正文。',
  '## 规则甲', '规则甲正文。',
  '## 规则乙', '规则乙正文。',
  '## 双后继规则', '双后继规则正文。',
];
const BODY = BODY_LINES.join('\n');
// 行号：2=窗口 4=未标注 6=持有者 8=过期持有者 10=依赖目标 12=被取代 14=取代 16=已合并 18=甲 20=乙 22=双后继

const hashOf = (content: string): string => `sha256:${crypto.createHash('sha256').update(content, 'utf8').digest('hex')}`;

// 当前源 fixture 内容（与发布证据 hash 的关系见 evidence 定义）
const SRC_OK_CONTENT = '# 当前一致源\n窗口规则证据正文。\n';
const SRC_MOD_PUBLISHED = '# 已修改源 v1\n';
const SRC_MOD_CURRENT = '# 已修改源 v2\n（当前源已改动）\n';
const SRC_CSV_MD = '# 表格源\n';
const SRC_CSV_CONTENT = '列A,列B\n1,2\n';

function makeObject(objectId: string, title: string, startLine: number, endLine: number, overrides: Partial<KnowledgeObject> = {}): KnowledgeObject {
  return {
    objectId, type: 'rule', title, aliases: [], domainIds: [],
    familyKey: `fam:${objectId}`, variantKey: 'default', scopeKey: 'combat-global', scopeText: '战斗全局',
    canonical: { docId: 'kd_time', path: DOC_PATH, anchor: objectId, bodyRange: { startLine, endLine } },
    revision: 1, locationRevision: 0, payloadHash: `sha256:${objectId}`, reviewSubjectHash: `sha256:r:${objectId}`,
    businessStatus: 'approved', reviewStatus: 'passed', claims: [],
    ...overrides,
  };
}

function buildKnowledge(): KnowledgeManifest {
  const objects: KnowledgeObject[] = [
    makeObject('ko_window', '生效窗口规则', 2, 3, { staleAfter: FUTURE }),
    makeObject('ko_plain', '未标注时间规则', 4, 5, {}),
    makeObject('ko_holder', '依赖持有者', 6, 7, {}),
    makeObject('ko_holder_exp', '依赖过期持有者', 8, 9, {}),
    makeObject('ko_dep', '依赖目标', 10, 11, { businessStatus: 'candidate', reviewStatus: 'pending' }),
    makeObject('ko_old', '被取代规则', 12, 13, { familyKey: 'fam:sup', variantKey: 'old' }),
    makeObject('ko_new', '取代规则', 14, 15, { familyKey: 'fam:sup', variantKey: 'new' }),
    // tombstone 保留旧 canonical（A案 §2.4：alias 依据迁移映射 + 保留位置）
    { ...makeObject('ko_merged', '已合并规则', 16, 17), tombstone: { reason: '并入取代规则', successorObjectIds: ['ko_new'] } },
    { ...makeObject('ko_cycle_a', '规则甲', 18, 19), tombstone: { reason: '环测试甲', successorObjectIds: ['ko_cycle_b'] } },
    { ...makeObject('ko_cycle_b', '规则乙', 20, 21), tombstone: { reason: '环测试乙', successorObjectIds: ['ko_cycle_a'] } },
    { ...makeObject('ko_split', '双后继规则', 22, 23), tombstone: { reason: '拆分为两个对象', successorObjectIds: ['ko_window', 'ko_new'] } },
  ];
  const migrations: ObjectMigration[] = [
    { objectId: 'ko_merged', kind: 'merge', successorObjectIds: ['ko_new'], reason: '并入取代规则' },
    { objectId: 'ko_cycle_a', kind: 'merge', successorObjectIds: ['ko_cycle_b'], reason: '环测试甲' },
    { objectId: 'ko_cycle_b', kind: 'merge', successorObjectIds: ['ko_cycle_a'], reason: '环测试乙' },
    { objectId: 'ko_split', kind: 'split', successorObjectIds: ['ko_window', 'ko_new'], reason: '拆分' },
  ];
  return {
    schemaVersion: 1,
    releaseId: 'r_time',
    documents: [{ docId: 'kd_time', path: DOC_PATH }],
    objects,
    presentations: [],
    relations: [
      { edgeId: 'ke_plain_dep', fromObjectId: 'ko_plain', toObjectId: 'ko_dep', type: 'depends_on', scopeKey: 'combat-global', evidenceIds: [] },
      { edgeId: 'ke_future_dep', fromObjectId: 'ko_holder', toObjectId: 'ko_dep', type: 'depends_on', scopeKey: 'combat-global', evidenceIds: [], validFrom: '2030-01-01T00:00:00Z' },
      { edgeId: 'ke_expired_dep', fromObjectId: 'ko_holder_exp', toObjectId: 'ko_dep', type: 'depends_on', scopeKey: 'combat-global', evidenceIds: [], validUntil: '2020-06-01T00:00:00Z' },
      { edgeId: 'ke_old_dep', fromObjectId: 'ko_old', toObjectId: 'ko_window', type: 'depends_on', scopeKey: 'combat-global', evidenceIds: [] },
      { edgeId: 'ke_sup', fromObjectId: 'ko_new', toObjectId: 'ko_old', type: 'supersedes', scopeKey: 'combat-global', evidenceIds: [], decisionRef: 'dec:time-1', validFrom: '2025-06-01T00:00:00Z' },
    ],
    evidence: [
      { evidenceId: 'kev_current', objectId: 'ko_window', claimKey: 'w-1', role: 'supports', nature: 'direct',
        sourceRef: { sourceId: 'src_ok', sourceSnapshotHash: 'sha256:snap', resourceId: 'src_ok', resourceHash: hashOf(SRC_OK_CONTENT) },
        selector: { kind: 'text_span', lineStart: 2, lineEnd: 2, colStart: 1, colEnd: 20, headingPath: ['当前一致源'] }, quoteHash: 'sha256:q1' },
      { evidenceId: 'kev_stale', objectId: 'ko_window', claimKey: 'w-1', role: 'supports', nature: 'direct',
        sourceRef: { sourceId: 'src_mod', sourceSnapshotHash: 'sha256:snap', resourceId: 'src_mod', resourceHash: hashOf(SRC_MOD_PUBLISHED) },
        selector: { kind: 'text_span', lineStart: 1, lineEnd: 1, colStart: 1, colEnd: 20, headingPath: ['已修改源'] }, quoteHash: 'sha256:q2' },
      { evidenceId: 'kev_missing', objectId: 'ko_window', claimKey: 'w-1', role: 'context', nature: 'direct',
        sourceRef: { sourceId: 'src_gone', sourceSnapshotHash: 'sha256:snap', resourceId: 'src_gone', resourceHash: 'sha256:gone' },
        selector: { kind: 'text_span', lineStart: 1, lineEnd: 1, colStart: 1, colEnd: 20, headingPath: ['已删除源'] }, quoteHash: 'sha256:q3' },
      { evidenceId: 'kev_csv', objectId: 'ko_window', claimKey: 'w-1', role: 'supports', nature: 'derived',
        sourceRef: { sourceId: 'src_csv', sourceSnapshotHash: 'sha256:snap', resourceId: 'src_csv#csv:表.csv', resourceHash: hashOf(SRC_CSV_CONTENT) },
        selector: { kind: 'csv_cells', resourcePath: '表.csv', parserVersion: 'v1', recordStart: 1, recordEnd: 2, columns: ['列A', '列B'] }, quoteHash: 'sha256:q4' },
    ],
    coverage: [], migrations,
  };
}

let home: string, sourceRoot: string, service: KbQueryService;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-query-time-'));
  sourceRoot = path.join(home, 'raw-root');
  const manifest = writeKnowledgeRelease(home, 'r_time', [{ path: DOC_PATH, title: '时间规则', docId: 'kd_time', body: BODY }], buildKnowledge());
  // 发布快照登记四个源（relPath 相对源根）；源文件状态见各用例
  manifest.sourceSnapshot = [
    { objToken: 'src_ok', objType: 'docx', title: '当前一致源', relPath: '源/当前一致.md', contentHash: hashOf(SRC_OK_CONTENT), objEditTime: null },
    { objToken: 'src_mod', objType: 'docx', title: '已修改源', relPath: '源/已修改.md', contentHash: hashOf(SRC_MOD_PUBLISHED), objEditTime: null },
    { objToken: 'src_gone', objType: 'docx', title: '已删除源', relPath: '源/已删除.md', contentHash: 'sha256:gone', objEditTime: null },
    { objToken: 'src_csv', objType: 'sheet', title: '表格源', relPath: '源/表格.md', contentHash: hashOf(SRC_CSV_MD), objEditTime: null },
  ];
  fs.writeFileSync(path.join(home, 'releases/r_time/manifest.json'), JSON.stringify(manifest));
  service = new KbQueryService(home, { prewarm: false });
});
afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

function writeSource(rel: string, content: string): void {
  const file = path.join(sourceRoot, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

// ---------------------------------------------------------------------------
// A案 §8.1/§6.1：asOf 历史查询
// ---------------------------------------------------------------------------

describe('A案 §6.1/§8.1 asOf：关系有效区间过滤', () => {
  it('validFrom 晚于 asOf → 关系不参与扩展与依赖判定；asOf 晚于 validFrom → 参与', async () => {
    // 不传 asOf：边无论区间一律参与（现状不变）
    const now = await service.objects({ objectId: 'ko_holder' });
    expect(now.related.map((row) => row.objectId)).toContain('ko_dep');
    // asOf 早于 validFrom(2030)：该依赖边在该时点不存在
    const before = await service.objects({ objectId: 'ko_holder', asOf: '2024-01-01' });
    expect(before.related.map((row) => row.objectId)).not.toContain('ko_dep');
    // asOf 晚于 validFrom：边生效
    const after = await service.objects({ objectId: 'ko_holder', asOf: '2031-01-01' });
    expect(after.related.map((row) => row.objectId)).toContain('ko_dep');
  });

  it('validUntil ≤ asOf → 关系已失效不参与；asOf 早于 validUntil → 参与', async () => {
    const expired = await service.objects({ objectId: 'ko_holder_exp', asOf: '2021-01-01' });
    expect(expired.related.map((row) => row.objectId)).not.toContain('ko_dep');
    const active = await service.objects({ objectId: 'ko_holder_exp', asOf: '2019-01-01' });
    expect(active.related.map((row) => row.objectId)).toContain('ko_dep');
  });

  it('operational 依赖资格随 asOf 变化：未生效依赖不阻断', async () => {
    // ko_dep 为 candidate：无 asOf 时 ko_holder 因 depends_on ko_dep 被 dependency_unavailable 排除
    const plain = await service.objects({ usage: 'operational', limit: 100 });
    expect(plain.objects.map((row) => row.objectId)).not.toContain('ko_holder');
    expect(plain.excluded).toMatchObject({ dependency_unavailable: expect.any(Number) });
    // asOf=2024：future 依赖边不存在 → ko_holder 资格恢复
    const historic = await service.objects({ usage: 'operational', limit: 100, asOf: '2024-01-01' });
    expect(historic.objects.map((row) => row.objectId)).toContain('ko_holder');
    // search 对象感知模式同口径（共用实现）
    const searchPage = await service.search({ query: '依赖持有者', usage: 'operational', asOf: '2024-01-01' });
    const hit = searchPage.results.find((item) => item.path === DOC_PATH);
    expect(hit?.objectRefs?.map((ref) => ref.objectId)).toContain('ko_holder');
  });

  it('timeUnknown：对象与缺少时间范围的关系如实标注；有区间的边不标', async () => {
    const page = await service.objects({ objectId: 'ko_plain', asOf: '2024-01-01' });
    // 对象模型无有效区间字段：按业务日期查询时如实标注（A案 §6.1 不冒充 as-of 推理）
    expect(page.objects[0]!.timeUnknown).toBe(true);
    expect(page.asOf).toBe('2024-01-01');
    expect(page.hint?.join('')).toContain('不冒充完整 as-of 推理');
    // ko_plain 的 depends_on 边无区间 → related 行与 relation 标 timeUnknown
    const dep = page.related.find((row) => row.objectId === 'ko_dep');
    expect(dep?.relation).toMatchObject({ edgeId: 'ke_plain_dep', timeUnknown: true });
    expect(dep?.timeUnknown).toBe(true);
    // 有区间的边不标
    const bounded = await service.objects({ objectId: 'ko_holder', asOf: '2031-01-01' });
    const depBounded = bounded.related.find((row) => row.objectId === 'ko_dep');
    expect(depBounded?.relation?.timeUnknown).toBeUndefined();
  });

  it('supersedes 历史时点：asOf 早于生效时间无提示且被取代对象仍可见；晚于则提示', async () => {
    const before = await service.objects({ usage: 'compare', familyKey: 'fam:sup', asOf: '2025-01-01' });
    expect(before.conflictHints.map((hint) => hint.edgeId)).not.toContain('ke_sup');
    // 被取代对象在该历史时点仍可见（历史时点语义）
    expect(before.objects.map((row) => row.objectId)).toContain('ko_old');
    expect(before.objects.map((row) => row.objectId)).toContain('ko_new');
    const after = await service.objects({ usage: 'compare', familyKey: 'fam:sup', asOf: '2025-12-01' });
    expect(after.conflictHints.map((hint) => hint.edgeId)).toContain('ke_sup');
    // 取代生效后被取代对象不隐藏（提示与入口语义，不自动带入计算链）
    expect(after.objects.map((row) => row.objectId)).toContain('ko_old');
    // supersedes 带区间：asOf 查询下 hint 不标 timeUnknown
    expect(after.conflictHints.find((hint) => hint.edgeId === 'ke_sup')?.timeUnknown).toBeUndefined();
  });

  it('不传 asOf 行为完全不变：无 timeUnknown/asOf 字段、无提示', async () => {
    const page = await service.objects({ objectId: 'ko_plain' });
    expect(page.objects[0]!.timeUnknown).toBeUndefined();
    expect(page.asOf).toBeUndefined();
    expect(page.hint).toBeUndefined();
    expect(page.related.find((row) => row.objectId === 'ko_dep')?.relation?.timeUnknown).toBeUndefined();
    const read = await service.getObject({ objectId: 'ko_plain' });
    expect(read.object!.timeUnknown).toBeUndefined();
    expect(read.asOf).toBeUndefined();
  });

  it('游标绑定 asOf：同参数续页成功，改 asOf 或去掉 asOf 拒绝', async () => {
    const first = await service.objects({ usage: 'browse', limit: 3, asOf: '2024-01-01' });
    expect(first.next).toBeTypeOf('string');
    const second = await service.objects({ usage: 'browse', limit: 3, asOf: '2024-01-01', cursor: first.next! });
    expect(second.asOf).toBe('2024-01-01');
    await expect(service.objects({ usage: 'browse', limit: 3, asOf: '2025-01-01', cursor: first.next! })).rejects.toMatchObject({ code: 'invalid_cursor' });
    await expect(service.objects({ usage: 'browse', limit: 3, cursor: first.next! })).rejects.toMatchObject({ code: 'invalid_cursor' });
    // search 对象感知游标同样绑定
    const search = await service.search({ query: '规则', usage: 'browse', limit: 1, asOf: '2024-01-01' });
    if (search.next) {
      await expect(service.search({ query: '规则', usage: 'browse', limit: 1, asOf: '2024-01-01', cursor: search.next })).resolves.toBeTypeOf('object');
      await expect(service.search({ query: '规则', usage: 'browse', limit: 1, cursor: search.next })).rejects.toMatchObject({ code: 'invalid_cursor' });
    }
  });
});

// ---------------------------------------------------------------------------
// diting S-F07：asOf 日期校验（真实日历 + 时区强制；E2 反转）
// ---------------------------------------------------------------------------

describe('diting S-F07：asOf 日期校验（真实日历 + 时区强制）', () => {
  it('非法日历日期与无时区时间拒绝 invalid_request（Date.parse 归一化漏洞封堵）', async () => {
    // 2025-02-30 会被 Date.parse 归一到 3 月——必须拒绝而非漂移
    await expect(service.getObject({ objectId: 'ko_plain', asOf: '2025-02-30' })).rejects.toMatchObject({ code: 'invalid_request' });
    // 无时区时间按服务器本地时区解释（同请求跨机器可跨过不同边界）——拒绝
    await expect(service.getObject({ objectId: 'ko_plain', asOf: '2025-01-01T00:00:00' })).rejects.toMatchObject({ code: 'invalid_request' });
    // 空格分隔形态同样拒绝（严格 ISO T 分隔）
    await expect(service.getObject({ objectId: 'ko_plain', asOf: '2025-01-01 00:00:00' })).rejects.toMatchObject({ code: 'invalid_request' });
    // 月份/日期/时间分量越界
    await expect(service.getObject({ objectId: 'ko_plain', asOf: '2025-13-01' })).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(service.getObject({ objectId: 'ko_plain', asOf: '2025-01-00' })).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(service.getObject({ objectId: 'ko_plain', asOf: '2025-01-01T25:00:00Z' })).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('闰年：2024-02-29 合法、2023-02-29 拒绝；datetime 带 Z/显式偏移接受并规范化回显', async () => {
    await expect(service.getObject({ objectId: 'ko_plain', asOf: '2024-02-29' })).resolves.toBeTypeOf('object');
    await expect(service.getObject({ objectId: 'ko_plain', asOf: '2023-02-29' })).rejects.toMatchObject({ code: 'invalid_request' });
    const utc = await service.getObject({ objectId: 'ko_plain', asOf: '2025-01-01T00:00:00Z' });
    expect(utc.asOf).toBe('2025-01-01T00:00:00Z');
    const offset = await service.getObject({ objectId: 'ko_plain', asOf: '2025-01-01T08:00:00+08:00' });
    expect(offset.asOf).toBe('2025-01-01T00:00:00Z'); // 规范化后回显
  });

  it('date 形态按 UTC 业务日判定；边界相等（validUntil ≤ asOf 失效）；等价时点游标互通', async () => {
    // ke_expired_dep validUntil=2020-06-01T00:00:00Z：asOf=2020-06-01（UTC 业务日
    // 00:00Z）恰在失效边界（≤）→ 关系不参与
    const onBoundary = await service.objects({ objectId: 'ko_holder_exp', asOf: '2020-06-01' });
    expect(onBoundary.related.map((row) => row.objectId)).not.toContain('ko_dep');
    const dayBefore = await service.objects({ objectId: 'ko_holder_exp', asOf: '2020-05-31' });
    expect(dayBefore.related.map((row) => row.objectId)).toContain('ko_dep');
    // 规范化后进游标：+08:00 与对应 UTC 表达的续页互通（同游标参数）
    const first = await service.objects({ usage: 'browse', limit: 3, asOf: '2024-01-01T08:00:00+08:00' });
    expect(first.asOf).toBe('2024-01-01T00:00:00Z');
    expect(first.next).toBeTypeOf('string');
    await expect(service.objects({ usage: 'browse', limit: 3, asOf: '2024-01-01T00:00:00Z', cursor: first.next! })).resolves.toBeTypeOf('object');
  });

  it('既有拒绝用例保持：乱串/越界日拒绝；纯全文检索传 asOf 不改变结果形态', async () => {
    await expect(service.objects({ asOf: 'not-a-date' })).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(service.objects({ asOf: '2024-13-99' })).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(service.getObject({ objectId: 'ko_plain', asOf: 'tomorrow' })).rejects.toMatchObject({ code: 'invalid_request' });
    const plain = await service.search({ query: '规则', asOf: '2024-01-01' });
    expect(plain.usage).toBeUndefined();
    expect(plain.asOf).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// A案 §8.3：证据当前源并列比对
// ---------------------------------------------------------------------------

describe('A案 §8.3 证据当前源比对', () => {
  beforeEach(() => {
    writeSource('源/当前一致.md', SRC_OK_CONTENT);
    writeSource('源/已修改.md', SRC_MOD_CURRENT); // 与发布依据 v1 不同
    writeSource('源/表格.md', SRC_CSV_MD);
    writeSource('源/表.csv', SRC_CSV_CONTENT);
    // 源/已删除.md 不写 → source_missing
  });

  it('三态：current / stale（双版本并列）/ source_missing（依据不抹除）', async () => {
    const read = await service.getObject({ objectId: 'ko_window', currentSourceRoot: sourceRoot });
    expect(read.evidenceNote).toContain('current 2 / stale 1 / source_missing 1 / unsupported 0');
    const byId = new Map(read.evidence.map((item) => [item.evidenceId, item]));
    expect(byId.get('kev_current')).toMatchObject({ currency: 'current' });
    expect(byId.get('kev_current')!.comparison!.currentRef).toMatchObject({ path: '源/当前一致.md', resourceHash: hashOf(SRC_OK_CONTENT) });
    // stale：并列发布依据版本（source+locator 仍在）与当前源版本
    const stale = byId.get('kev_stale')!;
    expect(stale.currency).toBe('stale');
    expect(stale.source.resourceHash).toBe(hashOf(SRC_MOD_PUBLISHED)); // 发布依据版本不抹除
    expect(stale.comparison!.currentRef).toMatchObject({ path: '源/已修改.md', resourceHash: hashOf(SRC_MOD_CURRENT) });
    // source_missing：发布依据保留 + 维护风险提示
    const missing = byId.get('kev_missing')!;
    expect(missing.currency).toBe('source_missing');
    expect(missing.comparison).toBeUndefined();
    expect(missing.currencyNote).toContain('缺失');
    expect(read.evidenceNote).toContain('维护风险');
    // CSV 附件（#csv:basename）同公式比对
    expect(byId.get('kev_csv')).toMatchObject({ currency: 'current' });
    expect(byId.get('kev_csv')!.comparison!.currentRef).toMatchObject({ path: '源/表.csv', resourceHash: hashOf(SRC_CSV_CONTENT) });
  });

  it('无源根上下文退化为现有 evidenceNote，不访问原始库', async () => {
    const read = await service.getObject({ objectId: 'ko_window' });
    expect(read.evidence.every((item) => item.currency === undefined && item.comparison === undefined)).toBe(true);
    expect(read.evidenceNote).toContain('本查询不访问原始库');
    // 进程级注入（构造参数）同样生效：调用点显式传参优先
    const injected = new KbQueryService(home, { prewarm: false, currentSourceRoot: sourceRoot });
    const viaCtor = await injected.getObject({ objectId: 'ko_window' });
    expect(viaCtor.evidence.some((item) => item.currency === 'current')).toBe(true);
  });

  it('MCP 注入解析：kbRoot 与应用 outputRoot 一致才信任 config 原始库根', async () => {
    const configHome = path.join(home, 'mcp-home');
    fs.mkdirSync(configHome, { recursive: true });
    fs.writeFileSync(path.join(configHome, 'config.json'), JSON.stringify({
      knowledgeBaseRoot: sourceRoot, standardKb: { outputRoot: home },
    }));
    process.env.FEISHU_SYNC_HOME = configHome;
    try {
      expect(resolveEvidenceSourceRoot(home)).toBe(path.resolve(sourceRoot));
      // kbRoot 与 outputRoot 不一致 → 不注入（独立调用不继承本应用原始库）
      expect(resolveEvidenceSourceRoot('/tmp/other-kb')).toBeUndefined();
    } finally {
      delete process.env.FEISHU_SYNC_HOME;
    }
  });

  it('routes /api/kb/objects：currentSourceRoot 由 config 原始库根解析注入；asOf/legacyRef 透传', async () => {
    // 动态 import：routes 链路较重（构建服务依赖），与纯查询用例解耦加载
    const { kbRoutes } = await import('../src/routes/kb.js');
    const routes = kbRoutes({
      configManager: { load: async () => ({ standardKb: { outputRoot: home }, knowledgeBaseRoot: sourceRoot }) },
      buildService: {}, localMapStore: {}, documentsProvider: () => [], sheetCsvPaths: () => [],
    } as unknown as KbRouteDeps);
    const response = await routes.request(`/api/kb/objects?objectId=ko_window&asOf=${encodeURIComponent('2024-01-01')}`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.object.objectId).toBe('ko_window');
    expect(body.asOf).toBe('2024-01-01');
    expect(body.object.timeUnknown).toBe(true);
    expect(body.evidence.some((item: { currency?: string }) => item.currency === 'current')).toBe(true);
    const viaLegacy = await routes.request(`/api/kb/objects?legacyRef=${encodeURIComponent(`${DOC_PATH}#已合并规则`)}`);
    expect(viaLegacy.status).toBe(200);
    const migrated = await viaLegacy.json();
    expect(migrated.object.objectId).toBe('ko_new');
    expect(migrated.migratedFrom).toMatchObject({ legacyRef: `${DOC_PATH}#已合并规则`, aliasHitObjectId: 'ko_merged', via: ['ko_merged'] });
    // 非法参数 → 400（共用查询层校验）
    const bad = await routes.request('/api/kb/objects?objectId=ko_window&legacyRef=x.md%23y');
    expect(bad.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// A案 §2.4：旧 path#heading → objectId alias 解析
// ---------------------------------------------------------------------------

describe('A案 §2.4 旧引用 alias 解析', () => {
  it('迁移对象旧引用解析到存续对象并带 migratedFrom；支持完整 headingPath 形态', async () => {
    const read = await service.getObject({ legacyRef: `${DOC_PATH}#已合并规则` });
    expect(read.object!.objectId).toBe('ko_new');
    expect(read.migratedFrom).toMatchObject({ aliasHitObjectId: 'ko_merged', via: ['ko_merged'] });
    expect(read.migratedFrom!.cycle).toBeUndefined();
    // 活跃对象当前位置可直接解析（未迁移命中）
    const direct = await service.getObject({ legacyRef: `${DOC_PATH}#生效窗口规则` });
    expect(direct.object!.objectId).toBe('ko_window');
    expect(direct.migratedFrom).toMatchObject({ legacyRef: `${DOC_PATH}#生效窗口规则`, aliasHitObjectId: 'ko_window', via: [] });
    // 完整 headingPath（含 ›）形态按末段命中
    const full = await service.getObject({ legacyRef: `${DOC_PATH}#时间规则 › 生效窗口规则` });
    expect(full.object!.objectId).toBe('ko_window');
  });

  it('未命中与互斥：不冒充解析；objectId/legacyRef 二选一', async () => {
    await expect(service.getObject({ legacyRef: `${DOC_PATH}#不存在的标题` })).rejects.toMatchObject({ code: 'kb_not_found' });
    await expect(service.getObject({ legacyRef: '战斗/未迁移.md#已合并规则' })).rejects.toMatchObject({ code: 'kb_not_found' });
    await expect(service.getObject({})).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(service.getObject({ objectId: 'ko_new', legacyRef: `${DOC_PATH}#已合并规则` })).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(service.getObject({ legacyRef: 'no-hash-ref' })).rejects.toMatchObject({ code: 'invalid_request' });
    // compare 经 legacyRef 解析所属族
    const compare = await service.objects({ usage: 'compare', legacyRef: `${DOC_PATH}#已合并规则` });
    expect(compare.objects.map((row) => row.objectId)).toContain('ko_new');
  });

  it('多后继不静默跳第一个：返回被命中 tombstone 由调用方选择', async () => {
    const read = await service.getObject({ legacyRef: `${DOC_PATH}#双后继规则` });
    expect(read.object!.objectId).toBe('ko_split');
    expect(read.object!.tombstone).toMatchObject({ successorObjectIds: ['ko_window', 'ko_new'] });
    expect(read.migratedFrom!.via).toEqual([]);
  });

  it('循环迁移防护：visited 集合截断，返回确定结果不挂起', async () => {
    const read = await service.getObject({ legacyRef: `${DOC_PATH}#规则甲` });
    // 甲 → 乙 → 甲（环）：停在乙并标 cycle，不静默跳第一个也不死循环
    expect(read.object!.objectId).toBe('ko_cycle_b');
    expect(read.migratedFrom).toMatchObject({ aliasHitObjectId: 'ko_cycle_a', cycle: true });
    expect(read.migratedFrom!.via).toEqual(['ko_cycle_a']);
  });
});

// ---------------------------------------------------------------------------
// diting 遗留：围栏 info string 边界（CommonMark）
// ---------------------------------------------------------------------------

describe('FenceTracker：info string 含反引号不开栏', () => {
  it("```bad`info 不开栏：后续行按正文处理，无围栏语义", () => {
    const fence = new FenceTracker();
    fence.visit('```bad`info');
    expect(fence.inside).toBe(false);
    // 未开栏：正文中的 ``` 会按普通开栏处理（此前一行不是围栏）
    fence.visit('{{kb-include:ko_x:f}} 不在围栏内');
    expect(fence.inside).toBe(false);
  });

  it('``` ``x`` 反例：info 含反引号不开栏；三反引号合法 info 正常开闭', () => {
    const bad = new FenceTracker();
    bad.visit('``` ``x``');
    expect(bad.inside).toBe(false);
    const good = new FenceTracker();
    good.visit('```js');
    expect(good.inside).toBe(true);
    good.visit('const x = `tick`;');
    expect(good.inside).toBe(true);
    good.visit('```');
    expect(good.inside).toBe(false);
    // 四反引号块内的三反引号仍是内容（F07 既有语义不回退）
    const nested = new FenceTracker();
    nested.visit('````');
    expect(nested.inside).toBe(true);
    nested.visit('```');
    expect(nested.inside).toBe(true);
    nested.visit('````');
    expect(nested.inside).toBe(false);
  });

  it('波浪围栏 info string 可含反引号（CommonMark：仅反引号围栏受限）', () => {
    const fence = new FenceTracker();
    fence.visit('~~~bad`info');
    expect(fence.inside).toBe(true);
    fence.visit('内容');
    expect(fence.inside).toBe(true);
    fence.visit('~~~');
    expect(fence.inside).toBe(false);
  });
});
