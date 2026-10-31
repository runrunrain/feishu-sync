/**
 * T3 知识协议工具测试（A 案 §5.2/§5.3/§7.1/§7.2）：
 * - kb_write_doc 知识声明：原子落盘（正文+knowledge-draft.json 同代）、
 *   clientKey→objectId 映射、toolCallId 幂等、expectedDraftRevision 冲突、
 *   写入即拒（scopeKey 缺失/自环/伪造回执/未注册 include 目标）、旧式调用兼容
 * - kb_submit_plan / kb_get_plan：ID 预分配、planRevision 递增、重复提交稳定、
 *   结构校验拒绝项、phase 门禁
 * - kb_submit_review：报告绑定草稿哈希（草稿改后 hash 不匹配）、审查者无写入口
 * - raw_read 回执：readReceiptId 登记与 segmentMap（多资源拼接、截断窗口）
 * - evidence-locator：四类 selector 正反用例（CSV 引号内换行、合并主格、
 *   hash 不匹配拒绝、回执范围外拒绝）
 *
 * 模式：in-memory/mock（临时目录 + 快照条目手工构造，不依赖 SQLite）。
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { AgentToolService, type BuildRunState, type ReadReceiptRecord } from '../src/agent/agent-tool-service.js';
import { RawSourceSnapshot, computeSourceHash } from '../src/kb/raw-source-snapshot.js';
import { PathClaims } from '../src/kb/path-claims.js';
import {
  computeQuoteHash,
  parseA1Range,
  parseCsvRecords,
  resolveSelector,
  verifyEvidence,
  type EvidenceReadReceipt,
  type EvidenceResource,
} from '../src/kb/evidence-locator.js';
import { computeCandidateHash } from '../src/kb/orchestration-contracts.js';
import { toolsForRunKind } from '../src/types/agent-knowledge.js';
import type { RawSourceSnapshotEntry } from '../src/types/agent-knowledge.js';

let dataRoot: string;
let kbRoot: string;
let outputRoot: string;
let service: AgentToolService;

const writeRaw = (rel: string, content: string): string => {
  const target = path.join(kbRoot, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, 'utf-8');
  return target;
};

const CSV_NAME = '表.csv';
let CSV_PATH = '';
const CSV_CONTENT = '列,值\n1,"多行\n内容"\n3,三\n';

function entry(objToken: string, relPath: string, csvPaths: string[] = []): RawSourceSnapshotEntry {
  return {
    objToken,
    objType: relPath === 'sheet-doc.md' ? 'sheet' : 'docx',
    title: relPath,
    relPath,
    contentHash: computeSourceHash(path.join(kbRoot, relPath), csvPaths, kbRoot),
    objEditTime: null,
  };
}

/** 构建态快照：tokA（纯文本）+ tokB（md+CSV 附件）。 */
function makeSnapshot(): RawSourceSnapshot {
  return RawSourceSnapshot.fromEntries(
    [entry('tokA', 'src-a.md'), entry('tokB', 'sheet-doc.md', [CSV_PATH])],
    { knowledgeBaseRoot: kbRoot, sheetCsvPaths: (token) => (token === 'tokB' ? [CSV_PATH] : []) },
  );
}

function makeBuildState(stagingName: string): BuildRunState {
  const stagingRoot = path.join(dataRoot, 'staging', stagingName);
  fs.mkdirSync(path.join(stagingRoot, 'docs'), { recursive: true });
  return {
    knowledgeBaseRoot: kbRoot,
    snapshot: makeSnapshot(),
    mode: 'incremental',
    workset: new Map([['tokA', 'added'], ['tokB', 'added']]),
    stagingRoot,
    finishInfo: null,
  };
}

function tokenFor(state: BuildRunState, worker?: { workerId: string; unitId: string | null; phase: 'unit' | 'final' | 'plan' | 'review' }): string {
  return service.createRunContext({
    runKind: 'build',
    buildId: 'b_t3',
    outputRoot,
    knowledgeBaseRoot: kbRoot,
    buildState: state,
    ...(worker ? { worker } : {}),
  }).token;
}

const BASE_WRITE = {
  path: '战斗/伤害规则.md',
  title: '伤害规则',
  markdown: ['## 伤害公式', '', '基础伤害 = 攻击力 × 倍率。', '', '## 适用范围', '', '仅对普攻生效。'].join('\n'),
  sources: ['tokA'],
  summary: '伤害公式与适用范围',
};

beforeAll(() => {
  dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kbknow-data-'));
  kbRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kbknow-kb-'));
  outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kbknow-out-'));
  service = new AgentToolService({ dataRoot, documentsProvider: () => [] });
  CSV_PATH = path.join(kbRoot, CSV_NAME);
  writeRaw('src-a.md', '伤害倍率表\n倍率 2.0\n上限 500\n');
  writeRaw('sheet-doc.md', 'A1\nA2\n');
  writeRaw(CSV_NAME, CSV_CONTENT);
});

afterAll(() => {
  for (const dir of [dataRoot, kbRoot, outputRoot]) fs.rmSync(dir, { recursive: true, force: true });
});

// ============================================================================
// evidence-locator（纯函数）
// ============================================================================

const textResource: EvidenceResource = {
  resourceId: 'tokA',
  sourceId: 'tokA',
  sourceSnapshotHash: 'sha256:snap',
  resourceHash: computeQuoteHash('倍率 2.0\n'),
  kind: 'text',
  content: '伤害倍率表\n倍率 2.0\n上限 500\n',
};

describe('evidence-locator：TextSpan', () => {
  it('正例：行列闭区间解出片段与 quoteHash', () => {
    const result = resolveSelector(textResource, {
      kind: 'text_span', lineStart: 2, lineEnd: 2, colStart: 1, colEnd: 0, headingPath: [],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.fragment).toBe('倍率 2.0');
      expect(result.quoteHash).toBe(computeQuoteHash('倍率 2.0'));
    }
  });
  it('反例：行越界拒绝', () => {
    const result = resolveSelector(textResource, {
      kind: 'text_span', lineStart: 2, lineEnd: 99, colStart: 1, colEnd: 0, headingPath: [],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('kb_evidence_unresolved');
  });
  it('类型错配拒绝（TextSpan 用于 csv 资源）', () => {
    const csv: EvidenceResource = {
      resourceId: 'x#csv:a.csv', sourceId: 'x', sourceSnapshotHash: 's', resourceHash: 'h', kind: 'csv', content: 'a\n',
    };
    const result = resolveSelector(csv, { kind: 'text_span', lineStart: 1, lineEnd: 1, colStart: 1, colEnd: 0, headingPath: [] });
    expect(result.ok).toBe(false);
  });
});

describe('evidence-locator：CsvCells（引号内换行不等于新记录）', () => {
  const csvResource: EvidenceResource = {
    resourceId: 'tokB#csv:表.csv',
    sourceId: 'tokB',
    sourceSnapshotHash: 'sha256:snapB',
    resourceHash: computeQuoteHash(CSV_CONTENT),
    kind: 'csv',
    content: CSV_CONTENT,
    path: CSV_NAME,
  };
  it('parseCsvRecords：record 2 跨两个物理行', () => {
    const { records, recordSpans } = parseCsvRecords(CSV_CONTENT);
    expect(records[1]).toEqual(['1', '多行\n内容']);
    expect(recordSpans[1]).toEqual({ startLine: 2, lineCount: 2 });
    expect(records).toHaveLength(3);
  });
  it('正例：逻辑 record 行+列名 → 单元格值（含换行内容）', () => {
    const result = resolveSelector(csvResource, {
      kind: 'csv_cells', resourcePath: CSV_NAME, parserVersion: 'rfc4180-v1',
      recordStart: 2, recordEnd: 2, columns: ['值'],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.fragment).toBe('多行\n内容');
      expect(result.quoteHash).toBe(computeQuoteHash('多行\n内容'));
    }
  });
  it('反例：列不存在拒绝', () => {
    const result = resolveSelector(csvResource, {
      kind: 'csv_cells', resourcePath: CSV_NAME, parserVersion: 'v1',
      recordStart: 1, recordEnd: 1, columns: ['不存在的列'],
    });
    expect(result.ok).toBe(false);
  });
});

describe('evidence-locator：WorkbookCells', () => {
  // D3：资源接口 sheet 感知（cell(sheet,a1)、合并主格键 `${sheet}!${A1}`）
  const cells: Record<string, { value: string; formula: string | null }> = {
    A1: { value: '10', formula: null },
    B1: { value: '20', formula: '=A1*2' },
    B2: { value: '40', formula: '=B1*2' },
  };
  const workbookResource: EvidenceResource = {
    resourceId: 'wb', sourceId: 'tokW', sourceSnapshotHash: 'sha256:snapW', resourceHash: 'sha256:wb',
    kind: 'workbook',
    workbookName: '数值表.xlsx',
    sheetNames: ['Sheet1', 'Sheet2'],
    usedRange: { maxRow: 5, maxCol: 5 },
    cell: (_sheet, a1) => cells[a1],
    mergedAnchors: new Set(['Sheet1!B2']),
  };
  it('正例：区间 + 合并主格 + 公式性质', () => {
    const result = resolveSelector(workbookResource, {
      kind: 'workbook_cells', workbookName: '数值表.xlsx', sheet: 'Sheet1', rangeA1: 'B1:B2',
      mergedCellAnchors: ['B2'], formulaTexts: ['=A1*2'], valueNature: 'formula_text',
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.fragment).toContain('=A1*2');
  });
  it('反例：合并主格不在区间内拒绝', () => {
    const result = resolveSelector(workbookResource, {
      kind: 'workbook_cells', workbookName: '数值表.xlsx', sheet: 'Sheet1', rangeA1: 'A1:A1',
      mergedCellAnchors: ['B2'], valueNature: 'cached_value',
    });
    expect(result.ok).toBe(false);
  });
  it('反例：声明 cached_value 但区间含公式格拒绝', () => {
    const result = resolveSelector(workbookResource, {
      kind: 'workbook_cells', workbookName: '数值表.xlsx', sheet: 'Sheet1', rangeA1: 'B1:B2',
      mergedCellAnchors: [], valueNature: 'cached_value',
    });
    expect(result.ok).toBe(false);
  });
  it('反例：sheet 不存在拒绝', () => {
    const result = resolveSelector(workbookResource, {
      kind: 'workbook_cells', workbookName: '数值表.xlsx', sheet: 'Sheet9', rangeA1: 'A1',
      mergedCellAnchors: [], valueNature: 'cached_value',
    });
    expect(result.ok).toBe(false);
  });
  it('parseA1Range 边界', () => {
    expect(parseA1Range('B2:D5')).toEqual({ startRow: 2, startCol: 2, endRow: 5, endCol: 4 });
    expect(parseA1Range('c3')).toEqual({ startRow: 3, startCol: 3, endRow: 3, endCol: 3 });
    expect(parseA1Range('bad')).toBeNull();
  });
});

describe('evidence-locator：MediaRegion 与 verifyEvidence', () => {
  const imageResource: EvidenceResource = {
    resourceId: 'img', sourceId: 'tokI', sourceSnapshotHash: 'sha256:snapI', resourceHash: 'sha256:img',
    kind: 'image', imageHash: 'sha256:abc', caption: '图中标注了倍率 2.0',
  };
  it('正例：imageHash 匹配（machine_description）', () => {
    const result = resolveSelector(imageResource, { kind: 'media_region', imageHash: 'sha256:abc' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.fragment).toBe('图中标注了倍率 2.0');
  });
  it('反例：imageHash 不匹配拒绝', () => {
    const result = resolveSelector(imageResource, { kind: 'media_region', imageHash: 'sha256:other' });
    expect(result.ok).toBe(false);
  });

  const receipts: EvidenceReadReceipt[] = [
    { readReceiptId: 'rr_ok', resourceId: 'tokA', lineStart: 1, lineEnd: 2 },
    { readReceiptId: 'rr_csv', resourceId: 'tokB#csv:表.csv', lineStart: 1, lineEnd: 5 },
  ];
  const makeEvidence = (overrides: Record<string, unknown>) => ({
    sourceRef: { sourceId: 'tokA', sourceSnapshotHash: 'sha256:snap', resourceId: 'tokA', resourceHash: computeQuoteHash('倍率 2.0\n') },
    selector: { kind: 'text_span', lineStart: 2, lineEnd: 2, colStart: 1, colEnd: 0, headingPath: [] },
    quoteHash: computeQuoteHash('倍率 2.0'),
    readReceiptId: 'rr_ok',
    ...overrides,
  });
  it('正例：hash 对账 + 回执覆盖 + quoteHash 匹配', () => {
    const result = verifyEvidence({ evidence: makeEvidence({}), resources: [textResource], receipts });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.receipt?.readReceiptId).toBe('rr_ok');
  });
  it('反例：resourceHash 对账失败（源版本不符）', () => {
    const result = verifyEvidence({
      evidence: makeEvidence({ sourceRef: { sourceId: 'tokA', sourceSnapshotHash: 'sha256:snap', resourceId: 'tokA', resourceHash: 'sha256:wrong' } }),
      resources: [textResource], receipts,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('kb_evidence_unresolved');
  });
  it('反例：quoteHash 不匹配', () => {
    const result = verifyEvidence({
      evidence: makeEvidence({ quoteHash: 'sha256:deadbeef' }),
      resources: [textResource], receipts,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('quoteHash');
  });
  it('反例：readReceiptId 不在登记中（伪造）', () => {
    const result = verifyEvidence({
      evidence: makeEvidence({ readReceiptId: 'rr_forged' }),
      resources: [textResource], receipts,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('伪造');
  });
  it('反例：selector 超出回执返回范围（截断范围外必须再读）', () => {
    // 回执 rr_ok 只覆盖 1..2 行；selector 指第 3 行 → 拒绝
    const result = verifyEvidence({
      evidence: makeEvidence({ selector: { kind: 'text_span', lineStart: 3, lineEnd: 3, colStart: 1, colEnd: 0, headingPath: [] } }),
      resources: [textResource], receipts,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('超出回执范围');
  });
  it('反例：回执资源不符（跨资源冒用）', () => {
    const result = verifyEvidence({
      evidence: makeEvidence({ readReceiptId: 'rr_csv' }),
      resources: [textResource], receipts,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('回执资源不符');
  });
  it('CsvCells 物理行映射后仍须落在回执范围内', () => {
    const csvResource: EvidenceResource = {
      resourceId: 'tokB#csv:表.csv', sourceId: 'tokB', sourceSnapshotHash: 'sha256:snapB',
      resourceHash: computeQuoteHash(CSV_CONTENT), kind: 'csv', content: CSV_CONTENT, path: CSV_NAME,
    };
    const ok = verifyEvidence({
      evidence: {
        sourceRef: { sourceId: 'tokB', sourceSnapshotHash: 'sha256:snapB', resourceId: 'tokB#csv:表.csv', resourceHash: computeQuoteHash(CSV_CONTENT) },
        selector: { kind: 'csv_cells', resourcePath: CSV_NAME, parserVersion: 'v1', recordStart: 2, recordEnd: 2, columns: ['值'] },
        quoteHash: computeQuoteHash('多行\n内容'),
        readReceiptId: 'rr_csv',
      },
      resources: [csvResource], receipts,
    });
    expect(ok.ok).toBe(true);
    const beyond = verifyEvidence({
      evidence: {
        sourceRef: { sourceId: 'tokB', sourceSnapshotHash: 'sha256:snapB', resourceId: 'tokB#csv:表.csv', resourceHash: computeQuoteHash(CSV_CONTENT) },
        selector: { kind: 'csv_cells', resourcePath: CSV_NAME, parserVersion: 'v1', recordStart: 3, recordEnd: 3, columns: ['值'] },
        quoteHash: computeQuoteHash('三'),
        readReceiptId: 'rr_csv',
      },
      resources: [{ ...csvResource, content: '列,值\n1,一\n' + CSV_CONTENT }], receipts,
    });
    expect(beyond.ok).toBe(false);
  });
});

// ============================================================================
// raw_read 回执与 segmentMap（A 案 §5.3）
// ============================================================================

describe('raw_read：readReceiptId 登记与 segmentMap（多资源拼接）', () => {
  it('全量读：主文档+CSV 附件各登记一条回执；segmentMap 标注派生行', async () => {
    const state = makeBuildState('receipt-full');
    const token = tokenFor(state);
    const result = await service.executeTool(token, 'raw_read', { objToken: 'tokB' }, { toolCallId: 'call-r1' });
    const details = result.details as Record<string, unknown>;
    const receipts = details.readReceipts as Array<{ readReceiptId: string; resourceId: string; lineStart: number; lineEnd: number }>;
    expect(receipts).toHaveLength(2);
    expect(receipts[0]).toMatchObject({ resourceId: 'tokB', lineStart: 1, lineEnd: 3 });
    expect(receipts[1]).toMatchObject({ resourceId: 'tokB#csv:表.csv', lineStart: 1, lineEnd: 5 });
    expect(details.readReceiptId).toBe(receipts[0]!.readReceiptId);
    // 资源表：主文档 + CSV
    const resources = details.resources as Array<{ resourceId: string; kind: string }>;
    expect(resources.map((r) => r.resourceId)).toEqual(['tokB', 'tokB#csv:表.csv']);
    // segmentMap：主资源段 → 派生 attachment_header 段 → CSV 资源段
    const segmentMap = details.segmentMap as Array<Record<string, unknown>>;
    expect(segmentMap).toHaveLength(3);
    expect(segmentMap[0]).toMatchObject({ resourceId: 'tokB', outStart: 1, outEnd: 3, resStart: 1, resEnd: 3 });
    expect(segmentMap[1]).toMatchObject({ derived: 'attachment_header', outStart: 4, outEnd: 5 });
    expect(segmentMap[2]).toMatchObject({ resourceId: 'tokB#csv:表.csv', outStart: 6 });
    // 回执文件落盘：2 行 JSONL
    const receiptFile = path.join(state.stagingRoot, 'read-receipts.jsonl');
    expect(fs.existsSync(receiptFile)).toBe(true);
    const lines = fs.readFileSync(receiptFile, 'utf-8').split('\n').filter((l) => l.trim());
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]!) as ReadReceiptRecord;
    expect(first).toMatchObject({ buildId: 'b_t3', toolCallId: 'call-r1', resourceId: 'tokB', truncated: false });
    expect(first.selector).toEqual({ kind: 'read_range', lineStart: 1, lineEnd: 3 });
    expect(first.sourceSnapshotHash).toBe(state.snapshot.get('tokB')!.contentHash);
  });

  it('翻页读：窗口截取 + truncated 标记 + 回执只记返回范围', async () => {
    const state = makeBuildState('receipt-page');
    const token = tokenFor(state);
    // 全量 9 行（主 3 + 头 2 + CSV 5-1=4? 见上：主3+header2+csv5行尾随空行=共10行）
    const page1 = await service.executeTool(token, 'raw_read', { objToken: 'tokB', offset: 0, limit: 4 }, { toolCallId: 'call-p1' });
    const d1 = page1.details as Record<string, unknown>;
    expect(d1.truncated).toBe(true);
    const seg1 = d1.segmentMap as Array<Record<string, unknown>>;
    expect(seg1).toHaveLength(2);
    expect(seg1[0]).toMatchObject({ resourceId: 'tokB', outStart: 1, outEnd: 3, resStart: 1, resEnd: 3 });
    expect(seg1[0]).not.toHaveProperty('resEnd', 4);
    const receipts1 = d1.readReceipts as Array<{ resourceId: string; lineStart: number; lineEnd: number }>;
    expect(receipts1).toHaveLength(1);
    expect(receipts1[0]).toMatchObject({ resourceId: 'tokB', lineStart: 1, lineEnd: 3 });
    // 第二页从 CSV 头开始，只命中 CSV 资源
    const page2 = await service.executeTool(token, 'raw_read', { objToken: 'tokB', offset: 4, limit: 100 }, { toolCallId: 'call-p2' });
    const d2 = page2.details as Record<string, unknown>;
    const receipts2 = d2.readReceipts as Array<{ resourceId: string; lineStart: number; lineEnd: number }>;
    expect(receipts2).toHaveLength(1);
    expect(receipts2[0]).toMatchObject({ resourceId: 'tokB#csv:表.csv', lineStart: 1, lineEnd: 5 });
    // 回执文件累积 2 条（页1主文档回执 + 页2 CSV 回执）
    const lines = fs.readFileSync(path.join(state.stagingRoot, 'read-receipts.jsonl'), 'utf-8').split('\n').filter((l) => l.trim());
    expect(lines).toHaveLength(2);
  });

  it('会话态（discuss）不产生回执与 segmentMap', async () => {
    const token = service.createRunContext({ runKind: 'discuss', outputRoot, knowledgeBaseRoot: kbRoot }).token;
    await expect(service.executeTool(token, 'raw_read', { objToken: 'missing' }))
      .rejects.toMatchObject({ code: 'not_found' });
  });
});

// ============================================================================
// kb_write_doc：知识声明（A 案 §7.1）
// ============================================================================

describe('kb_write_doc：原子落盘与声明', () => {
  it('旧式调用完全兼容：不带新参数不产生 knowledge-draft.json', async () => {
    const state = makeBuildState('legacy');
    const token = tokenFor(state);
    const result = await service.executeTool(token, 'kb_write_doc', { ...BASE_WRITE });
    expect(result.content[0]!.text).toContain('已写入草稿');
    const file = path.join(state.stagingRoot, 'docs', '战斗', '伤害规则.md');
    expect(fs.existsSync(file)).toBe(true);
    const raw = fs.readFileSync(file, 'utf-8');
    expect(raw).toContain('feishu_sync_kb:');
    expect(fs.existsSync(path.join(state.stagingRoot, 'knowledge-draft.json'))).toBe(false);
  });

  it('带声明写入：正文与 knowledge-draft.json 同代落盘；clientKey→objectId 映射；headingPath 解析正文范围', async () => {
    const state = makeBuildState('decl-1');
    const token = tokenFor(state);
    const result = await service.executeTool(token, 'kb_write_doc', {
      ...BASE_WRITE,
      expectedDraftRevision: 0,
      objects: [{
        clientKey: 'objDamage', type: 'rule', title: '伤害公式', familyKey: 'damage',
        variantKey: 'default', scopeKey: 'pve', scopeText: 'PVE 战斗',
        headingPath: ['伤害公式'],
        claims: [{ claimKey: 'damage-cap', riskCategory: 'high' }],
      }],
    }, { toolCallId: 'call-d1' });
    const details = result.details as Record<string, unknown>;
    expect(details.draftRevision).toBe(1);
    const objectMap = details.objectMap as Record<string, string>;
    const objectId = objectMap['objDamage']!;
    expect(objectId).toMatch(/^ko_[0-9a-f-]{36}$/);
    const draft = JSON.parse(fs.readFileSync(path.join(state.stagingRoot, 'knowledge-draft.json'), 'utf-8')) as {
      docs: Record<string, { docId: string; revision: number }>;
      objects: Array<Record<string, unknown>>;
      calls: Record<string, unknown>;
    };
    expect(draft.docs['战斗/伤害规则.md']).toEqual({ docId: details.docId, revision: 1, bodyLineOffset: 1, basis: 'draft' });
    const object = draft.objects[0]!;
    expect(object.objectId).toBe(objectId);
    expect(object.canonical).toMatchObject({ path: '战斗/伤害规则.md', anchor: objectId });
    // headingPath ['伤害公式'] → 行 1..4（下一个二级标题前）
    expect((object.canonical as { bodyRange: { startLine: number; endLine: number } }).bodyRange).toEqual({ startLine: 1, endLine: 4 });
    expect(object.businessStatus).toBe('unknown');
    expect(object.reviewStatus).toBe('pending');
    expect(object.payloadHash).toMatch(/^([0-9a-f]{64})$/);
    expect(object.revision).toBe(1);
    expect((object.claims as Array<{ claimKey: string; evidenceIds: string[] }>)[0]!.claimKey).toBe('damage-cap');
    // 幂等账本随声明同代落盘
    expect(draft.calls['call-d1']).toMatchObject({ path: '战斗/伤害规则.md', draftRevision: 1, docId: details.docId });
  });

  it('幂等：同 toolCallId 重放不重复写入、不推进修订', async () => {
    const state = makeBuildState('decl-idem');
    const token = tokenFor(state);
    const args = {
      ...BASE_WRITE,
      objects: [{ clientKey: 'objA', type: 'concept', title: '概念', familyKey: 'f', variantKey: 'default', scopeKey: 's', scopeText: '范围' }],
    };
    const first = await service.executeTool(token, 'kb_write_doc', args, { toolCallId: 'call-x' });
    expect((first.details as Record<string, unknown>).draftRevision).toBe(1);
    const replay = await service.executeTool(token, 'kb_write_doc', args, { toolCallId: 'call-x' });
    const details = replay.details as Record<string, unknown>;
    expect(details.idempotentReplay).toBe(true);
    expect(details.draftRevision).toBe(1);
    const draft = JSON.parse(fs.readFileSync(path.join(state.stagingRoot, 'knowledge-draft.json'), 'utf-8')) as { objects: unknown[] };
    expect(draft.objects).toHaveLength(1);
  });

  it('expectedDraftRevision 冲突：不覆盖并行成果（409）；追上修订后成功', async () => {
    const state = makeBuildState('decl-conflict');
    const token = tokenFor(state);
    await service.executeTool(token, 'kb_write_doc', { ...BASE_WRITE, objects: [{ clientKey: 'o', type: 'concept', title: 'T', familyKey: 'f', variantKey: 'default', scopeKey: 's', scopeText: '范围' }] });
    await expect(service.executeTool(token, 'kb_write_doc', { ...BASE_WRITE, expectedDraftRevision: 0 }))
      .rejects.toMatchObject({ code: 'kb_draft_revision_conflict', status: 409 });
    const ok = await service.executeTool(token, 'kb_write_doc', { ...BASE_WRITE, expectedDraftRevision: 1 });
    expect((ok.details as Record<string, unknown>).draftRevision).toBe(2);
  });

  it('同 clientKey 重写：身份保持；载荷不变 revision 不递增，变化才递增', async () => {
    const state = makeBuildState('decl-update');
    const token = tokenFor(state);
    const object = { clientKey: 'objKeep', type: 'rule', title: '伤害公式', familyKey: 'damage', variantKey: 'default', scopeKey: 'pve', scopeText: 'PVE 战斗', headingPath: ['伤害公式'] };
    const first = await service.executeTool(token, 'kb_write_doc', { ...BASE_WRITE, objects: [object] });
    const firstMap = (first.details as Record<string, unknown>).objectMap as Record<string, string>;
    // 相同载荷重写（正文与声明都不变）
    const same = await service.executeTool(token, 'kb_write_doc', { ...BASE_WRITE, objects: [object] });
    const sameMap = (same.details as Record<string, unknown>).objectMap as Record<string, string>;
    expect(sameMap['objKeep']).toBe(firstMap['objKeep']);
    const draft1 = JSON.parse(fs.readFileSync(path.join(state.stagingRoot, 'knowledge-draft.json'), 'utf-8')) as { objects: Array<{ objectId: string; revision: number }> };
    expect(draft1.objects).toHaveLength(1);
    expect(draft1.objects[0]!.revision).toBe(1);
    // 载荷变化（scopeKey 变化属业务语义 → payloadHash 变 → revision 递增）
    await service.executeTool(token, 'kb_write_doc', { ...BASE_WRITE, objects: [{ ...object, scopeKey: 'pvp', scopeText: 'PVP 战斗' }] });
    const draft2 = JSON.parse(fs.readFileSync(path.join(state.stagingRoot, 'knowledge-draft.json'), 'utf-8')) as { objects: Array<{ objectId: string; revision: number }> };
    expect(draft2.objects).toHaveLength(1);
    expect(draft2.objects[0]!.objectId).toBe(firstMap['objKeep']);
    expect(draft2.objects[0]!.revision).toBe(2);
  });

  it('diting F03/F06：机器审查凭据回写；载荷未变的纯重申继承审查；同族三元组新 clientKey 身份保留；旧式重写托管文档拒绝', async () => {
    const state = makeBuildState('decl-review-carry');
    const token = tokenFor(state);
    const object = { clientKey: 'objKeep', type: 'rule', title: '伤害公式', familyKey: 'damage', variantKey: 'default', scopeKey: 'pve', scopeText: 'PVE 战斗', headingPath: ['伤害公式'] };
    const first = await service.executeTool(token, 'kb_write_doc', { ...BASE_WRITE, objects: [object] });
    const objectId = ((first.details as Record<string, unknown>).objectMap as Record<string, string>)['objKeep']!;
    // F03：流水审查通过回写对象级机器审凭据（scope 命中该文档）
    const marked = await service.markObjectsMachineReviewed(state, ['战斗/伤害规则.md'], 'kr_carry_1');
    expect(marked).toBe(1);
    let draft = JSON.parse(fs.readFileSync(path.join(state.stagingRoot, 'knowledge-draft.json'), 'utf-8')) as { objects: Array<Record<string, unknown>> };
    expect(draft.objects[0]).toMatchObject({ reviewStatus: 'passed', reviewActorKind: 'machine', reviewerId: 'kr_carry_1' });
    // scope 外文档的对象不回写
    expect(await service.markObjectsMachineReviewed(state, ['战斗/其他文档.md'], 'kr_x')).toBe(0);
    // F06：纯重申（载荷与审查主体未变）继承审查凭据；新 clientKey 同族三元组身份保留
    const redeclared = await service.executeTool(token, 'kb_write_doc', {
      ...BASE_WRITE,
      objects: [{ ...object, clientKey: 'objKeepNewKey' }],
    });
    expect(((redeclared.details as Record<string, unknown>).objectMap as Record<string, string>)['objKeepNewKey']).toBe(objectId);
    draft = JSON.parse(fs.readFileSync(path.join(state.stagingRoot, 'knowledge-draft.json'), 'utf-8')) as { objects: Array<Record<string, unknown>> };
    expect(draft.objects[0]).toMatchObject({ reviewStatus: 'passed', reviewerId: 'kr_carry_1' });
    // 载荷变化（对象范围内正文变更）→ 审查不继承（回到 pending，由新审查回写）
    await service.executeTool(token, 'kb_write_doc', {
      ...BASE_WRITE, markdown: BASE_WRITE.markdown.replace('基础伤害 = 攻击力 × 倍率。', '基础伤害 = 攻击力 × 倍率，含下限保底。'),
      objects: [{ ...object, clientKey: 'objKeepNewKey' }],
    });
    draft = JSON.parse(fs.readFileSync(path.join(state.stagingRoot, 'knowledge-draft.json'), 'utf-8')) as { objects: Array<Record<string, unknown>> };
    expect(draft.objects[0]).toMatchObject({ reviewStatus: 'pending' });
    // F06：托管文档旧式重写（无声明）→ 显式拒绝，不静默降 v1
    await expect(service.executeTool(token, 'kb_write_doc', {
      path: '战斗/伤害规则.md', title: '伤害规则', markdown: '旧式重写正文', sources: ['tokA'], summary: '旧式概要',
    })).rejects.toMatchObject({ code: 'kb_object_registry_stale', status: 409 });
  });
});

describe('kb_write_doc：写入即拒（错误码复用 kb_* 系列）', () => {
  const baseObject = { clientKey: 'o1', type: 'rule', title: '规则', familyKey: 'f', variantKey: 'default', scopeKey: 's', scopeText: '范围' };

  it('scopeKey 缺失 → kb_scope_unresolved；不产生 knowledge-draft.json', async () => {
    const state = makeBuildState('rej-scope');
    const token = tokenFor(state);
    await expect(service.executeTool(token, 'kb_write_doc', {
      ...BASE_WRITE,
      objects: [{ clientKey: 'o1', type: 'rule', title: '规则', familyKey: 'f', variantKey: 'default', scopeKey: '', scopeText: '范围' }],
    })).rejects.toMatchObject({ code: 'kb_scope_unresolved' });
    // 写入即拒：正文也未写入（不部分写入）
    expect(fs.existsSync(path.join(state.stagingRoot, 'knowledge-draft.json'))).toBe(false);
    expect(fs.existsSync(path.join(state.stagingRoot, 'docs', '战斗', '伤害规则.md'))).toBe(false);
  });

  it('part_of 自环 → kb_relation_invalid', async () => {
    const state = makeBuildState('rej-selfloop');
    const token = tokenFor(state);
    await expect(service.executeTool(token, 'kb_write_doc', {
      ...BASE_WRITE,
      objects: [baseObject],
      relations: [{ fromKey: 'o1', toKey: 'o1', type: 'part_of', scopeKey: 's' }],
    })).rejects.toMatchObject({ code: 'kb_relation_invalid' });
  });

  it('非法关系词与 supersedes 缺人工决定 → kb_relation_invalid', async () => {
    const state = makeBuildState('rej-relword');
    const token = tokenFor(state);
    await expect(service.executeTool(token, 'kb_write_doc', {
      ...BASE_WRITE,
      objects: [baseObject],
      relations: [{ fromKey: 'o1', toKey: 'o1x', type: 'related_to', scopeKey: 's' }],
    })).rejects.toMatchObject({ code: 'kb_relation_invalid' });
    const state2 = makeBuildState('rej-supersedes');
    const token2 = tokenFor(state2);
    await expect(service.executeTool(token2, 'kb_write_doc', {
      ...BASE_WRITE,
      objects: [baseObject, { ...baseObject, clientKey: 'o2', familyKey: 'f2' }],
      relations: [{ fromKey: 'o1', toKey: 'o2', type: 'supersedes', scopeKey: 's' }],
    })).rejects.toMatchObject({ code: 'kb_relation_invalid' });
  });

  it('伪造 readReceiptId → kb_evidence_unresolved；文本证据缺回执同样拒绝', async () => {
    const state = makeBuildState('rej-receipt');
    const token = tokenFor(state);
    const evidence = {
      clientKey: 'ev1', objectKey: 'o1', claimKey: 'k',
      sourceRef: { sourceId: 'tokA', resourceId: 'tokA' },
      selector: { kind: 'text_span', lineStart: 2, lineEnd: 2, colStart: 1, colEnd: 0 },
      role: 'supports', nature: 'direct', readReceiptId: 'rr_forged',
    };
    await expect(service.executeTool(token, 'kb_write_doc', {
      ...BASE_WRITE, objects: [baseObject], evidenceClaims: [evidence],
    })).rejects.toMatchObject({ code: 'kb_evidence_unresolved' });
    const state2 = makeBuildState('rej-noreceipt');
    const token2 = tokenFor(state2);
    await expect(service.executeTool(token2, 'kb_write_doc', {
      ...BASE_WRITE, objects: [baseObject], evidenceClaims: [{ ...evidence, readReceiptId: undefined }],
    })).rejects.toMatchObject({ code: 'kb_evidence_unresolved' });
  });

  it('exact 片段目标未注册 → kb_include_invalid', async () => {
    const state = makeBuildState('rej-include');
    const token = tokenFor(state);
    await expect(service.executeTool(token, 'kb_write_doc', {
      ...BASE_WRITE,
      objects: [baseObject],
      presentations: [{ ownerKey: 'o1', kind: 'exact', targetKey: 'ko_00000000-0000-4000-8000-000000000000', fragmentKey: 'cap' }],
    })).rejects.toMatchObject({ code: 'kb_include_invalid' });
  });

  it('资源不在本构建资源表（resourceId 拼错）→ kb_evidence_unresolved', async () => {
    const state = makeBuildState('rej-resource');
    const token = tokenFor(state);
    await expect(service.executeTool(token, 'kb_write_doc', {
      ...BASE_WRITE,
      objects: [baseObject],
      evidenceClaims: [{
        clientKey: 'ev1', objectKey: 'o1', claimKey: 'k',
        sourceRef: { sourceId: 'tokA', resourceId: 'tokA#csv:不存在.csv' },
        selector: { kind: 'text_span', lineStart: 1, lineEnd: 1, colStart: 1, colEnd: 0 },
        role: 'supports', nature: 'direct', readReceiptId: 'rr_x',
      }],
    })).rejects.toMatchObject({ code: 'kb_evidence_unresolved' });
  });

  it('coverage 排除无理由 → kb_coverage_invalid', async () => {
    const state = makeBuildState('rej-coverage');
    const token = tokenFor(state);
    await expect(service.executeTool(token, 'kb_write_doc', {
      ...BASE_WRITE,
      coverageUpdates: [{ itemId: 'cov1', sourceId: 'tokA', category: 'formula', disposition: 'excluded_template' }],
    })).rejects.toMatchObject({ code: 'kb_coverage_invalid' });
  });
});

describe('kb_write_doc：证据声明闭环（真实回执 → 服务端复核通过）', () => {
  it('raw_read 回执 + text_span 证据通过复核并写入 evidence（quoteHash 为服务端计算）', async () => {
    const state = makeBuildState('ev-ok');
    const token = tokenFor(state);
    const read = await service.executeTool(token, 'raw_read', { objToken: 'tokA' }, { toolCallId: 'call-ev-read' });
    const receiptId = (read.details as Record<string, unknown>).readReceiptId as string;
    expect(typeof receiptId).toBe('string');
    const write = await service.executeTool(token, 'kb_write_doc', {
      ...BASE_WRITE,
      objects: [{ clientKey: 'objDmg', type: 'rule', title: '伤害公式', familyKey: 'damage', variantKey: 'default', scopeKey: 'pve', scopeText: 'PVE', headingPath: ['伤害公式'], claims: [{ claimKey: 'rate', riskCategory: 'high' }] }],
      evidenceClaims: [{
        clientKey: 'evRate', objectKey: 'objDmg', claimKey: 'rate',
        sourceRef: { sourceId: 'tokA', resourceId: 'tokA' },
        selector: { kind: 'text_span', lineStart: 2, lineEnd: 2, colStart: 1, colEnd: 0 },
        role: 'supports', nature: 'direct', readReceiptId: receiptId,
      }],
    }, { toolCallId: 'call-ev-write' });
    const details = write.details as Record<string, unknown>;
    const evidenceMap = details.evidenceMap as Record<string, string>;
    expect(evidenceMap['evRate']).toMatch(/^kev_/);
    const draft = JSON.parse(fs.readFileSync(path.join(state.stagingRoot, 'knowledge-draft.json'), 'utf-8')) as {
      evidence: Array<{ evidenceId: string; objectId: string; claimKey: string; quoteHash: string; readReceiptId: string }>;
      objects: Array<{ claims: Array<{ claimKey: string; evidenceIds: string[] }> }>;
    };
    expect(draft.evidence).toHaveLength(1);
    expect(draft.evidence[0]!.quoteHash).toBe(computeQuoteHash('倍率 2.0'));
    expect(draft.evidence[0]!.readReceiptId).toBe(receiptId);
    // claim 证据绑定回填
    expect(draft.objects[0]!.claims[0]!.evidenceIds).toEqual([evidenceMap['evRate']]);
  });

  it('selector 落在回执范围外（截断范围外）→ 拒绝', async () => {
    const state = makeBuildState('ev-beyond');
    const token = tokenFor(state);
    // 只读前 2 行 → 回执覆盖 1..2
    await service.executeTool(token, 'raw_read', { objToken: 'tokA', offset: 0, limit: 2 }, { toolCallId: 'call-ev-trunc' });
    const receipts = (JSON.parse(fs.readFileSync(path.join(state.stagingRoot, 'read-receipts.jsonl'), 'utf-8').split('\n').filter((l) => l.trim())[0]!)) as ReadReceiptRecord;
    await expect(service.executeTool(token, 'kb_write_doc', {
      ...BASE_WRITE,
      objects: [{ clientKey: 'o', type: 'rule', title: 'T', familyKey: 'f', variantKey: 'default', scopeKey: 's', scopeText: '范围' }],
      evidenceClaims: [{
        clientKey: 'ev', objectKey: 'o', claimKey: 'k',
        sourceRef: { sourceId: 'tokA', resourceId: 'tokA' },
        selector: { kind: 'text_span', lineStart: 3, lineEnd: 3, colStart: 1, colEnd: 0 },
        role: 'supports', nature: 'direct', readReceiptId: receipts.readReceiptId,
      }],
    })).rejects.toMatchObject({ code: 'kb_evidence_unresolved' });
  });
});

// ============================================================================
// kb_submit_plan / kb_get_plan（A 案 §7.2）
// ============================================================================

describe('kb_submit_plan / kb_get_plan', () => {
  it('预分配 docId/objectId；planRevision 递增；重复提交身份稳定', async () => {
    const state = makeBuildState('plan-1');
    const token = tokenFor(state, { workerId: 'w1', unitId: null, phase: 'plan' });
    const planArgs = {
      docs: [{ path: '战斗/伤害规则.md', title: '伤害规则' }, { path: '战斗/防御规则.md', title: '防御规则' }],
      objectCandidates: [
        { clientKey: 'objDamage', type: 'rule', title: '伤害公式', familyKey: 'damage', variantKey: 'default', scopeKey: 'pve', scopeText: 'PVE', canonicalPath: '战斗/伤害规则.md' },
        { clientKey: 'objDefense', type: 'rule', title: '防御公式', familyKey: 'defense', variantKey: 'default', scopeKey: 'pve', scopeText: 'PVE', canonicalPath: '战斗/防御规则.md' },
      ],
      dependencies: [{ fromKey: 'objDamage', toKey: 'objDefense', reason: '伤害先结算' }],
    };
    const first = await service.executeTool(token, 'kb_submit_plan', planArgs);
    const d1 = first.details as Record<string, unknown>;
    expect(d1.planRevision).toBe(1);
    const objectMap1 = d1.objectIdMap as Record<string, string>;
    expect(objectMap1['objDamage']).toMatch(/^ko_/);
    const docMap1 = d1.docIdMap as Record<string, string>;
    expect(docMap1['战斗/伤害规则.md']).toMatch(/^kd_/);
    // 落盘 organization-plan.json
    const planFile = JSON.parse(fs.readFileSync(path.join(state.stagingRoot, 'organization-plan.json'), 'utf-8')) as {
      planId: string; planRevision: number; docs: unknown[]; objects: unknown[]; dependencies: Array<{ fromObjectId: string; toObjectId: string }>;
    };
    expect(planFile.objects).toHaveLength(2);
    expect(planFile.dependencies[0]!.fromObjectId).toBe(objectMap1['objDamage']);
    // 重复提交：planRevision 递增、身份稳定
    const second = await service.executeTool(token, 'kb_submit_plan', planArgs);
    const d2 = second.details as Record<string, unknown>;
    expect(d2.planRevision).toBe(2);
    expect((d2.objectIdMap as Record<string, string>)['objDamage']).toBe(objectMap1['objDamage']);
    expect((d2.docIdMap as Record<string, string>)['战斗/伤害规则.md']).toBe(docMap1['战斗/伤害规则.md']);
  });

  it('结构校验拒绝项：非法路径/主位置不在计划内/依赖成环/family 三元组重复', async () => {
    const state = makeBuildState('plan-reject');
    const token = tokenFor(state, { workerId: 'w1', unitId: null, phase: 'plan' });
    const result = await service.executeTool(token, 'kb_submit_plan', {
      docs: [{ path: '战斗/伤害规则.md', title: '伤害规则' }],
      objectCandidates: [
        { clientKey: 'ok1', type: 'rule', title: 'A', familyKey: 'f1', variantKey: 'default', scopeKey: 's', scopeText: '范围', canonicalPath: '战斗/伤害规则.md' },
        { clientKey: 'badPath', type: 'rule', title: 'B', familyKey: 'f2', variantKey: 'default', scopeKey: 's', scopeText: '范围', canonicalPath: '不存在/路径.md' },
        { clientKey: 'dupFamily', type: 'rule', title: 'C', familyKey: 'f1', variantKey: 'default', scopeKey: 's', scopeText: '范围', canonicalPath: '战斗/伤害规则.md' },
      ],
      dependencies: [{ fromKey: 'ok1', toKey: 'ok1', reason: '自依赖' }],
    });
    const rejected = (result.details as Record<string, unknown>).rejected as Array<{ item: string; reason: string }>;
    const items = rejected.map((entry) => entry.item);
    expect(items).toContain('badPath');
    expect(items).toContain('dupFamily');
    expect(rejected.some((entry) => entry.reason === '自依赖')).toBe(true);
    // 合法项仍被接受
    const objectMap = (result.details as Record<string, unknown>).objectIdMap as Record<string, string>;
    expect(objectMap['ok1']).toMatch(/^ko_/);
    expect(objectMap['badPath']).toBeUndefined();
  });

  it('kb_get_plan：分页返回冻结计划与本单元负责对象（owned 标记）', async () => {
    const state = makeBuildState('plan-get');
    const planToken = tokenFor(state, { workerId: 'wp', unitId: null, phase: 'plan' });
    await service.executeTool(planToken, 'kb_submit_plan', {
      docs: [{ path: '战斗/伤害规则.md', title: '伤害' }, { path: '战斗/防御规则.md', title: '防御' }],
      objectCandidates: [
        { clientKey: 'a', type: 'rule', title: 'A', familyKey: 'fa', variantKey: 'default', scopeKey: 's', scopeText: '范围', canonicalPath: '战斗/伤害规则.md' },
        { clientKey: 'b', type: 'rule', title: 'B', familyKey: 'fb', variantKey: 'default', scopeKey: 's', scopeText: '范围', canonicalPath: '战斗/防御规则.md' },
      ],
    });
    // 单元 worker 只负责伤害路径（通过 claims 预认领）
    state.claims = new PathClaims([{ path: '战斗/伤害规则.md', unitId: 'u1' }]);
    const unitToken = tokenFor(state, { workerId: 'wu', unitId: 'u1', phase: 'unit' });
    const result = await service.executeTool(unitToken, 'kb_get_plan', { limit: 1 });
    const payload = JSON.parse(result.content[0]!.text) as {
      planId: string; planRevision: number; objects: Array<{ clientKey: string; owned: boolean }>; nextCursor: string | null;
    };
    expect(payload.planRevision).toBe(1);
    expect(payload.objects).toHaveLength(1);
    expect(payload.objects[0]!.clientKey).toBe('a');
    expect(payload.objects[0]!.owned).toBe(true);
    expect(payload.nextCursor).toBe('b');
    const page2 = JSON.parse((await service.executeTool(unitToken, 'kb_get_plan', { limit: 1, cursor: 'b' })).content[0]!.text) as { objects: Array<{ clientKey: string; owned: boolean }>; nextCursor: string | null };
    expect(page2.objects[0]!.clientKey).toBe('b');
    expect(page2.objects[0]!.owned).toBe(false);
    expect(page2.nextCursor).toBeNull();
  });

  it('phase 门禁：单元轮不能提交计划', async () => {
    const state = makeBuildState('plan-phase');
    const token = tokenFor(state, { workerId: 'w1', unitId: 'u1', phase: 'unit' });
    await expect(service.executeTool(token, 'kb_submit_plan', { docs: [] }))
      .rejects.toMatchObject({ code: 'kb_plan_phase_forbidden', status: 403 });
  });
});

// ============================================================================
// kb_submit_review（A 案 §7.1 / B 案 §5）
// ============================================================================

describe('kb_submit_review：报告绑定与审查者写入口封锁', () => {
  const reviewReport = {
    coverage: { sourceRefs: ['tokA'] },
    checkedDimensions: ['事实与数值', '术语一致性'],
    issues: [{
      draftLocation: '战斗/伤害规则.md#伤害公式 L3',
      sourceLocation: 'src-a.md L2（倍率 2.0）',
      description: '倍率抄录与源不一致',
      severity: 'blocking',
    }],
    uncheckedScope: ['图片仅按机器描述核对'],
    conclusion: 'needs_revision',
  };

  it('报告落盘 reviews/<unitId>.json 并绑定当前草稿哈希；草稿改后 hash 不匹配', async () => {
    const state = makeBuildState('review-1');
    const writerToken = tokenFor(state);
    await service.executeTool(writerToken, 'kb_write_doc', BASE_WRITE);
    const reviewToken = tokenFor(state, { workerId: 'wr', unitId: 'u1', phase: 'review' });
    const result = await service.executeTool(reviewToken, 'kb_submit_review', reviewReport);
    const details = result.details as Record<string, unknown>;
    expect(details.unitId).toBe('u1');
    expect(details.blocking).toBe(1);
    const reportFile = path.join(state.stagingRoot, 'reviews', 'u1.json');
    expect(fs.existsSync(reportFile)).toBe(true);
    const report = JSON.parse(fs.readFileSync(reportFile, 'utf-8')) as {
      reportId: string; draftHash: string; coverage: { draftHashes: string[] }; issues: Array<{ issueId: string; severity: string }>; serverVersionTag: string;
    };
    expect(report.reportId).toBe(details.reportId);
    expect(report.coverage.draftHashes).toEqual([report.draftHash]);
    expect(report.issues[0]!.issueId).toMatch(/^kri_/);
    expect(report.serverVersionTag).toBe('kb-review/1');
    // 绑定值 = 提交时 staging docs 清单哈希（computeCandidateHash 同形）
    const docFile = path.join(state.stagingRoot, 'docs', '战斗', '伤害规则.md');
    const docHash = (): string =>
      `sha256:${crypto.createHash('sha256').update(fs.readFileSync(docFile, 'utf-8'), 'utf8').digest('hex')}`;
    const expected = computeCandidateHash({ documents: [{ path: '战斗/伤害规则.md', contentHash: docHash() }] });
    expect(report.draftHash).toBe(expected);
    // 草稿改后：重算哈希 ≠ 旧报告绑定值（旧报告自动失效）
    await service.executeTool(writerToken, 'kb_write_doc', { ...BASE_WRITE, markdown: BASE_WRITE.markdown + '\n新增一行。' });
    const after = computeCandidateHash({ documents: [{ path: '战斗/伤害规则.md', contentHash: docHash() }] });
    expect(after).not.toBe(report.draftHash);
  });

  it('blocking 问题缺源位置 → 拒绝；conclusion 非法 → 拒绝', async () => {
    const state = makeBuildState('review-invalid');
    const reviewToken = tokenFor(state, { workerId: 'wr', unitId: 'u1', phase: 'review' });
    await expect(service.executeTool(reviewToken, 'kb_submit_review', {
      ...reviewReport,
      issues: [{ draftLocation: 'x.md#L1', description: '问题', severity: 'blocking' }],
    })).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(service.executeTool(reviewToken, 'kb_submit_review', { ...reviewReport, conclusion: 'approved' }))
      .rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('审查者没有任何草稿写入口（工具表断言 + 写工具执行拒绝）；撰写轮不能自审', async () => {
    const state = makeBuildState('review-gate');
    const writerToken = tokenFor(state, { workerId: 'ww', unitId: 'u1', phase: 'unit' });
    await service.executeTool(writerToken, 'kb_write_doc', BASE_WRITE);
    // 审查轮工具表：含审查提交与全部读工具，含 kb_write_doc（白名单按 runKind 派生），
    // 但审查 phase 的写执行被服务端拒绝——协议靠服务端裁决而非提示词
    const reviewToken = tokenFor(state, { workerId: 'wr', unitId: 'u1', phase: 'review' });
    const context = service.getContext(reviewToken)!;
    expect(context.allowedTools).toEqual(toolsForRunKind('build'));
    expect(context.allowedTools).toContain('kb_submit_review');
    expect(context.allowedTools).toContain('kb_write_doc');
    await expect(service.executeTool(reviewToken, 'kb_write_doc', BASE_WRITE))
      .rejects.toMatchObject({ code: 'kb_review_readonly', status: 403 });
    await expect(service.executeTool(reviewToken, 'kb_delete_doc', { path: '战斗/伤害规则.md' }))
      .rejects.toMatchObject({ code: 'kb_review_readonly', status: 403 });
    // 撰写轮调用审查提交 → 拒绝（不能自审）
    await expect(service.executeTool(writerToken, 'kb_submit_review', reviewReport))
      .rejects.toMatchObject({ code: 'kb_review_phase_forbidden', status: 403 });
    // 审查轮可以读草稿与提交报告
    const read = await service.executeTool(reviewToken, 'draft_read', { path: '战斗/伤害规则.md' });
    expect(read.details).toMatchObject({ path: '战斗/伤害规则.md' });
    const submit = await service.executeTool(reviewToken, 'kb_submit_review', reviewReport);
    expect((submit.details as Record<string, unknown>).unitId).toBe('u1');
  });
});
