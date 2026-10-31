/**
 * T4a：知识编译与发布（A 案 §3.2 exact 片段编译、§6.2 发布布局、
 * §7.4 新增门禁、§10.2 v1/v2 双读）
 *
 * 覆盖：编译器（展开/缺失/修订不匹配/代码块不展开/链接重定位/锚点注入/
 * bodyRange 坐标）、门禁（合法零 blocking 与各 kb_* 阻断、审查凭据、
 * warnings 通道、sidecar 一致性、证据重解引用）、发布布局（v2 sidecar +
 * manifest hash + CURRENT 切换 + 阻断不动指针 + staging 保留）、双读器
 * （v1 全兼容、v2 正文与 v1 等价、knowledge.json 损坏组织查询失败不降级）。
 * 全部为确定性纯函数与真实文件系统 fixture，无模型调用。
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { compileKnowledgeRelease, type CompilerDocInput, type KnowledgeDeclarationSet } from '../src/kb/knowledge-compiler.js';
import { runKnowledgeGates, type GateSidecarInput } from '../src/kb/knowledge-validator.js';
import { KbBuildService } from '../src/kb/kb-build-service.js';
import { RawSourceSnapshot, computeSourceHash } from '../src/kb/raw-source-snapshot.js';
import { StandardKbStore } from '../src/kb/standard-kb-store.js';
import { AgentToolService } from '../src/agent/agent-tool-service.js';
import { AgentProcessPool } from '../src/agent/agent-process-pool.js';
import { PiRuntimeResolver } from '../src/agent/runtime-resolver.js';
import { resolveRelease } from '../src/kb/search/release-reader.js';
import { buildKbIndex } from '../src/kb/search/kb-index.js';
import { computeQuoteHash, contentResourceHash } from '../src/kb/evidence-locator.js';
import { captureSourceContents } from '../src/kb/kb-version-store.js';
import {
  computePayloadHash,
  computeReviewSubjectHash,
  type BodyRange,
  type CoverageItem,
  type Evidence,
  type KnowledgeObject,
  type Presentation,
} from '../src/kb/knowledge-schema.js';
import type { CandidateRelease, ReviewReport } from '../src/kb/orchestration-contracts.js';
import type { RawSourceSnapshotEntry } from '../src/types/agent-knowledge.js';

let dataRoot: string;
let kbRoot: string;
let outputRoot: string;

beforeAll(() => {
  dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kbkp-data-'));
  kbRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kbkp-kb-'));
  outputRoot = path.join(dataRoot, 'standard-kb');
});
afterAll(() => {
  fs.rmSync(dataRoot, { recursive: true, force: true });
  fs.rmSync(kbRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// fixture：原始源 + staging 文档/声明
// ---------------------------------------------------------------------------

const SRC_REL = 'src-a.md';
const SRC_LINES = ['# 攻防拼点设计', '普攻伤害上限为 300%。', '其余为背景说明。'];
const SRC_CONTENT = SRC_LINES.join('\n');

function sourceEntry(): RawSourceSnapshotEntry {
  fs.mkdirSync(kbRoot, { recursive: true });
  fs.writeFileSync(path.join(kbRoot, SRC_REL), SRC_CONTENT);
  return {
    objToken: 'tokSrc', objType: 'docx', title: '拼点设计', relPath: SRC_REL,
    contentHash: computeSourceHash(path.join(kbRoot, SRC_REL), [], kbRoot), objEditTime: null,
  };
}

function snapshot(): RawSourceSnapshot {
  fs.writeFileSync(path.join(kbRoot, SRC_REL), SRC_CONTENT);
  return RawSourceSnapshot.fromEntries([sourceEntry()], { knowledgeBaseRoot: kbRoot });
}

const header = (docId: string): string =>
  `<!--\nfeishu_sync_kb:\n  doc_id: ${docId}\n  sources:\n    - tokSrc\n  build_id: b_kp\n-->\n`;

const DAMAGE_BODY = [
  '# 伤害规则',
  '## 普攻伤害公式',
  '<!-- kb-fragment:damage-formula -->',
  '普攻伤害 = 攻防修正 × 基础攻击力，上限 300%。',
  '适用条件见 [作战单元说明](units/unit.md#ko_objUnit)。',
  '定理锚点 [公式定义](#ko_objDamage)。',
  '<!-- /kb-fragment:damage-formula -->',
].join('\n');
const UNIT_BODY = ['# 作战单元', '作战单元是普攻伤害的计算主体。'].join('\n');
const OVERVIEW_BODY = [
  '# 战斗总览',
  '## 伤害计算',
  '{{kb-include:ko_objDamage:damage-formula}}',
  '上述公式与主定义保持一致。',
].join('\n');
const SYNTAX_BODY = [
  '# 语法示例',
  '受控片段引用语法示例（不展开）：',
  '```',
  '{{kb-include:ko_objDamage:damage-formula}}',
  '<a id="sample-in-code"></a>',
  '```',
].join('\n');

function fixtureDocs(extra: CompilerDocInput[] = []): CompilerDocInput[] {
  return [
    { path: 'damage.md', content: header('kd_damage') + DAMAGE_BODY + '\n' },
    { path: 'units/unit.md', content: header('kd_unit') + UNIT_BODY + '\n' },
    { path: 'combat/overview.md', content: header('kd_overview') + OVERVIEW_BODY + '\n' },
    { path: 'syntax.md', content: header('kd_syntax') + SYNTAX_BODY + '\n' },
    ...extra,
  ];
}

function objectOf(
  objectId: string,
  docId: string,
  docPath: string,
  bodyRange: BodyRange,
  body: string,
  overrides: Partial<KnowledgeObject> = {},
): KnowledgeObject {
  const object: KnowledgeObject = {
    objectId, type: 'rule', title: objectId, aliases: [], domainIds: [],
    familyKey: `fam:${objectId}`, variantKey: 'default', scopeKey: 'combat-global', scopeText: '战斗全局',
    canonical: { docId, path: docPath, anchor: objectId, bodyRange },
    revision: 1, locationRevision: 0, payloadHash: '', reviewSubjectHash: '',
    // diting F03：pending 对象已不能随 release 发布（门禁 blocking）——
    // happy fixture 默认携带流水审查通过的机器审凭据。
    businessStatus: 'candidate', reviewStatus: 'passed', reviewActorKind: 'machine', reviewerId: 'kr_1',
    reviewedAt: '2026-11-01T00:00:00Z', claims: [],
    ...overrides,
  };
  object.payloadHash = computePayloadHash(object, body);
  object.reviewSubjectHash = computeReviewSubjectHash({ payloadHash: object.payloadHash, evidence: [], relations: [] });
  return object;
}

function evidenceOf(entry: RawSourceSnapshotEntry, overrides: Partial<Evidence> = {}): Evidence {
  return {
    evidenceId: 'kev_cap', objectId: 'ko_objDamage', claimKey: 'cap-300',
    sourceRef: {
      sourceId: 'tokSrc', sourceSnapshotHash: entry.contentHash,
      resourceId: 'tokSrc', resourceHash: contentResourceHash(SRC_CONTENT),
    },
    selector: { kind: 'text_span', lineStart: 2, lineEnd: 2, colStart: 1, colEnd: 0, headingPath: ['攻防拼点设计'] },
    quoteHash: computeQuoteHash(SRC_LINES[1]!),
    role: 'supports', nature: 'direct', readReceiptId: 'krr_1',
    ...overrides,
  };
}

function coverageOf(entry: RawSourceSnapshotEntry, overrides: Partial<CoverageItem> = {}): CoverageItem {
  return {
    itemId: 'cov-1',
    sourceRef: {
      sourceId: 'tokSrc', sourceSnapshotHash: entry.contentHash,
      resourceId: 'tokSrc', resourceHash: contentResourceHash(SRC_CONTENT),
    },
    category: 'formula', importance: 'important', disposition: 'mapped', targetObjectIds: ['ko_objDamage'],
    ...overrides,
  };
}

/** happy fixture：3 对象 + 1 exact 呈现 + 高风险 claim 证据 + mapped 覆盖。 */
function happyDraft(mutate?: (draft: KnowledgeDeclarationSet) => void): KnowledgeDeclarationSet {
  const entry = sourceEntry();
  const draft: KnowledgeDeclarationSet = {
    schemaVersion: 1,
    buildId: 'b_kp',
    docs: {
      'damage.md': { docId: 'kd_damage', revision: 1 },
      'units/unit.md': { docId: 'kd_unit', revision: 1 },
      'combat/overview.md': { docId: 'kd_overview', revision: 1 },
      'syntax.md': { docId: 'kd_syntax', revision: 1 },
    },
    objects: [
      objectOf('ko_objDamage', 'kd_damage', 'damage.md', { startLine: 2, endLine: 7 }, DAMAGE_BODY, {
        type: 'rule',
        claims: [{ claimKey: 'cap-300', bodyRange: { startLine: 4, endLine: 4 }, riskCategory: 'high', evidenceIds: ['kev_cap'] }],
      }),
      objectOf('ko_objUnit', 'kd_unit', 'units/unit.md', { startLine: 1, endLine: 2 }, UNIT_BODY, { type: 'concept' }),
      objectOf('ko_objOverview', 'kd_overview', 'combat/overview.md', { startLine: 1, endLine: 4 }, OVERVIEW_BODY, { type: 'overview' }),
    ],
    presentations: [{
      presentationId: 'kp_exact_1', ownerObjectId: 'ko_objOverview', kind: 'exact',
      targetObjectId: 'ko_objDamage', targetRevision: 1, fragmentKey: 'damage-formula',
    } as Presentation],
    relations: [],
    evidence: [evidenceOf(entry)],
    coverage: [coverageOf(entry)],
  };
  mutate?.(draft);
  return draft;
}

function candidateOf(draft: KnowledgeDeclarationSet, validReportIds: string[] | null = ['kr_1']): CandidateRelease | null {
  if (validReportIds === null) return null;
  const documents = Object.keys(draft.docs).map((docPath) => ({ path: docPath, contentHash: 'sha256:fixture' }));
  return {
    buildId: 'b_kp', documents,
    acceptance: {
      acceptanceId: 'ka_1', acceptedArtifactHash: 'sha256:fixture', validReportIds,
      programChecks: { passed: true, checkIds: ['fixture'] }, decisionMode: 'auto',
    },
    carriedOver: [], sourceDisposition: [{ sourceId: 'tokSrc', disposition: 'referenced' }],
    changeSummary: 'fixture', sourceSnapshotHash: 'sha256:snap', baseReleaseId: null, publishMode: 'auto',
  };
}

function reviewPool(): ReviewReport[] {
  return [{
    reportId: 'kr_1', buildId: 'b_kp', draftHash: 'sha256:fixture',
    coverage: { draftHashes: ['sha256:fixture'], sourceRefs: ['tokSrc'] },
    checkedDimensions: ['formula'], issues: [], uncheckedScope: [], conclusion: 'pass', serverVersionTag: 't',
  }];
}

function sidecarsOf(compiled: ReturnType<typeof compileKnowledgeRelease>): GateSidecarInput {
  const sha = (bytes: string): string => `sha256:${crypto.createHash('sha256').update(bytes, 'utf8').digest('hex')}`;
  const knowledgeBytes = `${JSON.stringify(compiled.knowledge, null, 2)}\n`;
  const evidenceBytes = `${JSON.stringify(compiled.evidenceResources, null, 2)}\n`;
  const governanceBytes = `${JSON.stringify({ schemaVersion: 1, releaseId: 'r_kp', reviewCredentials: { validReportIds: ['kr_1'] }, decisions: [] }, null, 2)}\n`;
  return {
    organization: { path: 'knowledge.json', hash: sha(knowledgeBytes), bytes: knowledgeBytes },
    evidence: { resourcesPath: 'evidence-resources.json', hash: sha(evidenceBytes), bytes: evidenceBytes },
    governance: { path: 'governance.json', hash: sha(governanceBytes), bytes: governanceBytes },
  };
}

function gatesOf(options: {
  draft?: KnowledgeDeclarationSet;
  docs?: CompilerDocInput[];
  candidate?: CandidateRelease | null;
  reviews?: ReviewReport[];
  sidecars?: GateSidecarInput | false;
  previousObjectIds?: string[];
} = {}) {
  const snap = snapshot();
  const draft = options.draft ?? happyDraft();
  const docs = options.docs ?? fixtureDocs();
  const compiled = compileKnowledgeRelease({
    docs, knowledgeDraft: draft, releaseId: 'r_kp',
    evidenceResources: [{
      resource: {
        resourceId: 'tokSrc', kind: 'text', content: SRC_CONTENT, sourceId: 'tokSrc',
        sourceSnapshotHash: snap.entries[0]!.contentHash, resourceHash: contentResourceHash(SRC_CONTENT),
      },
      span: { byteOffset: 0, byteLength: Buffer.byteLength(SRC_CONTENT, 'utf8') },
    }],
    ...(options.previousObjectIds ? { previousObjectIds: options.previousObjectIds } : {}),
  });
  return runKnowledgeGates({
    compiled,
    candidate: options.candidate === undefined ? candidateOf(draft) : options.candidate,
    reviews: options.reviews ?? reviewPool(),
    snapshot: snap,
    knowledgeBaseRoot: kbRoot,
    receipts: [{ readReceiptId: 'krr_1', resourceId: 'tokSrc', lineStart: 1, lineEnd: 3 }],
    ...(options.sidecars === false ? {} : { sidecars: options.sidecars ?? sidecarsOf(compiled) }),
  });
}

// ---------------------------------------------------------------------------
// 编译器（A 案 §3.2）
// ---------------------------------------------------------------------------

/** 编译器测试便利入口：携带快照同源的证据资源表。 */
function compileOf(draft: KnowledgeDeclarationSet, docs: CompilerDocInput[] = fixtureDocs()) {
  return compileKnowledgeRelease({
    docs, knowledgeDraft: draft, releaseId: 'r_kp',
    evidenceResources: [{
      resource: {
        resourceId: 'tokSrc', kind: 'text', content: SRC_CONTENT, sourceId: 'tokSrc',
        sourceSnapshotHash: sourceEntry().contentHash, resourceHash: contentResourceHash(SRC_CONTENT),
      },
      span: { byteOffset: 0, byteLength: Buffer.byteLength(SRC_CONTENT, 'utf8') },
    }],
  });
}

describe('编译器：exact 片段展开', () => {
  it('正常展开：占位符替换为片段全文，片段标记保留在 canonical 正文', () => {
    const draft = happyDraft();
    const { knowledge, compiledDocs, issues } = compileOf(draft);
    expect(issues.filter((item) => item.severity === 'blocking')).toEqual([]);
    const overview = compiledDocs.find((doc) => doc.path === 'combat/overview.md')!;
    const body = overview.content.split('\n').slice(6).join('\n'); // 去头部
    expect(body).toContain('普攻伤害 = 攻防修正 × 基础攻击力，上限 300%。');
    expect(body).not.toContain('{{kb-include:');
    const damage = compiledDocs.find((doc) => doc.path === 'damage.md')!;
    expect(damage.content).toContain('<!-- kb-fragment:damage-formula -->');
    // exact 呈现 bodyRange = 展开区间；canonical 呈现自动生成
    const exact = knowledge.presentations.find((p) => p.presentationId === 'kp_exact_1')!;
    expect(exact.bodyRange).toEqual({ startLine: 4, endLine: 6 });
    const canonPres = knowledge.presentations.filter((p) => p.kind === 'canonical');
    expect(canonPres).toHaveLength(3);
    // restates 由 exact 登记自动生成（A 案 §6.1）
    expect(knowledge.relations.some((r) => r.type === 'restates' && r.fromObjectId === 'ko_objOverview' && r.toObjectId === 'ko_objDamage')).toBe(true);
  });

  it('片段内链接重定位为宿主文档相对路径（跨目录 + 裸锚点）', () => {
    const { compiledDocs } = compileOf(happyDraft());
    const overview = compiledDocs.find((doc) => doc.path === 'combat/overview.md')!;
    expect(overview.content).toContain('[作战单元说明](../units/unit.md#ko_objUnit)');
    expect(overview.content).toContain('[公式定义](../damage.md#ko_objDamage)');
    // canonical 文档自身链接不被改写（相对根目录）
    const damage = compiledDocs.find((doc) => doc.path === 'damage.md')!;
    expect(damage.content).toContain('[作战单元说明](units/unit.md#ko_objUnit)');
  });

  it('目标缺失 / 片段不存在 → blocking kb_include_invalid', () => {
    const missingTarget = happyDraft((draft) => {
      draft.presentations = [{
        presentationId: 'kp_exact_1', ownerObjectId: 'ko_objOverview', kind: 'exact',
        targetObjectId: 'ko_ghost', targetRevision: 1, fragmentKey: 'damage-formula',
      } as Presentation];
    });
    const ghost = compileOf(missingTarget);
    expect(ghost.issues.some((item) => item.code === 'kb_include_invalid' && item.severity === 'blocking')).toBe(true);

    const missingFragment = happyDraft((draft) => {
      (draft.presentations[0] as Presentation).fragmentKey = 'not-declared';
    });
    const noFrag = compileOf(missingFragment);
    expect(noFrag.issues.some((item) => item.code === 'kb_include_invalid' && item.severity === 'blocking')).toBe(true);
  });

  it('目标 revision 不匹配 → blocking kb_restatement_stale（片段字节级校验）', () => {
    const draft = happyDraft((d) => {
      (d.presentations[0] as Presentation).targetRevision = 0;
    });
    const { issues } = compileOf(draft);
    expect(issues.some((item) => item.code === 'kb_restatement_stale' && item.severity === 'blocking')).toBe(true);
  });

  it('跨范围错用（宿主与目标 scopeKey 不一致）→ blocking', () => {
    const draft = happyDraft((d) => {
      const overview = d.objects.find((o) => o.objectId === 'ko_objOverview')!;
      overview.scopeKey = 'other-scope';
    });
    const { issues } = compileOf(draft);
    expect(issues.some((item) => item.code === 'kb_include_invalid' && item.severity === 'blocking'
      && item.message.includes('跨范围'))).toBe(true);
  });

  it('代码块中的示例语法不展开、代码内 HTML 原样保留', () => {
    const { compiledDocs, issues } = compileOf(happyDraft());
    const syntax = compiledDocs.find((doc) => doc.path === 'syntax.md')!;
    expect(syntax.content).toContain('{{kb-include:ko_objDamage:damage-formula}}');
    expect(syntax.content).toContain('<a id="sample-in-code"></a>');
    expect(issues.filter((item) => item.severity === 'blocking')).toEqual([]);
  });
});

describe('diting F02/F07：坐标基准与围栏状态机', () => {
  it('F02：draft 基准（markdown 参数坐标 + bodyLineOffset）重映射——章节对象不串位', () => {
    // 文档 = 头 + '# 坐标文档'（工具生成标题）+ 正文四行；声明坐标以
    // markdown 参数为基准（bodyLineOffset=1），不得相差一个生成标题。
    const body = ['## Alpha', 'ALPHA_ONLY 正文。', '## Beta', 'BETA_ONLY 正文。'].join('\n');
    const docs: CompilerDocInput[] = [{ path: 'coord.md', content: `${header('kd_coord')}# 坐标文档\n${body}\n` }];
    const draft: KnowledgeDeclarationSet = {
      schemaVersion: 1, buildId: 'b_kp',
      docs: { 'coord.md': { docId: 'kd_coord', revision: 1, basis: 'draft', bodyLineOffset: 1 } },
      objects: [
        objectOf('ko_a', 'kd_coord', 'coord.md', { startLine: 1, endLine: 2 }, '## Alpha\nALPHA_ONLY 正文。', {
          familyKey: 'fam:a',
          claims: [{ claimKey: 'a-cap', bodyRange: { startLine: 2, endLine: 2 }, riskCategory: 'normal', evidenceIds: [] }],
        }),
        objectOf('ko_b', 'kd_coord', 'coord.md', { startLine: 3, endLine: 4 }, '## Beta\nBETA_ONLY 正文。', {
          familyKey: 'fam:b',
        }),
      ],
      presentations: [], relations: [], evidence: [], coverage: [],
    };
    const { knowledge, compiledDocs, issues } = compileOf(draft, docs);
    expect(issues.filter((item) => item.severity === 'blocking')).toEqual([]);
    const compiled = compiledDocs.find((doc) => doc.path === 'coord.md')!.content;
    const lines = compiled.replace(/^<!--\s*\nfeishu_sync_kb:[\s\S]*?\n-->\s*\n?/, '').split('\n');
    const sliceOf = (objectId: string): string[] => {
      const object = knowledge.objects.find((candidate) => candidate.objectId === objectId)!;
      return lines.slice(object.canonical!.bodyRange.startLine - 1, object.canonical!.bodyRange.endLine);
    };
    // 不复现 diting 的 ko_b => [anchor, ALPHA_ONLY, ## Beta] 错位
    expect(sliceOf('ko_a')).toEqual(['<a id="ko_a"></a>', '## Alpha', 'ALPHA_ONLY 正文。']);
    expect(sliceOf('ko_b')).toEqual(['<a id="ko_b"></a>', '## Beta', 'BETA_ONLY 正文。']);
    const a = knowledge.objects.find((object) => object.objectId === 'ko_a')!;
    // claim 同步重映射：markdown 参数行 2（ALPHA_ONLY）→ 发布行 4（标题+锚点后）
    expect(a.claims[0]!.bodyRange).toEqual({ startLine: 4, endLine: 4 });
    expect(lines[3]).toBe('ALPHA_ONLY 正文。');
  });

  it('F07：四反引号围栏内的三反引号不关栏——include 示例与链接不误判', () => {
    const fenced = [
      '# 语法示例',
      '````',
      '```',
      '{{kb-include:ko_objDamage:damage-formula}}',
      '[断链示例](missing-target.md)',
      '```',
      '````',
    ].join('\n');
    const docs = fixtureDocs().map((doc) =>
      doc.path === 'syntax.md' ? { path: doc.path, content: `${header('kd_syntax')}${fenced}\n` } : doc);
    // 编译器：围栏内示例语法不展开（旧状态机会提前关栏 → kb_include_invalid）
    const { compiledDocs, issues } = compileOf(happyDraft(), docs);
    expect(issues.filter((item) => item.severity === 'blocking')).toEqual([]);
    expect(compiledDocs.find((doc) => doc.path === 'syntax.md')!.content).toContain('{{kb-include:ko_objDamage:damage-formula}}');
    // 链接检查同一状态机：围栏内断链示例不触发 kb_link_invalid；围栏外断链仍拦截
    const { knowledge } = compileOf(happyDraft(), docs);
    const gates = runKnowledgeGates({
      compiled: { knowledge, compiledDocs, issues, evidenceResources: { schemaVersion: 1, normalization: 'utf8-bytes-in-source-contents', resources: [], evidenceFiles: [] } },
      candidate: candidateOf(happyDraft()), reviews: reviewPool(), snapshot: snapshot(), knowledgeBaseRoot: kbRoot,
    });
    expect(gates.blocking.filter((item) => item.code === 'kb_link_invalid')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 门禁（A 案 §7.4）
// ---------------------------------------------------------------------------

describe('门禁：runKnowledgeGates', () => {
  it('合法全链路零 blocking（结构 + 链接 + 凭据 + sidecar + 证据重解引用）', () => {
    const gates = gatesOf();
    expect(gates.blocking).toEqual([]);
  });

  it('重复主定义（同 familyKey+variantKey+scopeKey）→ kb_object_duplicate blocking', () => {
    const gates = gatesOf({
      draft: happyDraft((draft) => {
        draft.objects.push(objectOf('ko_objDup', 'kd_damage', 'damage.md', { startLine: 1, endLine: 1 }, '# 重复', {
          familyKey: 'fam:ko_objDamage',
        }));
      }),
    });
    expect(gates.blocking.some((item) => item.code === 'kb_object_duplicate')).toBe(true);
  });

  it('悬空关系端点 → kb_relation_invalid blocking', () => {
    const gates = gatesOf({
      draft: happyDraft((draft) => {
        draft.relations.push({
          edgeId: 'ke_ghost', fromObjectId: 'ko_ghost', toObjectId: 'ko_objDamage',
          type: 'depends_on', scopeKey: 'combat-global', evidenceIds: [],
        });
      }),
    });
    expect(gates.blocking.some((item) => item.code === 'kb_relation_invalid')).toBe(true);
  });

  it('高风险 claim 无证据 → kb_evidence_unresolved blocking', () => {
    const gates = gatesOf({
      draft: happyDraft((draft) => {
        draft.evidence = [];
        draft.objects[0]!.claims = [{ claimKey: 'cap-300', bodyRange: { startLine: 4, endLine: 4 }, riskCategory: 'high', evidenceIds: [] }];
      }),
    });
    expect(gates.blocking.some((item) => item.code === 'kb_evidence_unresolved')).toBe(true);
  });

  it('证据 quoteHash 篡改 → 发布期重解引用失败 blocking', () => {
    const entry = sourceEntry();
    const gates = gatesOf({
      draft: happyDraft((draft) => {
        draft.evidence = [evidenceOf(entry, { quoteHash: 'sha256:tampered' })];
      }),
    });
    expect(gates.blocking.some((item) => item.code === 'kb_evidence_unresolved' && item.message.includes('quoteHash 不匹配'))).toBe(true);
  });

  it('重要覆盖项无去向 → kb_coverage_invalid blocking；普通未处理走 warnings 通道', () => {
    const entry = sourceEntry();
    const blocked = gatesOf({
      draft: happyDraft((draft) => {
        draft.coverage = [coverageOf(entry, { disposition: 'unresolved', targetObjectIds: [] })];
      }),
    });
    expect(blocked.blocking.some((item) => item.code === 'kb_coverage_invalid')).toBe(true);
    const warned = gatesOf({
      draft: happyDraft((draft) => {
        draft.coverage = [coverageOf(entry, { disposition: 'unresolved', importance: 'normal', targetObjectIds: [] })];
      }),
    });
    expect(warned.warnings.some((item) => item.code === 'kb_coverage_invalid')).toBe(true);
    expect(warned.blocking.some((item) => item.code === 'kb_coverage_invalid')).toBe(false);
  });

  it('审查凭据缺失（无 candidate / 报告不存在）→ kb_review_credential_missing blocking', () => {
    const noCandidate = gatesOf({ candidate: null });
    expect(noCandidate.blocking.some((item) => item.code === 'kb_review_credential_missing')).toBe(true);
    const missingReport = gatesOf({ candidate: candidateOf(happyDraft(), ['kr_missing']) });
    expect(missingReport.blocking.some((item) => item.code === 'kb_review_credential_missing')).toBe(true);
  });

  it('对象 reviewStatus=rejected/stale → kb_review_stale blocking', () => {
    const gates = gatesOf({
      draft: happyDraft((draft) => {
        draft.objects[0]!.reviewStatus = 'rejected';
      }),
    });
    expect(gates.blocking.some((item) => item.code === 'kb_review_stale')).toBe(true);
  });

  it('diting F03：对象 reviewStatus=pending → kb_review_pending blocking（未齐则 pending，A 案 §7.4）', () => {
    const gates = gatesOf({
      draft: happyDraft((draft) => {
        draft.objects[0]!.reviewStatus = 'pending';
        draft.objects[0]!.reviewActorKind = undefined;
        draft.objects[0]!.reviewerId = undefined;
      }),
    });
    const pending = gates.blocking.filter((item) => item.code === 'kb_review_pending');
    expect(pending).toHaveLength(1);
    expect(pending[0]!.objectId).toBe('ko_objDamage');
  });

  it('diting F03：高风险 claim 无人工复核凭据 → kb_review_human_missing warning（缩范围：披露不阻断）', () => {
    const gates = gatesOf();
    // happy fixture 的 ko_objDamage 携带高风险 claim，且只有机器审凭据
    const warnings = gates.warnings.filter((item) => item.code === 'kb_review_human_missing');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.objectId).toBe('ko_objDamage');
    expect(gates.blocking).toEqual([]);
  });

  it('sidecar 哈希与将写盘字节不一致 → kb_sidecar_invalid blocking', () => {
    const gates = gatesOf({
      sidecars: {
        organization: { path: 'knowledge.json', hash: 'sha256:wrong', bytes: 'tampered' },
        evidence: { resourcesPath: 'evidence-resources.json', hash: 'sha256:wrong', bytes: 'tampered' },
        governance: { path: 'governance.json', hash: 'sha256:wrong', bytes: 'tampered' },
      },
    });
    expect(gates.blocking.filter((item) => item.code === 'kb_sidecar_invalid')).toHaveLength(3);
  });

  it('上一 release 对象未解释丢失 → kb_migration_invalid blocking', () => {
    const gates = gatesOf({ previousObjectIds: ['ko_vanished'] });
    expect(gates.blocking.some((item) => item.code === 'kb_migration_invalid' && item.message.includes('ko_vanished'))).toBe(true);
  });

  it('内部链接目标文档不存在 → kb_link_invalid blocking', () => {
    const gates = gatesOf({
      docs: fixtureDocs([
        { path: 'broken.md', content: header('kd_broken') + '# 断链\n参见 [不存在的文档](missing.md)。\n' },
      ]),
    });
    expect(gates.blocking.some((item) => item.code === 'kb_link_invalid' && item.message.includes('missing.md'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 发布布局与双读器（A 案 §6.2/§10.2；真实 publishRelease）
// ---------------------------------------------------------------------------

function makeService(): KbBuildService {
  const config = {
    standardKb: {
      outputRoot, retainReleases: 10, buildBatchSize: 10,
      promptTimeoutMinutes: 15, buildTimeoutMinutes: 180, autoBuildAfterSync: false,
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

function stageBuild(buildId: string, options: {
  docs?: CompilerDocInput[];
  draft?: KnowledgeDeclarationSet | null;
  validReportIds?: string[] | null;
} = {}): string {
  const stagingRoot = path.join(outputRoot, '.staging', buildId);
  fs.rmSync(stagingRoot, { recursive: true, force: true });
  fs.mkdirSync(path.join(stagingRoot, 'docs'), { recursive: true });
  const docs = options.docs ?? fixtureDocs();
  for (const doc of docs) {
    const target = path.join(stagingRoot, 'docs', doc.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, doc.content);
  }
  const draft = options.draft === undefined ? happyDraft() : options.draft;
  if (draft) fs.writeFileSync(path.join(stagingRoot, 'knowledge-draft.json'), JSON.stringify(draft, null, 2));
  fs.mkdirSync(path.join(stagingRoot, 'reviews'), { recursive: true });
  fs.writeFileSync(path.join(stagingRoot, 'reviews', 'kr_1.json'), JSON.stringify(reviewPool()[0], null, 2));
  const validReportIds = options.validReportIds === undefined ? ['kr_1'] : options.validReportIds;
  const candidate = candidateOf(draft ?? happyDraft(), validReportIds);
  if (candidate) {
    fs.writeFileSync(path.join(stagingRoot, 'candidate.json'), JSON.stringify({
      schemaVersion: 1, buildId, candidateHash: 'sha256:fixture', assembledAt: new Date().toISOString(), candidate,
    }, null, 2));
  }
  fs.writeFileSync(path.join(stagingRoot, 'read-receipts.jsonl'), `${JSON.stringify({
    readReceiptId: 'krr_1', buildId, unitId: null, toolCallId: 'tc_1',
    sourceSnapshotHash: sourceEntry().contentHash, resourceId: 'tokSrc',
    selector: { kind: 'read_range', lineStart: 1, lineEnd: 3 }, returnedHash: 'sha256:x', truncated: false,
  })}\n`);
  return stagingRoot;
}

function publishArgs(buildId: string, releaseId: string, stagingRoot: string, baseReleaseId: string | null, snap: RawSourceSnapshot) {
  return {
    buildId, releaseId, mode: 'full' as const, baseReleaseId, model: null,
    snapshot: snap, stagingRoot, outputRoot, docMeta: new Map<string, { title: string; summary: string; tags: string[]; sources: string[] }>(),
    knowledgeBaseRoot: kbRoot, sourceContents: captureSourceContents(snap, kbRoot),
  };
}

describe('发布布局：v1 基线与 v2 sidecar', () => {
  it('无声明构建 → manifest v1、无 knowledge.json（与现状一致）', async () => {
    const service = makeService();
    const snap = snapshot();
    const staging = stageBuild('b_kp_v1', {
      docs: [fixtureDocs()[0]!],
      draft: null,
    });
    const manifest = await service.publishRelease(publishArgs('b_kp_v1', 'r_kp1', staging, null, snap));
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.organization).toBeUndefined();
    expect(fs.existsSync(path.join(outputRoot, 'releases', 'r_kp1', 'knowledge.json'))).toBe(false);
    // v1 兼容：resolveRelease 可读；知识索引 null（未组织化）
    const release = resolveRelease(outputRoot, 'r_kp1');
    expect(release.manifest.schemaVersion).toBe(1);
    expect(new StandardKbStore(outputRoot).readKnowledgeIndex('r_kp1')).toBeNull();
  });

  it('知识声明构建 → v2 发布：sidecar 齐全、manifest hash 一致、CURRENT 切换、staging 保留', async () => {
    const service = makeService();
    const snap = snapshot();
    const staging = stageBuild('b_kp_v2');
    const manifest = await service.publishRelease(publishArgs('b_kp_v2', 'r_kp2', staging, 'r_kp1', snap));
    expect(manifest.schemaVersion).toBe(2);
    expect(manifest.organization?.path).toBe('knowledge.json');
    // syntax.md 无对象 → mixed（A 案 §10.2）
    expect(manifest.organization?.coverageMode).toBe('mixed');
    const releaseDir = path.join(outputRoot, 'releases', 'r_kp2');
    const shaOf = (file: string): string =>
      `sha256:${crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`;
    expect(shaOf(path.join(releaseDir, 'knowledge.json'))).toBe(manifest.organization!.hash);
    expect(shaOf(path.join(releaseDir, 'evidence-resources.json'))).toBe(manifest.evidence!.hash);
    expect(shaOf(path.join(releaseDir, 'governance.json'))).toBe(manifest.governance!.hash);
    // 发布正文 = 编译产物（锚点注入、占位符展开）；staging 草稿保留供恢复
    const damage = fs.readFileSync(path.join(releaseDir, 'docs', 'damage.md'), 'utf8');
    expect(damage).toContain('<a id="ko_objDamage"></a>');
    const overview = fs.readFileSync(path.join(releaseDir, 'docs', 'combat', 'overview.md'), 'utf8');
    expect(overview).toContain('普攻伤害 = 攻防修正 × 基础攻击力');
    expect(overview).not.toContain('{{kb-include:');
    expect(overview).toContain('[公式定义](../damage.md#ko_objDamage)');
    expect(fs.existsSync(path.join(staging, 'docs', 'combat', 'overview.md'))).toBe(true);
    // evidence-resources：正文区段 + 资源 hash 与 source-contents 对得上（A 案 §5.4）
    const evidenceIndex = JSON.parse(fs.readFileSync(path.join(releaseDir, 'evidence-resources.json'), 'utf8')) as {
      resources: Array<{ resourceId: string; resourceHash: string; byteOffset: number; byteLength: number }>;
    };
    const entry = evidenceIndex.resources.find((item) => item.resourceId === 'tokSrc')!;
    expect(entry.resourceHash).toBe(contentResourceHash(SRC_CONTENT));
    const sourceContents = JSON.parse(fs.readFileSync(path.join(releaseDir, 'source-contents.json'), 'utf8')) as Record<string, string>;
    expect(Buffer.from(sourceContents['tokSrc']!.slice(0, entry.byteOffset) + sourceContents['tokSrc']!.slice(entry.byteOffset + entry.byteLength), 'utf8').length).toBe(Buffer.byteLength(sourceContents['tokSrc']!, 'utf8') - entry.byteLength);
    // governance 骨架：审查凭据集合引用（决定服务后续迭代）
    const governance = JSON.parse(fs.readFileSync(path.join(releaseDir, 'governance.json'), 'utf8')) as { reviewCredentials: { validReportIds: string[] }; decisions: [] };
    expect(governance.reviewCredentials.validReportIds).toEqual(['kr_1']);
    expect(governance.decisions).toEqual([]);
    // CURRENT 切换 + 知识索引可读（对象/关系/呈现查询入口）
    const store = new StandardKbStore(outputRoot);
    expect(store.readCurrent()!.releaseId).toBe('r_kp2');
    const index = store.readKnowledgeIndex()!;
    expect(index.objectsById.size).toBe(3);
    expect(index.relationsFrom.get('ko_objOverview')!.some((r) => r.type === 'restates')).toBe(true);
    expect(index.objectsByDoc.get('damage.md')!.map((o) => o.objectId)).toContain('ko_objDamage');
  });

  it('门禁 blocking → 发布失败保留 staging、CURRENT 不动、半成品 release 清理', async () => {
    const service = makeService();
    const snap = snapshot();
    const dup = happyDraft((draft) => {
      draft.objects.push(objectOf('ko_objDup', 'kd_damage', 'damage.md', { startLine: 1, endLine: 1 }, '# 重复', {
        familyKey: 'fam:ko_objDamage',
      }));
    });
    const staging = stageBuild('b_kp_dup', { draft: dup });
    await expect(service.publishRelease(publishArgs('b_kp_dup', 'r_kp3', staging, 'r_kp2', snap)))
      .rejects.toMatchObject({ code: 'kb_publish_blocked' });
    // CURRENT 仍指向 v2；staging 草稿保留；无半成品 release；report 落盘
    expect(new StandardKbStore(outputRoot).readCurrent()!.releaseId).toBe('r_kp2');
    expect(fs.existsSync(path.join(staging, 'knowledge-draft.json'))).toBe(true);
    expect(fs.existsSync(path.join(outputRoot, 'releases', 'r_kp3'))).toBe(false);
    const report = JSON.parse(fs.readFileSync(path.join(outputRoot, '.builds', 'b_kp_dup', 'report.json'), 'utf8')) as { issues: Array<{ code: string }> };
    expect(report.issues.some((issue) => issue.code === 'kb_object_duplicate')).toBe(true);
  });

  it('审查凭据缺失（无 candidate.json）→ 知识化发布阻断', async () => {
    const service = makeService();
    const snap = snapshot();
    const staging = stageBuild('b_kp_nocand', { validReportIds: null });
    await expect(service.publishRelease(publishArgs('b_kp_nocand', 'r_kp4', staging, 'r_kp2', snap)))
      .rejects.toMatchObject({ code: 'kb_publish_blocked' });
    expect(new StandardKbStore(outputRoot).readCurrent()!.releaseId).toBe('r_kp2');
  });
});

describe('双读器：v1/v2 并存（A 案 §10.2）', () => {
  it('v2 正文读取与 v1 等价：resolveRelease + 内容哈希 + 索引完整性', async () => {
    const store = new StandardKbStore(outputRoot);
    const release = resolveRelease(outputRoot, 'r_kp2');
    expect(release.manifest.schemaVersion).toBe(2);
    expect(release.organization?.hash).toBe(release.manifest.organization?.hash);
    // 正文读取走与 v1 相同路径（manifest docs + readReleaseDoc）
    const damageDoc = release.manifest.docs.find((doc) => doc.path === 'damage.md')!;
    const loaded = store.readReleaseDoc('r_kp2', damageDoc);
    expect(loaded.markdown).toContain('<a id="ko_objDamage"></a>');
    // 索引构建公式与 v1 相同：manifest contentHash 与发布文件一致（完整性验证全过）
    const index = await buildKbIndex(release.releaseDir, release.manifest);
    expect(index.integrity.mismatched).toEqual([]);
    expect(index.integrity.missing).toEqual([]);
    expect(index.integrity.verified).toBe(release.manifest.docs.length);
  });

  it('knowledge.json 损坏 → 组织查询报错不降级；正文读取不受影响', () => {
    const knowledgePath = path.join(outputRoot, 'releases', 'r_kp2', 'knowledge.json');
    const backup = fs.readFileSync(knowledgePath, 'utf8');
    try {
      fs.writeFileSync(knowledgePath, '{corrupted');
      const store = new StandardKbStore(outputRoot);
      expect(() => store.readKnowledgeIndex('r_kp2')).toThrow(/knowledge\.json|哈希/);
      // 正文与 manifest 读取不受 sidecar 损坏影响（组织查询失败≠全文降级）
      const release = resolveRelease(outputRoot, 'r_kp2');
      expect(release.manifest.docs.length).toBeGreaterThan(0);
      const damageDoc = release.manifest.docs.find((doc) => doc.path === 'damage.md')!;
      expect(store.readReleaseDoc('r_kp2', damageDoc).markdown).toContain('伤害规则');
    } finally {
      fs.writeFileSync(knowledgePath, backup);
    }
    // 恢复后组织查询正常
    expect(new StandardKbStore(outputRoot).readKnowledgeIndex('r_kp2')!.objectsById.size).toBe(3);
  });
});
