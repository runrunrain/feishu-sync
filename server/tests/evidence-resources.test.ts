/**
 * D3：工作簿/图片证据资源端到端（A 案 §5.2/§5.4/§6.2）
 *
 * 覆盖：
 * - 工作簿证据端到端：快照含声明 XLSX → kb_write_doc 带 WorkbookCells
 *   证据（写入即拒校验：服务端解引用 + quoteHash 复核）→ 发布 →
 *   evidence/ 含区间最小快照（单元格/公式/合并信息 + 源工作簿 hash 与
 *   路径）+ evidenceFiles 登记 + manifest hash 链一致。
 * - 图片证据：图片资源 + 描述 → MediaRegion 证据（imageHash 服务端钉住）
 *   → 发布落盘本体（不只留描述）；描述快照随 evidenceFiles 登记。
 * - 体量预算：超限 → kb_evidence_unresolved blocking、CURRENT 不动、
 *   半成品 release 清理、report 列出各资源体量。
 * - 校验拒绝：伪造回执 / imageHash 不符 / 区间越界（合并主格）/ 未合并
 *   主格冒充 / 未描述图片 / 发布期 resourceHash 篡改。
 *
 * 模式：真实文件系统 fixture（ExcelJS 构造真实 xlsx）+ 手工注入识图描述；
 * 无模型调用、无 SQLite。
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import ExcelJS from 'exceljs';
import { AgentToolService, type BuildRunState } from '../src/agent/agent-tool-service.js';
import { RawSourceSnapshot, computeSourceHash } from '../src/kb/raw-source-snapshot.js';
import { KbBuildService } from '../src/kb/kb-build-service.js';
import { AgentProcessPool } from '../src/agent/agent-process-pool.js';
import { PiRuntimeResolver } from '../src/agent/runtime-resolver.js';
import { StandardKbStore } from '../src/kb/standard-kb-store.js';
import { captureSourceContents } from '../src/kb/kb-version-store.js';
import { EVIDENCE_BUDGET_MIN_BYTES } from '../src/types/agent-knowledge.js';
import type { ImageDescription } from '../src/agent/vision/vision-describer.js';
import type { RawSourceSnapshotEntry } from '../src/types/agent-knowledge.js';

let dataRoot: string;
let kbRoot: string;
let outputRoot: string;
let toolService: AgentToolService;

const shaOf = (bytes: Buffer | string): string =>
  `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;

const TINY_PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('d3-image-fixture'),
]);

/** 声明工作簿 fixture：数值表 A1=10、B1=20、B2=公式 B1*2（缓存 40）、B3:C3 合并。 */
let XLSX_BYTES = Buffer.alloc(0);
const WB_TOKEN = 'tokW';
const WB_NAME = 'src-wb.xlsx';
const WB_RESOURCE_ID = `${WB_TOKEN}#workbook:${WB_NAME}`;
const IMG_TOKEN = 'tokImg';
const IMG_SRC = 'images/pic.png';
const IMG_RESOURCE_ID = `${IMG_TOKEN}#image:${IMG_SRC}`;
const IMG_CAPTION = '图中标注了倍率 2.0 与上限 500。';

function writeRaw(rel: string, content: string | Buffer): void {
  const target = path.join(kbRoot, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function workbookEntry(): RawSourceSnapshotEntry {
  return {
    objToken: WB_TOKEN, objType: 'sheet', title: '数值源', relPath: 'src-wb.md',
    contentHash: computeSourceHash(path.join(kbRoot, 'src-wb.md'), [], kbRoot), objEditTime: null,
  };
}

function imageEntry(): RawSourceSnapshotEntry {
  return {
    objToken: IMG_TOKEN, objType: 'docx', title: '图片源', relPath: 'src-img.md',
    contentHash: computeSourceHash(path.join(kbRoot, 'src-img.md'), [], kbRoot), objEditTime: null,
  };
}

function snapshotOf(entries: RawSourceSnapshotEntry[]): RawSourceSnapshot {
  return RawSourceSnapshot.fromEntries(entries, { knowledgeBaseRoot: kbRoot });
}

function makeBuildState(stagingName: string, entries: RawSourceSnapshotEntry[], descriptions?: Map<string, Map<string, ImageDescription>>): BuildRunState {
  const stagingRoot = path.join(dataRoot, 'staging', stagingName);
  fs.rmSync(stagingRoot, { recursive: true, force: true });
  fs.mkdirSync(path.join(stagingRoot, 'docs'), { recursive: true });
  return {
    knowledgeBaseRoot: kbRoot,
    snapshot: snapshotOf(entries),
    mode: 'full',
    workset: new Map(entries.map((entry) => [entry.objToken, 'rebuild' as const])),
    stagingRoot,
    finishInfo: null,
    ...(descriptions ? { imageDescriptions: descriptions } : {}),
  };
}

function tokenFor(state: BuildRunState): string {
  return toolService.createRunContext({
    runKind: 'build', buildId: 'b_d3', outputRoot, knowledgeBaseRoot: kbRoot, buildState: state,
  }).token;
}

function makeService(evidenceBudgetBytes?: number): KbBuildService {
  const config = {
    standardKb: {
      outputRoot, retainReleases: 10, buildBatchSize: 10,
      promptTimeoutMinutes: 15, buildTimeoutMinutes: 180, autoBuildAfterSync: false,
      ...(evidenceBudgetBytes !== undefined ? { evidenceBudgetBytes } : {}),
    },
  };
  return new KbBuildService({
    dataRoot,
    pool: new AgentProcessPool({ maxConcurrentProcesses: 1 }),
    toolService: new AgentToolService({ dataRoot, documentsProvider: () => [] }),
    resolver: new PiRuntimeResolver(),
    configProvider: () => config as never,
    documentsProvider: () => [],
    sheetCsvPaths: () => [],
    internalBaseUrl: () => 'http://127.0.0.1:39999',
    extensionPath: () => null,
    promptAssets: () => null,
  });
}

/** staging 补齐发布材料：candidate.json + reviews/kr_1.json（draft/docs 由工具写入）。 */
function stagePublishMaterials(stagingRoot: string, entries: RawSourceSnapshotEntry[]): void {
  fs.mkdirSync(path.join(stagingRoot, 'reviews'), { recursive: true });
  fs.writeFileSync(path.join(stagingRoot, 'reviews', 'kr_1.json'), JSON.stringify({
    reportId: 'kr_1', buildId: 'b_d3', draftHash: 'sha256:fixture',
    coverage: { draftHashes: ['sha256:fixture'], sourceRefs: entries.map((entry) => entry.objToken) },
    checkedDimensions: ['formula'], issues: [], uncheckedScope: [], conclusion: 'pass', serverVersionTag: 'd3',
  }, null, 2));
  fs.writeFileSync(path.join(stagingRoot, 'candidate.json'), JSON.stringify({
    schemaVersion: 1, buildId: 'b_d3', candidateHash: 'sha256:fixture', assembledAt: new Date().toISOString(),
    candidate: {
      buildId: 'b_d3',
      documents: fs.readdirSync(path.join(stagingRoot, 'docs'), { recursive: true })
        .filter((file): file is string => typeof file === 'string' && String(file).endsWith('.md'))
        .map((file) => ({ path: String(file), contentHash: 'sha256:fixture' })),
      acceptance: {
        acceptanceId: 'ka_d3', acceptedArtifactHash: 'sha256:fixture', validReportIds: ['kr_1'],
        programChecks: { passed: true, checkIds: ['fixture'] }, decisionMode: 'auto',
      },
      carriedOver: [],
      sourceDisposition: entries.map((entry) => ({ sourceId: entry.objToken, disposition: 'referenced' })),
      changeSummary: 'd3 fixture', sourceSnapshotHash: 'sha256:snap', baseReleaseId: null, publishMode: 'auto',
    },
  }, null, 2));
}

function publishArgs(stagingRoot: string, releaseId: string, entries: RawSourceSnapshotEntry[], descriptions?: Map<string, Map<string, ImageDescription>>) {
  const snapshot = snapshotOf(entries);
  return {
    buildId: 'b_d3', releaseId, mode: 'full' as const, baseReleaseId: null, model: null,
    snapshot, stagingRoot, outputRoot,
    docMeta: new Map<string, { title: string; summary: string; tags: string[]; sources: string[] }>(),
    knowledgeBaseRoot: kbRoot,
    sourceContents: captureSourceContents(snapshot, kbRoot),
    ...(descriptions ? { imageDescriptions: descriptions } : {}),
  };
}

const WB_WRITE = {
  path: '战斗/工作簿伤害规则.md',
  title: '工作簿伤害规则',
  markdown: ['## 伤害公式', '', '基础伤害 = 攻击力 × 倍率，倍率与上限以数值表为准。'].join('\n'),
  sources: [WB_TOKEN],
  summary: '工作簿倍率规则',
};

beforeAll(async () => {
  dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'd3ev-data-'));
  kbRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'd3ev-kb-'));
  outputRoot = path.join(dataRoot, 'standard-kb');
  toolService = new AgentToolService({ dataRoot, documentsProvider: () => [] });

  // 声明工作簿源（md 头 source_workbook 标记 → 计入 contentHash）
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('数值');
  sheet.getCell('A1').value = 10;
  sheet.getCell('B1').value = 20;
  sheet.getCell('B2').value = { formula: 'B1*2', result: 40 };
  sheet.mergeCells('B3:C3');
  sheet.getCell('B3').value = '合计';
  XLSX_BYTES = Buffer.from(await workbook.xlsx.writeBuffer());
  writeRaw(WB_NAME, XLSX_BYTES);
  writeRaw('src-wb.md', `<!--\nfeishu_sync:\n  source_workbook: "${WB_NAME}"\n-->\n# 数值源\n倍率基准与合计见工作簿。\n`);

  // 图片源
  writeRaw(IMG_SRC, TINY_PNG);
  writeRaw('src-img.md', `# 图片源\n![倍率图](${IMG_SRC})\n正文。\n`);
});

afterAll(() => {
  for (const dir of [dataRoot, kbRoot]) fs.rmSync(dir, { recursive: true, force: true });
});

// ============================================================================
// 工作簿证据端到端
// ============================================================================

describe('工作簿证据端到端（A 案 §5.2/§5.4）', () => {
  it('声明 XLSX → WorkbookCells 证据通过写入校验 → 发布 evidence/ 区间最小快照 + evidenceFiles + manifest hash 链', async () => {
    const entries = [workbookEntry()];
    const state = makeBuildState('wb-e2e', entries);
    const token = tokenFor(state);
    // 模型先读源（回执登记；工作簿证据不依赖行回执）
    await toolService.executeTool(token, 'raw_read', { objToken: WB_TOKEN }, { toolCallId: 'call-wb-read' });

    const write = await toolService.executeTool(token, 'kb_write_doc', {
      ...WB_WRITE,
      objects: [{
        clientKey: 'objWb', type: 'rule', title: '伤害公式', familyKey: 'damage-wb', variantKey: 'default',
        scopeKey: 'pve', scopeText: 'PVE 战斗', headingPath: ['伤害公式'],
        claims: [{ claimKey: 'wb-rate', riskCategory: 'high' }],
      }],
      evidenceClaims: [{
        clientKey: 'evWb', objectKey: 'objWb', claimKey: 'wb-rate',
        sourceRef: { sourceId: WB_TOKEN, resourceId: WB_RESOURCE_ID },
        selector: {
          kind: 'workbook_cells', workbookName: WB_NAME, sheet: '数值', rangeA1: 'A1:B2',
          mergedCellAnchors: [], valueNature: 'mixed',
        },
        role: 'supports', nature: 'derived',
      }],
    }, { toolCallId: 'call-wb-write' });
    const evidenceMap = (write.details as Record<string, unknown>).evidenceMap as Record<string, string>;
    expect(evidenceMap['evWb']).toMatch(/^kev_/);

    // 草稿中的 selector 已带工作簿资源身份（resourceHash = xlsx 字节哈希）
    const draft = JSON.parse(fs.readFileSync(path.join(state.stagingRoot, 'knowledge-draft.json'), 'utf8')) as {
      evidence: Array<{ sourceRef: { resourceHash: string; resourceId: string }; selector: Record<string, unknown> }>;
    };
    expect(draft.evidence[0]!.sourceRef.resourceHash).toBe(shaOf(XLSX_BYTES));
    expect(draft.evidence[0]!.selector.kind).toBe('workbook_cells');

    await toolService.markObjectsMachineReviewed(state, [WB_WRITE.path], 'kr_1');
    stagePublishMaterials(state.stagingRoot, entries);

    const service = makeService();
    const manifest = await service.publishRelease(publishArgs(state.stagingRoot, 'r_d3w', entries));
    expect(manifest.schemaVersion).toBe(2);

    const releaseDir = path.join(outputRoot, 'releases', 'r_d3w');
    // evidence/：区间最小快照（不复制整个工作簿）
    const evidenceDir = path.join(releaseDir, 'evidence');
    const files = fs.readdirSync(evidenceDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^workbook-.*\.json$/);
    const snapshotFile = JSON.parse(fs.readFileSync(path.join(evidenceDir, files[0]!), 'utf8')) as {
      resourceId: string; workbookName: string; workbookResourceHash: string; sourceWorkbookPath: string;
      evidenceIds: string[]; ranges: Array<{
        sheet: string; rangeA1: string; valueNature: string; mergedCellAnchors: string[];
        cells: Array<{ a1: string; value: string; formula: string | null }>;
      }>;
    };
    expect(snapshotFile.resourceId).toBe(WB_RESOURCE_ID);
    expect(snapshotFile.workbookResourceHash).toBe(shaOf(XLSX_BYTES));
    expect(snapshotFile.sourceWorkbookPath).toBe(WB_NAME);
    expect(snapshotFile.evidenceIds).toEqual([evidenceMap['evWb']]);
    const range = snapshotFile.ranges[0]!;
    expect(range.sheet).toBe('数值');
    expect(range.rangeA1).toBe('A1:B2');
    const cellsByA1 = new Map(range.cells.map((cell) => [cell.a1, cell]));
    expect(cellsByA1.get('A1')).toEqual({ a1: 'A1', value: '10', formula: null });
    expect(cellsByA1.get('B1')).toEqual({ a1: 'B1', value: '20', formula: null });
    expect(cellsByA1.get('A2')).toEqual({ a1: 'A2', value: '', formula: null });
    // 公式文本与缓存值性质分离（缓存值不代表本轮计算，A 案 §5.2）
    expect(cellsByA1.get('B2')).toEqual({ a1: 'B2', value: '40', formula: 'B1*2' });

    // evidence-resources.json：evidenceFiles 登记（路径+hash+类型+引用 evidenceId）
    const evidenceIndex = JSON.parse(fs.readFileSync(path.join(releaseDir, 'evidence-resources.json'), 'utf8')) as {
      resources: Array<{ resourceId: string; kind: string }>;
      evidenceFiles: Array<{ resourceId: string; path: string; hash: string; bytes: number; kind: string; evidenceIds: string[] }>;
    };
    expect(evidenceIndex.resources.some((resource) => resource.resourceId === WB_RESOURCE_ID && resource.kind === 'workbook')).toBe(true);
    expect(evidenceIndex.evidenceFiles).toHaveLength(1);
    const entry = evidenceIndex.evidenceFiles[0]!;
    expect(entry.kind).toBe('workbook');
    expect(entry.path).toBe(`evidence/${files[0]}`);
    expect(entry.evidenceIds).toEqual([evidenceMap['evWb']]);
    const fileBytes = fs.readFileSync(path.join(releaseDir, entry.path));
    expect(entry.bytes).toBe(fileBytes.length);
    expect(entry.hash).toBe(shaOf(fileBytes));
    // manifest hash 链：manifest.evidence.hash 覆盖 evidence-resources.json
    expect(manifest.evidence!.hash).toBe(shaOf(fs.readFileSync(path.join(releaseDir, 'evidence-resources.json'))));
    // CURRENT 切换
    expect(new StandardKbStore(outputRoot).readCurrent()!.releaseId).toBe('r_d3w');
  });

  it('发布期 resourceHash 篡改 → 门禁重解引用 blocking（kb_evidence_unresolved），CURRENT 不动', async () => {
    const entries = [workbookEntry()];
    const state = makeBuildState('wb-tamper', entries);
    const token = tokenFor(state);
    await toolService.executeTool(token, 'kb_write_doc', {
      ...WB_WRITE,
      objects: [{
        clientKey: 'objWb', type: 'rule', title: '伤害公式', familyKey: 'damage-wb', variantKey: 'default',
        scopeKey: 'pve', scopeText: 'PVE 战斗', headingPath: ['伤害公式'],
        claims: [{ claimKey: 'wb-rate', riskCategory: 'high' }],
      }],
      evidenceClaims: [{
        clientKey: 'evWb', objectKey: 'objWb', claimKey: 'wb-rate',
        sourceRef: { sourceId: WB_TOKEN, resourceId: WB_RESOURCE_ID },
        selector: { kind: 'workbook_cells', workbookName: WB_NAME, sheet: '数值', rangeA1: 'A1:B2', mergedCellAnchors: [], valueNature: 'mixed' },
        role: 'supports', nature: 'derived',
      }],
    });
    await toolService.markObjectsMachineReviewed(state, [WB_WRITE.path], 'kr_1');
    stagePublishMaterials(state.stagingRoot, entries);
    // 直接落盘篡改：resourceHash 指向另一“版本”
    const draftPath = path.join(state.stagingRoot, 'knowledge-draft.json');
    const draft = JSON.parse(fs.readFileSync(draftPath, 'utf8')) as { evidence: Array<{ sourceRef: { resourceHash: string } }> };
    draft.evidence[0]!.sourceRef.resourceHash = 'sha256:tampered';
    fs.writeFileSync(draftPath, JSON.stringify(draft, null, 2));

    const service = makeService();
    await expect(service.publishRelease(publishArgs(state.stagingRoot, 'r_d3tamper', entries)))
      .rejects.toMatchObject({ code: 'kb_publish_blocked' });
    const report = JSON.parse(fs.readFileSync(path.join(outputRoot, '.builds', 'b_d3', 'report.json'), 'utf8')) as { issues: Array<{ code: string; message: string }> };
    expect(report.issues.some((issue) => issue.code === 'kb_evidence_unresolved' && issue.message.includes('resourceHash 对账失败'))).toBe(true);
    expect(new StandardKbStore(outputRoot).readCurrent()!.releaseId).toBe('r_d3w');
    expect(fs.existsSync(path.join(outputRoot, 'releases', 'r_d3tamper'))).toBe(false);
  });
});

// ============================================================================
// 图片证据端到端与预算
// ============================================================================

describe('图片证据端到端（A 案 §5.1/§5.4）', () => {
  const descriptionsOf = (caption = IMG_CAPTION): Map<string, Map<string, ImageDescription>> =>
    new Map([[IMG_TOKEN, new Map<string, ImageDescription>([[IMG_SRC, {
      src: IMG_SRC, imageHash: '', state: 'described', text: caption,
    }]])]]);

  const IMG_WRITE = {
    path: '战斗/图片倍率规则.md',
    title: '图片倍率规则',
    markdown: ['## 倍率上限', '', '倍率上限 500 由倍率图给出。'].join('\n'),
    sources: [IMG_TOKEN],
    summary: '图片倍率规则',
  };

  async function writeImageClaim(state: BuildRunState, overrides: Record<string, unknown> = {}): Promise<void> {
    const token = tokenFor(state);
    const write = await toolService.executeTool(token, 'kb_write_doc', {
      ...IMG_WRITE,
      objects: [{
        clientKey: 'objImg', type: 'rule', title: '倍率上限', familyKey: 'damage-img', variantKey: 'default',
        scopeKey: 'pve', scopeText: 'PVE 战斗', headingPath: ['倍率上限'],
        claims: [{ claimKey: 'img-cap', riskCategory: 'normal' }],
      }],
      evidenceClaims: [{
        clientKey: 'evImg', objectKey: 'objImg', claimKey: 'img-cap',
        sourceRef: { sourceId: IMG_TOKEN, resourceId: IMG_RESOURCE_ID },
        selector: { kind: 'media_region' },
        role: 'supports', nature: 'machine_description',
        ...overrides,
      }],
    });
    expect((write.details as Record<string, unknown>).evidenceMap).toBeTruthy();
    await toolService.markObjectsMachineReviewed(state, [IMG_WRITE.path], 'kr_1');
    stagePublishMaterials(state.stagingRoot, [imageEntry()]);
  }

  it('MediaRegion 证据（imageHash 服务端钉住）→ 发布落盘图片本体 + 描述快照登记', async () => {
    const descriptions = descriptionsOf();
    const entries = [imageEntry()];
    const state = makeBuildState('img-e2e', entries, descriptions);
    await writeImageClaim(state);

    // 草稿 selector.imageHash 已按资源钉住（sha256:图片字节）
    const draft = JSON.parse(fs.readFileSync(path.join(state.stagingRoot, 'knowledge-draft.json'), 'utf8')) as {
      evidence: Array<{ selector: { imageHash: string }; quoteHash: string }>;
    };
    expect(draft.evidence[0]!.selector.imageHash).toBe(shaOf(TINY_PNG));

    const service = makeService();
    const manifest = await service.publishRelease(publishArgs(state.stagingRoot, 'r_d3img', entries, descriptions));
    expect(manifest.schemaVersion).toBe(2);

    const releaseDir = path.join(outputRoot, 'releases', 'r_d3img');
    const evidenceIndex = JSON.parse(fs.readFileSync(path.join(releaseDir, 'evidence-resources.json'), 'utf8')) as {
      evidenceFiles: Array<{ kind: string; path: string; hash: string; bytes: number; evidenceIds: string[]; image?: { src: string; imageHash: string; caption: string } }>;
    };
    expect(evidenceIndex.evidenceFiles).toHaveLength(1);
    const entry = evidenceIndex.evidenceFiles[0]!;
    expect(entry.kind).toBe('image');
    expect(entry.hash).toBe(shaOf(TINY_PNG));
    // 本体落盘（不能悄悄仅留描述）
    const imageBytes = fs.readFileSync(path.join(releaseDir, entry.path));
    expect(imageBytes.equals(TINY_PNG)).toBe(true);
    // 描述快照随登记保留
    expect(entry.image).toMatchObject({ src: IMG_SRC, imageHash: shaOf(TINY_PNG), caption: IMG_CAPTION });
    expect(manifest.evidence!.hash).toBe(shaOf(fs.readFileSync(path.join(releaseDir, 'evidence-resources.json'))));
    expect(new StandardKbStore(outputRoot).readCurrent()!.releaseId).toBe('r_d3img');
  });

  it('超预算 → kb_evidence_unresolved blocking、CURRENT 不动、report 列出各资源体量', async () => {
    // 1.2MB 图片 + 预算压到下限 1MB → 超限
    const bigImage = Buffer.alloc(EVIDENCE_BUDGET_MIN_BYTES + 200 * 1024, 7);
    writeRaw(IMG_SRC, bigImage);
    const caption = '大图描述';
    const descriptions = descriptionsOf(caption);
    const entries = [imageEntry()];
    const state = makeBuildState('img-budget', entries, descriptions);
    await writeImageClaim(state);

    const service = makeService(EVIDENCE_BUDGET_MIN_BYTES);
    await expect(service.publishRelease(publishArgs(state.stagingRoot, 'r_d3big', entries, descriptions)))
      .rejects.toMatchObject({ code: 'kb_publish_blocked' });
    const report = JSON.parse(fs.readFileSync(path.join(outputRoot, '.builds', 'b_d3', 'report.json'), 'utf8')) as { issues: Array<{ code: string; message: string }> };
    const budgetIssue = report.issues.find((issue) => issue.code === 'kb_evidence_unresolved' && issue.message.includes('超过预算'));
    expect(budgetIssue).toBeTruthy();
    expect(budgetIssue!.message).toContain('image-');
    // CURRENT 仍指向上一次成功发布；半成品 release 清理
    expect(new StandardKbStore(outputRoot).readCurrent()!.releaseId).toBe('r_d3img');
    expect(fs.existsSync(path.join(outputRoot, 'releases', 'r_d3big'))).toBe(false);
    // 恢复小图供后续用例
    writeRaw(IMG_SRC, TINY_PNG);
  });
});

// ============================================================================
// 写入即拒（A 案 §5.3：回执与资源必须真实）
// ============================================================================

describe('kb_write_doc 工作簿/图片证据写入即拒', () => {
  const baseObject = {
    clientKey: 'objR', type: 'rule', title: '规则', familyKey: 'f-r', variantKey: 'default',
    scopeKey: 's', scopeText: '范围', headingPath: ['伤害公式'],
    claims: [{ claimKey: 'k', riskCategory: 'normal' }],
  };
  const imgObject = { ...baseObject, headingPath: ['倍率上限'] };

  it('伪造 readReceiptId → kb_evidence_unresolved（回执登记之外的 ID 不可引用）', async () => {
    const entries = [workbookEntry()];
    const state = makeBuildState('rej-forged', entries);
    const token = tokenFor(state);
    await expect(toolService.executeTool(token, 'kb_write_doc', {
      ...WB_WRITE,
      objects: [baseObject],
      evidenceClaims: [{
        clientKey: 'ev', objectKey: 'objR', claimKey: 'k',
        sourceRef: { sourceId: WB_TOKEN, resourceId: WB_RESOURCE_ID },
        selector: { kind: 'workbook_cells', workbookName: WB_NAME, sheet: '数值', rangeA1: 'A1:B2', mergedCellAnchors: [], valueNature: 'mixed' },
        role: 'supports', nature: 'derived', readReceiptId: 'rr_forged',
      }],
    })).rejects.toMatchObject({ code: 'kb_evidence_unresolved', message: expect.stringContaining('伪造') });
  });

  it('区间越界（合并主格不在区间内）拒绝；未合并主格冒充拒绝', async () => {
    const entries = [workbookEntry()];
    const state = makeBuildState('rej-anchor', entries);
    const token = tokenFor(state);
    await expect(toolService.executeTool(token, 'kb_write_doc', {
      ...WB_WRITE,
      objects: [baseObject],
      evidenceClaims: [{
        clientKey: 'ev', objectKey: 'objR', claimKey: 'k',
        sourceRef: { sourceId: WB_TOKEN, resourceId: WB_RESOURCE_ID },
        selector: { kind: 'workbook_cells', workbookName: WB_NAME, sheet: '数值', rangeA1: 'A1:A1', mergedCellAnchors: ['B3'], valueNature: 'cached_value' },
        role: 'supports', nature: 'derived',
      }],
    })).rejects.toMatchObject({ code: 'kb_evidence_unresolved', message: expect.stringContaining('合并主格不在区间内') });
    await expect(toolService.executeTool(token, 'kb_write_doc', {
      ...WB_WRITE,
      objects: [baseObject],
      evidenceClaims: [{
        clientKey: 'ev', objectKey: 'objR', claimKey: 'k',
        sourceRef: { sourceId: WB_TOKEN, resourceId: WB_RESOURCE_ID },
        selector: { kind: 'workbook_cells', workbookName: WB_NAME, sheet: '数值', rangeA1: 'A1:B1', mergedCellAnchors: ['A1'], valueNature: 'cached_value' },
        role: 'supports', nature: 'derived',
      }],
    })).rejects.toMatchObject({ code: 'kb_evidence_unresolved', message: expect.stringContaining('合并主格与资源合并表不符') });
  });

  it('imageHash 显式提供但与资源不符拒绝；未描述图片不在资源表（unavailable 不得充当支撑）', async () => {
    const entries = [imageEntry()];
    const descriptions = new Map([[IMG_TOKEN, new Map([[IMG_SRC, {
      src: IMG_SRC, imageHash: '', state: 'described', text: IMG_CAPTION,
    }]])]]);
    const state = makeBuildState('rej-image', entries, descriptions);
    const token = tokenFor(state);
    await expect(toolService.executeTool(token, 'kb_write_doc', {
      path: '战斗/图片倍率规则.md', title: '图片倍率规则',
      markdown: ['## 倍率上限', '', '倍率上限 500 由倍率图给出。'].join('\n'),
      sources: [IMG_TOKEN], summary: '图片倍率规则',
      objects: [imgObject],
      evidenceClaims: [{
        clientKey: 'ev', objectKey: 'objR', claimKey: 'k',
        sourceRef: { sourceId: IMG_TOKEN, resourceId: IMG_RESOURCE_ID },
        selector: { kind: 'media_region', imageHash: 'sha256:deadbeef' },
        role: 'supports', nature: 'machine_description',
      }],
    })).rejects.toMatchObject({ code: 'kb_evidence_unresolved', message: expect.stringContaining('imageHash 不符') });

    // 无描述 → 图片资源不登记 → 引用即拒
    const bareState = makeBuildState('rej-image-bare', entries);
    const bareToken = tokenFor(bareState);
    await expect(toolService.executeTool(bareToken, 'kb_write_doc', {
      path: '战斗/图片倍率规则.md', title: '图片倍率规则',
      markdown: ['## 倍率上限', '', '倍率上限 500 由倍率图给出。'].join('\n'),
      sources: [IMG_TOKEN], summary: '图片倍率规则',
      objects: [imgObject],
      evidenceClaims: [{
        clientKey: 'ev', objectKey: 'objR', claimKey: 'k',
        sourceRef: { sourceId: IMG_TOKEN, resourceId: IMG_RESOURCE_ID },
        selector: { kind: 'media_region' },
        role: 'supports', nature: 'machine_description',
      }],
    })).rejects.toMatchObject({ code: 'kb_evidence_unresolved', message: expect.stringContaining('不在本构建资源表') });
  });
});

// ============================================================================
// diting S-F01：共享声明整包覆盖竞态（构建级互斥队列）
// ============================================================================

describe('diting S-F01：并发 kb_write_doc 声明不互相覆盖', () => {
  it('两个并发 kb_write_doc（一方 XLSX 证据装配延迟）→ docs/objects/clientKeys/calls/evidence 双方均存活', async () => {
    const entries = [workbookEntry()];
    const state = makeBuildState('sf01-race', entries);
    // 同一 BuildRunState 的两个运行上下文 = 同 build 的两个 worker（并行构建
    // 共享声明文件 knowledge-draft.json 的真实形态；路径认领互不冲突）。
    const wbToken = tokenFor(state);
    const plainToken = tokenFor(state);
    // worker A：带工作簿证据（ExcelJS 异步解析——无互斥时该 await 让出事件
    // 循环，构成 E1 复现的交错窗口）；worker B：纯对象声明（同步路径）。
    const wbWrite = toolService.executeTool(wbToken, 'kb_write_doc', {
      path: '战斗/工作簿竞态规则.md',
      title: '工作簿竞态规则',
      markdown: ['## 公式', '', '倍率以数值表为准。'].join('\n'),
      sources: [WB_TOKEN],
      summary: '工作簿竞态规则',
      objects: [{
        clientKey: 'objWbRace', type: 'rule', title: '工作簿竞态规则', familyKey: 'damage-race-wb',
        variantKey: 'default', scopeKey: 'pve', scopeText: 'PVE 战斗', headingPath: ['公式'],
      }],
      evidenceClaims: [{
        clientKey: 'evWbRace', objectKey: 'objWbRace', claimKey: 'wb-rate',
        sourceRef: { sourceId: WB_TOKEN, resourceId: WB_RESOURCE_ID },
        selector: {
          kind: 'workbook_cells', workbookName: WB_NAME, sheet: '数值', rangeA1: 'A1:B1',
          mergedCellAnchors: [], valueNature: 'mixed',
        },
        role: 'supports', nature: 'derived',
      }],
    }, { toolCallId: 'call-race-wb' });
    const plainWrite = toolService.executeTool(plainToken, 'kb_write_doc', {
      path: '战斗/普通竞态规则.md',
      title: '普通竞态规则',
      markdown: ['## 规则', '', '普通规则正文。'].join('\n'),
      sources: [WB_TOKEN],
      summary: '普通竞态规则',
      objects: [{
        clientKey: 'objPlainRace', type: 'concept', title: '普通竞态规则', familyKey: 'concept-race',
        variantKey: 'default', scopeKey: 'pve', scopeText: 'PVE 战斗', headingPath: ['规则'],
      }],
    }, { toolCallId: 'call-race-plain' });
    const [wbResult, plainResult] = await Promise.all([wbWrite, plainWrite]);
    // draftRevision 按文档计（不同路径各自首写 → 均 1）；两份正文均落盘
    expect((wbResult.details as Record<string, unknown>).draftRevision).toBe(1);
    expect((plainResult.details as Record<string, unknown>).draftRevision).toBe(1);

    // 反例反转（E1 PARALLEL_DECLARATIONS）：整包覆盖消灭——后提交者的深拷贝
    // 基于最新全局版本，双方登记同时存活。
    const draft = JSON.parse(fs.readFileSync(path.join(state.stagingRoot, 'knowledge-draft.json'), 'utf8')) as {
      docs: Record<string, unknown>;
      objects: Array<{ objectId: string; title: string }>;
      clientKeys: Record<string, string>;
      evidence: Array<{ evidenceId: string }>;
      calls: Record<string, unknown>;
    };
    expect(Object.keys(draft.docs).sort()).toEqual(['战斗/工作簿竞态规则.md', '战斗/普通竞态规则.md']);
    expect(draft.objects.map((object) => object.title).sort()).toEqual(['工作簿竞态规则', '普通竞态规则']);
    expect(draft.clientKeys['objWbRace']).toMatch(/^ko_/);
    expect(draft.clientKeys['objPlainRace']).toMatch(/^ko_/);
    expect(draft.evidence).toHaveLength(1); // 工作簿证据声明存活（旧实现被 B 覆盖丢失）
    expect(draft.calls['call-race-wb']).toMatchObject({ path: '战斗/工作簿竞态规则.md' });
    expect(draft.calls['call-race-plain']).toMatchObject({ path: '战斗/普通竞态规则.md' });
  });

  it('审查凭据回写与并发声明共用互斥：markObjectsMachineReviewed 不被整包覆盖', async () => {
    const entries = [workbookEntry()];
    const state = makeBuildState('sf01-review-race', entries);
    const wbToken = tokenFor(state);
    const plainToken = tokenFor(state);
    // 预置已声明对象（draft v1：普通规则）
    await toolService.executeTool(plainToken, 'kb_write_doc', {
      path: '战斗/审查普通规则.md',
      title: '审查普通规则',
      markdown: ['## 规则', '', '普通规则正文。'].join('\n'),
      sources: [WB_TOKEN],
      summary: '审查普通规则',
      objects: [{
        clientKey: 'objReviewPlain', type: 'concept', title: '审查普通规则', familyKey: 'concept-race-review',
        variantKey: 'default', scopeKey: 'pve', scopeText: 'PVE 战斗', headingPath: ['规则'],
      }],
    }, { toolCallId: 'call-review-plain' });
    // 并发：worker A 声明（XLSX 异步装配窗口）+ 流水审查凭据回写。
    // 无互斥时的确定性别：A 先深拷贝共享草稿并在 ExcelJS 解析处让出；
    // 回写同步完成并保存；A 恢复后把不含回写的旧副本整包保存——凭据丢失。
    // 互斥后二者排队串行，先后无关，成果共存。
    const wbWrite = toolService.executeTool(wbToken, 'kb_write_doc', {
      path: '战斗/审查竞态规则.md',
      title: '审查竞态规则',
      markdown: ['## 公式', '', '倍率以数值表为准。'].join('\n'),
      sources: [WB_TOKEN],
      summary: '审查竞态规则',
      objects: [{
        clientKey: 'objReviewRace', type: 'rule', title: '审查竞态规则', familyKey: 'damage-race-review',
        variantKey: 'default', scopeKey: 'pve', scopeText: 'PVE 战斗', headingPath: ['公式'],
      }],
      evidenceClaims: [{
        clientKey: 'evReviewRace', objectKey: 'objReviewRace', claimKey: 'wb-rate',
        sourceRef: { sourceId: WB_TOKEN, resourceId: WB_RESOURCE_ID },
        selector: {
          kind: 'workbook_cells', workbookName: WB_NAME, sheet: '数值', rangeA1: 'A1:B1',
          mergedCellAnchors: [], valueNature: 'mixed',
        },
        role: 'supports', nature: 'derived',
      }],
    }, { toolCallId: 'call-review-race-wb' });
    const marked = toolService.markObjectsMachineReviewed(state, null, 'kr_race');
    const [wbResult] = await Promise.all([wbWrite, marked]);
    expect((wbResult.details as Record<string, unknown>).draftRevision).toBe(1); // 该文档首写
    const draft = JSON.parse(fs.readFileSync(path.join(state.stagingRoot, 'knowledge-draft.json'), 'utf8')) as {
      objects: Array<{ title: string; reviewStatus: string; reviewActorKind?: string; reviewerId?: string }>;
    };
    // 双方成果共存：A 的对象/证据登记存活 + 两个对象的机器审查凭据存活
    expect(draft.objects.map((object) => object.title).sort()).toEqual(['审查普通规则', '审查竞态规则']);
    for (const object of draft.objects) {
      expect(object).toMatchObject({ reviewStatus: 'passed', reviewActorKind: 'machine', reviewerId: 'kr_race' });
    }
  });
});

