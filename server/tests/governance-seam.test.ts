/**
 * diting D6 补充批：治理链闭环 seam 测试（S-F04/S-F05/S-F06 端到端串联）
 *
 * 真实链路（真实工具 + 真实发布 + 真实治理服务，无 mock）：
 * 1. 真实 kb_write_doc 创建 unknown 对象（高风险 claim + 文本证据回执）→
 *    机器审查回写 → publishRelease r1（治理未启用：高风险人审仅 warning）；
 * 2. pendingGovernanceWork：unknown 对象出现在 governable（S-F04 生命周期
 *    入口），allowedDecisionTargets=['approved']；
 * 3. recordDecision approved（desktop 面板动作的服务端 round-trip）→
 *    重发布 r2 → businessStatus=approved 生效（决定生效点=下一次发布）；
 * 4. 人审拒绝（S-F03）→ 发布阻断 kb_review_human_rejected，CURRENT 不动；
 * 5. 重新通过 → 发布 r3 成功；
 * 6. S-F06：r3 governance.json 含实际采用的人审凭据（hash 链绑定），
 *    对象 reviewActorKind='human'；清空运行期人审日志后 release 展示仍完整。
 *
 * 用例间按序共享状态（同一 describe 内顺序执行，同 knowledge-governance
 * 路由用例模式）；无模型调用、无 SQLite。
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { AgentToolService, type BuildRunState } from '../src/agent/agent-tool-service.js';
import { RawSourceSnapshot, computeSourceHash } from '../src/kb/raw-source-snapshot.js';
import { KbBuildService } from '../src/kb/kb-build-service.js';
import { AgentProcessPool } from '../src/agent/agent-process-pool.js';
import { PiRuntimeResolver } from '../src/agent/runtime-resolver.js';
import { StandardKbStore } from '../src/kb/standard-kb-store.js';
import { KnowledgeGovernanceService } from '../src/kb/knowledge-governance-service.js';
import { captureSourceContents } from '../src/kb/kb-version-store.js';
import type { RawSourceSnapshotEntry } from '../src/types/agent-knowledge.js';

let dataRoot: string;
let kbRoot: string;
let outputRoot: string;
let toolService: AgentToolService;
let buildService: KbBuildService;
let state: BuildRunState;
let entry: RawSourceSnapshotEntry;
let objectId: string;
let objectSubjectHash: string;
let objectPayloadHash: string;
let decisionId: string;
let passedReviewId: string;

const SRC_REL = 'src-cap.md';
const DOC_PATH = '规则/上限规则.md';

function writeRaw(rel: string, content: string): void {
  const target = path.join(kbRoot, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function governance(): KnowledgeGovernanceService {
  return new KnowledgeGovernanceService({ outputRoot });
}

/** staging 补齐发布材料：candidate.json + reviews/kr_1.json（docs/draft 由工具写入）。 */
function stagePublishMaterials(): void {
  fs.mkdirSync(path.join(state.stagingRoot, 'reviews'), { recursive: true });
  fs.writeFileSync(path.join(state.stagingRoot, 'reviews', 'kr_1.json'), JSON.stringify({
    reportId: 'kr_1', buildId: 'b_seam', draftHash: 'sha256:fixture',
    coverage: { draftHashes: ['sha256:fixture'], sourceRefs: [entry.objToken] },
    checkedDimensions: ['formula'], issues: [], uncheckedScope: [], conclusion: 'pass', serverVersionTag: 'd6',
  }, null, 2));
  const docsDir = path.join(state.stagingRoot, 'docs');
  fs.writeFileSync(path.join(state.stagingRoot, 'candidate.json'), JSON.stringify({
    schemaVersion: 1, buildId: 'b_seam', candidateHash: 'sha256:fixture', assembledAt: new Date().toISOString(),
    candidate: {
      buildId: 'b_seam',
      documents: fs.readdirSync(docsDir, { recursive: true })
        .filter((file): file is string => typeof file === 'string' && file.endsWith('.md'))
        .map((file) => ({ path: file, contentHash: 'sha256:fixture' })),
      acceptance: {
        acceptanceId: 'ka_seam', acceptedArtifactHash: 'sha256:fixture', validReportIds: ['kr_1'],
        programChecks: { passed: true, checkIds: ['fixture'] }, decisionMode: 'auto',
      },
      carriedOver: [],
      sourceDisposition: [{ sourceId: entry.objToken, disposition: 'referenced' }],
      changeSummary: 'seam fixture', sourceSnapshotHash: 'sha256:snap', baseReleaseId: null, publishMode: 'auto',
    },
  }, null, 2));
}

function publishArgs(releaseId: string, baseReleaseId: string | null) {
  const snapshot = RawSourceSnapshot.fromEntries([entry], { knowledgeBaseRoot: kbRoot });
  return {
    buildId: 'b_seam', releaseId, mode: 'full' as const, baseReleaseId, model: null,
    snapshot, stagingRoot: state.stagingRoot, outputRoot,
    docMeta: new Map<string, { title: string; summary: string; tags: string[]; sources: string[] }>(),
    knowledgeBaseRoot: kbRoot,
    sourceContents: captureSourceContents(snapshot, kbRoot),
  };
}

async function publish(releaseId: string, baseReleaseId: string | null) {
  stagePublishMaterials();
  return buildService.publishRelease(publishArgs(releaseId, baseReleaseId));
}

function readReleaseJson<T>(releaseId: string, file: string): T {
  return JSON.parse(fs.readFileSync(path.join(outputRoot, 'releases', releaseId, file), 'utf8')) as T;
}

beforeAll(async () => {
  dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'd6seam-data-'));
  kbRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'd6seam-kb-'));
  outputRoot = path.join(dataRoot, 'standard-kb');
  writeRaw(SRC_REL, ['# 拼点设计', '普攻伤害上限为 300%。', '背景说明。'].join('\n'));
  entry = {
    objToken: 'tokCap', objType: 'docx', title: '拼点设计', relPath: SRC_REL,
    contentHash: computeSourceHash(path.join(kbRoot, SRC_REL), [], kbRoot), objEditTime: null,
  };
  toolService = new AgentToolService({ dataRoot, documentsProvider: () => [] });
  const config = {
    standardKb: {
      outputRoot, retainReleases: 10, buildBatchSize: 10,
      promptTimeoutMinutes: 15, buildTimeoutMinutes: 180, autoBuildAfterSync: false,
    },
  };
  buildService = new KbBuildService({
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
  const stagingRoot = path.join(outputRoot, '.staging', 'b_seam');
  fs.mkdirSync(path.join(stagingRoot, 'docs'), { recursive: true });
  state = {
    knowledgeBaseRoot: kbRoot,
    snapshot: RawSourceSnapshot.fromEntries([entry], { knowledgeBaseRoot: kbRoot }),
    mode: 'full',
    workset: new Map([[entry.objToken, 'rebuild' as const]]),
    stagingRoot,
    finishInfo: null,
  };
});

afterAll(() => {
  for (const dir of [dataRoot, kbRoot]) fs.rmSync(dir, { recursive: true, force: true });
});

describe('diting D6：治理链闭环（真实工具→发布→governable→决定→重发布→人审拒绝→放行）', () => {
  it('真实工具创建 unknown 对象并发布 r1（治理未启用：高风险人审仅 warning）', async () => {
    const token = toolService.createRunContext({
      runKind: 'build', buildId: 'b_seam', outputRoot, knowledgeBaseRoot: kbRoot, buildState: state,
    }).token;
    const read = await toolService.executeTool(token, 'raw_read', { objToken: 'tokCap' }, { toolCallId: 'call-seam-read' });
    const receiptId = (read.details as Record<string, unknown>).readReceiptId as string;
    const write = await toolService.executeTool(token, 'kb_write_doc', {
      path: DOC_PATH,
      title: '上限规则',
      markdown: ['## 拼点上限', '', '普攻伤害上限为 300%，对全部普攻生效。'].join('\n'),
      sources: ['tokCap'],
      summary: '普攻伤害上限规则',
      objects: [{
        clientKey: 'objCap', type: 'rule', title: '上限规则', familyKey: 'damage-cap',
        variantKey: 'default', scopeKey: 'combat-global', scopeText: '战斗全局', headingPath: ['拼点上限'],
        claims: [{ claimKey: 'cap-300', riskCategory: 'high' }],
      }],
      evidenceClaims: [{
        clientKey: 'evCap', objectKey: 'objCap', claimKey: 'cap-300',
        sourceRef: { sourceId: 'tokCap', resourceId: 'tokCap' },
        selector: { kind: 'text_span', lineStart: 2, lineEnd: 2, colStart: 1, colEnd: 0 },
        role: 'supports', nature: 'direct', readReceiptId: receiptId,
      }],
    }, { toolCallId: 'call-seam-write' });
    const objectMap = (write.details as Record<string, unknown>).objectMap as Record<string, string>;
    objectId = objectMap['objCap']!;
    expect(objectId).toMatch(/^ko_/);
    // 机器审查凭据回写（真实工具路径；kb_review_pending 门禁前置）
    expect(await toolService.markObjectsMachineReviewed(state, null, 'kr_1')).toBe(1);

    const manifest = await publish('r_seam1', null);
    expect(manifest.schemaVersion).toBe(2);
    const knowledge = readReleaseJson<{ objects: Array<{ objectId: string; businessStatus: string; reviewSubjectHash: string; payloadHash: string; reviewActorKind?: string }> }>('r_seam1', 'knowledge.json');
    const object = knowledge.objects.find((item) => item.objectId === objectId)!;
    // 工具固定 unknown（模型不能自报状态）；机器审凭据随草稿进入 release
    expect(object.businessStatus).toBe('unknown');
    expect(object.reviewActorKind).toBe('machine');
    objectSubjectHash = object.reviewSubjectHash;
    objectPayloadHash = object.payloadHash;
    // 治理未启用（无决定/人审记录）：高风险缺人审仅 warning → 发布成功（过渡语义）
    expect(new StandardKbStore(outputRoot).readCurrent()!.releaseId).toBe('r_seam1');
    const governanceFile = readReleaseJson<{ decisions: unknown[]; humanReviewCredentials?: unknown[] }>('r_seam1', 'governance.json');
    expect(governanceFile.decisions).toEqual([]);
    expect(governanceFile.humanReviewCredentials).toBeUndefined();
  });

  it('S-F04：unknown 对象出现在 governable 且可提交 approved 决定（真实服务 round-trip）', async () => {
    const view = governance().pendingGovernanceWork();
    // E2 UNKNOWN_PANEL 反转：高风险人审提示在（无凭据），但对象可操作
    expect(view.highRisk.map((item) => item.objectId)).toEqual([objectId]);
    expect(view.candidates).toEqual([]);
    expect(view.staleDecisions).toEqual([]);
    const governable = view.governable.find((item) => item.objectId === objectId)!;
    expect(governable.businessStatus).toBe('unknown');
    expect(governable.allowedDecisionTargets).toEqual(['approved']);
    expect(governable.effectiveDecision).toBeNull();
    expect(governable.payloadHash).toBe(objectPayloadHash);

    // 面板动作 → 服务登记（expectedRevision 日志序起点 0，S-F02）
    const { decision } = governance().recordDecision({
      objectId, payloadHash: objectPayloadHash, scopeKey: 'combat-global',
      businessStatus: 'approved', rationale: '设计负责人核对源文档后批准上限规则。', expectedRevision: 0,
    });
    decisionId = decision.decisionId;
    expect(decisionId).toMatch(/^kbd_/);
    // 登记后 governable 反映有效决定链（targets 按链状态，S-F05）
    const chained = governance().pendingGovernanceWork().governable.find((item) => item.objectId === objectId)!;
    expect(chained.effectiveDecision).toMatchObject({ decisionId, businessStatus: 'approved', payloadMismatch: false });
    expect(chained.allowedDecisionTargets).toEqual(['deprecated', 'approved']);
  });

  it('决定生效点=下一次发布：人审通过后重发布 r2 → approved 生效且决定随 release 冻结', async () => {
    // 治理在用后（决定已登记）高风险缺人审升级为 blocking（过渡裁决）——
    // 先补一次通过人审，再验证决定生效链。
    governance().recordHumanReview({
      objectId, reviewSubjectHash: objectSubjectHash, passed: true, reviewerId: '主上', note: '批准前复核通过。',
    });
    const manifest = await publish('r_seam2', 'r_seam1');
    expect(new StandardKbStore(outputRoot).readCurrent()!.releaseId).toBe('r_seam2');
    expect(manifest.governance).toBeTruthy();
    const knowledge = readReleaseJson<{ objects: Array<{ objectId: string; businessStatus: string }> }>('r_seam2', 'knowledge.json');
    expect(knowledge.objects.find((item) => item.objectId === objectId)!.businessStatus).toBe('approved');
    const governanceFile = readReleaseJson<{ decisions: Array<{ decisionId: string; objectId: string; businessStatus: string }> }>('r_seam2', 'governance.json');
    expect(governanceFile.decisions).toEqual([
      expect.objectContaining({ decisionId, objectId, businessStatus: 'approved' }),
    ]);
  });

  it('S-F03：人审拒绝 → 发布阻断（kb_review_human_rejected），CURRENT 不动', async () => {
    const review = governance().recordHumanReview({
      objectId, reviewSubjectHash: objectSubjectHash, passed: false, reviewerId: '主上', note: '上限数值与源不符，驳回。',
    });
    expect(review.passed).toBe(false);
    await expect(publish('r_seam3', 'r_seam2')).rejects.toMatchObject({
      code: 'kb_publish_blocked',
      message: expect.stringContaining('kb_review_human_rejected'),
    } as never);
    // CURRENT 不动；无半成品 release；report 落盘含专用码
    expect(new StandardKbStore(outputRoot).readCurrent()!.releaseId).toBe('r_seam2');
    expect(fs.existsSync(path.join(outputRoot, 'releases', 'r_seam3'))).toBe(false);
    const report = JSON.parse(fs.readFileSync(path.join(outputRoot, '.builds', 'b_seam', 'report.json'), 'utf8')) as { issues: Array<{ code: string }> };
    expect(report.issues.some((issue) => issue.code === 'kb_review_human_rejected')).toBe(true);
    // pendingGovernanceWork 共用聚合：拒绝后回到待复核
    const view = governance().pendingGovernanceWork();
    expect(view.highRisk.map((item) => item.objectId)).toEqual([objectId]);
    expect(view.governable.find((item) => item.objectId === objectId)!.humanReviewed).toBe(false);
  });

  it('拒绝→重新通过：发布 r3 成功；S-F06 凭据随 release 冻结（hash 链一致 + reviewActorKind=human）', async () => {
    const review = governance().recordHumanReview({
      objectId, reviewSubjectHash: objectSubjectHash, passed: true, reviewerId: '主上', note: '复核通过：数值与源一致。',
    });
    passedReviewId = review.reviewId;
    const manifest = await publish('r_seam3', 'r_seam2');
    expect(new StandardKbStore(outputRoot).readCurrent()!.releaseId).toBe('r_seam3');

    // S-F06：实际采用的人审凭据投影进 governance.json（manifest hash 链绑定）
    const releaseDir = path.join(outputRoot, 'releases', 'r_seam3');
    const governanceBytes = fs.readFileSync(path.join(releaseDir, 'governance.json'));
    expect(manifest.governance!.hash).toBe(`sha256:${crypto.createHash('sha256').update(governanceBytes).digest('hex')}`);
    const governanceFile = JSON.parse(governanceBytes.toString('utf8')) as {
      humanReviewCredentials?: Array<{ reviewId: string; objectId: string; reviewSubjectHash: string; passed: boolean; logIndex: number; actor: string; createdAt: string }>;
    };
    const credential = governanceFile.humanReviewCredentials?.find((item) => item.objectId === objectId);
    expect(credential).toMatchObject({
      reviewId: passedReviewId, objectId, reviewSubjectHash: objectSubjectHash, passed: true, actor: 'desktop-human',
    });
    expect(credential.logIndex).toBeGreaterThanOrEqual(0); // 运行期日志记录序随凭据冻结
    // 发布时按采用凭据写 reviewActorKind='human'（对象自持凭据）
    const knowledge = readReleaseJson<{ objects: Array<{ objectId: string; reviewActorKind?: string; reviewerId?: string }> }>('r_seam3', 'knowledge.json');
    const object = knowledge.objects.find((item) => item.objectId === objectId)!;
    expect(object.reviewActorKind).toBe('human');
    expect(object.reviewerId).toBe('主上');
  });

  it('S-F06：运行期人审日志清空后 release 治理展示仍完整（读 sidecar 凭据不读运行期日志）', async () => {
    // 清空运行期治理日志（模拟迁移/丢失）
    fs.rmSync(path.join(outputRoot, '.governance', 'human-reviews.jsonl'), { force: true });
    // release sidecar 凭据与 manifest hash 链不变（不可变 release 自持证据）
    const releaseDir = path.join(outputRoot, 'releases', 'r_seam3');
    const governanceFile = JSON.parse(fs.readFileSync(path.join(releaseDir, 'governance.json'), 'utf8')) as {
      humanReviewCredentials?: Array<{ reviewId: string }>;
    };
    expect(governanceFile.humanReviewCredentials?.some((item) => item.reviewId === passedReviewId)).toBe(true);
    const knowledge = readReleaseJson<{ objects: Array<{ objectId: string; reviewActorKind?: string }> }>('r_seam3', 'knowledge.json');
    expect(knowledge.objects.find((item) => item.objectId === objectId)!.reviewActorKind).toBe('human');
    // 运行期联查回退 release 对象自持凭据：不再出现在待复核（humanReviewed=true）
    const view = governance().pendingGovernanceWork();
    expect(view.highRisk).toEqual([]);
    expect(view.governable.find((item) => item.objectId === objectId)!.humanReviewed).toBe(true);
    // 决定日志仍在：有效决定链不因人审日志清理丢失
    expect(view.governable.find((item) => item.objectId === objectId)!.effectiveDecision?.decisionId).toBe(decisionId);
  });

  it('approved 停用与恢复：governable 生命周期全程可达（S-F04 转移表）', async () => {
    const service = governance();
    // approved → deprecated（停用）
    const deprecated = service.recordDecision({
      objectId, payloadHash: objectPayloadHash, scopeKey: 'combat-global',
      businessStatus: 'deprecated', rationale: '机制已被新公式取代，停用。',
      supersedesDecisionId: decisionId, expectedRevision: 1,
    });
    expect(deprecated.decision.businessStatus).toBe('deprecated');
    const view = service.pendingGovernanceWork();
    const entryView = view.governable.find((item) => item.objectId === objectId)!;
    expect(entryView.effectiveDecision).toMatchObject({ businessStatus: 'deprecated' });
    // deprecated → approved（恢复使用需新决定；targets 按链状态）
    expect(entryView.allowedDecisionTargets).toEqual(['approved']);
    const restored = service.recordDecision({
      objectId, payloadHash: objectPayloadHash, scopeKey: 'combat-global',
      businessStatus: 'approved', rationale: '回滚决定：恢复使用上限规则。',
      supersedesDecisionId: deprecated.decision.decisionId, expectedRevision: 2,
    });
    expect(restored.decision.businessStatus).toBe('approved');
    expect(service.pendingGovernanceWork().governable.find((item) => item.objectId === objectId)!.effectiveDecision)
      .toMatchObject({ businessStatus: 'approved', payloadMismatch: false });
  });
});
